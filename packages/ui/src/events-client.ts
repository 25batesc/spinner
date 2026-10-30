// Talks to the daemon: one `GET /sessions` for the snapshot and one WebSocket for events.
// The socket opens first so no event is missed while the snapshot loads.
import {
    EVENT_TYPES,
    EVENTS_PATH,
    type AgentEventsResponse,
    type Job,
    type JobResponse,
    type ModelsResponse,
    type ModelView,
    type PiEvent,
    type ProjectsResponse,
    type ProjectView,
    type SessionsResponse,
    type Settings,
    type SettingsResponse,
    type SpinnerEvent,
    type ThemesResponse,
    type SpinnerEventType,
    type UsageResponse,
} from "@spinner/protocol";

export const RECONNECT_DELAY_MS_MIN = 500;
export const RECONNECT_DELAY_MS_MAX = 8000;

const KNOWN_TYPES: ReadonlySet<string> = new Set<SpinnerEventType>(EVENT_TYPES);

/**
 * Checks the envelope only (`type`, `ts`, `session`; `session` is null for some job events).
 * The daemon owns the per-type fields, so
 * the UI trusts them; a stricter check here would fork the protocol.
 */
function hasEnvelope(value: unknown): value is SpinnerEvent {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const { type, ts, session } = value as Record<string, unknown>;
    return (
        typeof type === "string" &&
        KNOWN_TYPES.has(type) &&
        typeof ts === "string" &&
        (typeof session === "string" ||
            (session === null &&
                (type.startsWith("job.") || type === "usage" || type === "settings")))
    );
}

export function parseEvent(raw: string): SpinnerEvent | null {
    try {
        const value: unknown = JSON.parse(raw);
        return hasEnvelope(value) ? value : null;
    } catch {
        return null;
    }
}

export async function fetchSessions(signal: AbortSignal): Promise<SessionsResponse> {
    const response = await fetch("/sessions", { signal });
    if (!response.ok) {
        throw new Error(`GET /sessions failed with status ${response.status}`);
    }
    return (await response.json()) as SessionsResponse;
}

/** The operator's settings; null from an older daemon without the route. */
export async function fetchSettings(signal: AbortSignal): Promise<Settings | null> {
    const response = await fetch("/settings", { signal });
    if (!response.ok) {
        return null;
    }
    return ((await response.json()) as SettingsResponse).settings;
}

/** Where the settings file lives, for the hint in the settings view. */
export async function fetchSettingsPath(signal: AbortSignal): Promise<string | null> {
    const response = await fetch("/settings", { signal });
    if (!response.ok) {
        return null;
    }
    return ((await response.json()) as SettingsResponse).path;
}

/** Replaces the settings; the change comes back as a `settings` event to every window. */
export async function putSettings(settings: Settings): Promise<SettingsResponse> {
    const response = await fetch("/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
    });
    if (!response.ok) {
        throw new Error(`PUT /settings failed (${response.status}): ${await response.text()}`);
    }
    return (await response.json()) as SettingsResponse;
}

/** The themes the daemon lists, with the custom files that did not validate. */
export async function fetchThemes(signal: AbortSignal): Promise<ThemesResponse> {
    const response = await fetch("/themes", { signal });
    if (!response.ok) {
        throw new Error(`GET /themes failed with status ${response.status}`);
    }
    return (await response.json()) as ThemesResponse;
}

/** The last usage sample; null from an older daemon without the route. */
export async function fetchUsage(signal: AbortSignal): Promise<UsageResponse | null> {
    const response = await fetch("/usage", { signal });
    if (!response.ok) {
        return null;
    }
    return (await response.json()) as UsageResponse;
}

export async function fetchJobs(signal: AbortSignal): Promise<Job[]> {
    const response = await fetch("/jobs", { signal });
    if (!response.ok) {
        throw new Error(`GET /jobs failed with status ${response.status}`);
    }
    return ((await response.json()) as { jobs: Job[] }).jobs;
}

export async function fetchProjects(signal: AbortSignal): Promise<ProjectView[]> {
    const response = await fetch("/projects", { signal });
    if (!response.ok) {
        throw new Error(`GET /projects failed with status ${response.status}`);
    }
    return ((await response.json()) as ProjectsResponse).projects;
}

/**
 * Runs an action: POSTs the route and returns the job the daemon accepted. The UI never changes
 * a session itself; the change arrives as `session.updated` and `job.*` events.
 */
export async function postAction(path: string, body?: unknown): Promise<Job> {
    const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
    });
    if (response.status !== 202) {
        const text = await response.text();
        throw new Error(`POST ${path} failed (${response.status}): ${text}`);
    }
    return ((await response.json()) as JobResponse).job;
}

export async function fetchModels(signal: AbortSignal): Promise<ModelView[]> {
    const response = await fetch("/models", { signal });
    if (!response.ok) {
        throw new Error(`GET /models failed with status ${response.status}`);
    }
    return ((await response.json()) as ModelsResponse).models;
}

/** Agent routes answer at once; the effect arrives as `agent.*` events, not in this result. */
export async function postAgent(path: string, body: unknown): Promise<void> {
    const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`POST ${path} failed (${response.status}): ${await response.text()}`);
    }
}

/** The agent's past turns; null when the daemon has none (an agent it never hosted). */
export async function fetchAgentHistory(
    path: string,
    signal: AbortSignal,
): Promise<PiEvent[] | null> {
    const response = await fetch(`${path}/events`, { signal });
    if (!response.ok) {
        return null;
    }
    return ((await response.json()) as AgentEventsResponse).events;
}

export interface EventsHandlers {
    onEvent: (event: SpinnerEvent) => void;
    onOpen: () => void;
    onClose: () => void;
}

/** Keeps a socket open, reconnecting with a capped exponential delay. Returns a stop function. */
export function connectEvents(handlers: EventsHandlers): () => void {
    let stopped = false;
    let delay = RECONNECT_DELAY_MS_MIN;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const open = () => {
        socket = new WebSocket(`ws://${location.host}${EVENTS_PATH}`);
        socket.onopen = () => {
            delay = RECONNECT_DELAY_MS_MIN;
            handlers.onOpen();
        };
        socket.onmessage = (message) => {
            const event = typeof message.data === "string" ? parseEvent(message.data) : null;
            if (event === null) {
                console.warn("Ignored a message that is not a SpinnerEvent.");
                return;
            }
            handlers.onEvent(event);
        };
        socket.onclose = () => {
            handlers.onClose();
            if (!stopped) {
                timer = setTimeout(open, delay);
                delay = Math.min(delay * 2, RECONNECT_DELAY_MS_MAX);
            }
        };
    };
    open();

    return () => {
        stopped = true;
        clearTimeout(timer);
        socket?.close();
    };
}
