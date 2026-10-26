// Talks to the daemon: one `GET /sessions` for the snapshot and one WebSocket for events.
// The socket opens first so no event is missed while the snapshot loads.
import {
    EVENT_TYPES,
    EVENTS_WS_URL,
    type SessionsResponse,
    type SpinnerEvent,
    type SpinnerEventType,
} from "@spinner/protocol";

export const RECONNECT_DELAY_MS_MIN = 500;
export const RECONNECT_DELAY_MS_MAX = 8000;

const KNOWN_TYPES: ReadonlySet<string> = new Set<SpinnerEventType>(EVENT_TYPES);

/**
 * Checks the envelope only (`type`, `ts`, `session`). The daemon owns the per-type fields, so
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
        typeof session === "string"
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
        socket = new WebSocket(EVENTS_WS_URL);
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
