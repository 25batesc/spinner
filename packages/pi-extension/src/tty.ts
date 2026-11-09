// The extension's half of the tty channel (MISSION.md s009, Contracts "tty contract"). Under
// `SPINNER_HARNESS=tty` pi runs interactively in a pty the daemon owns, and this module is the
// daemon's only way in: at `session_start` it posts `hello` (pid, slash commands) and opens
// the `commands` long-poll; each command becomes `pi.sendUserMessage` (a prompt, or a steer
// through `deliverAs`) or `ctx.abort()`, and the next poll carries the ack. The lifecycle
// events the daemon folds into `busy` and `agent.settled` are posted to `events` as pi hands
// them to the extension. `session_shutdown` stops the loop; a reload starts a fresh one.
import { readFileSync } from "node:fs";
import type { AgentExtensionCommand } from "@spinner/protocol";
import { agent_route_base, type SpinnerEnv } from "./env.js";
import type {
    ImageContent,
    ToolTextContent,
    ExtensionAPI,
    ExtensionContext,
    LifecycleEvent,
    LifecycleEventName,
    SlashCommandInfo,
} from "./pi-api.js";
import type { Fetch } from "./tools.js";

/** The daemon holds a poll 30 s; the client waits a little longer before it gives up. */
const POLL_TIMEOUT_MS = 35_000;

/** Wait after a failed request (daemon down, 404 while the daemon restarts) before the next. */
export const RETRY_DELAY_MS = 1_000;

/** Time one `hello` or `events` post gets. */
const POST_TIMEOUT_MS = 10_000;

/** Events waiting to be posted. Beyond this the oldest are dropped; the daemon's fold needs
 *  only the latest `agent_start` / `agent_settled` pair to be right. */
const EVENTS_PENDING_MAX = 500;

export const LIFECYCLE_EVENTS: readonly LifecycleEventName[] = [
    "agent_start",
    "agent_end",
    "agent_settled",
    "turn_end",
    "tool_execution_start",
    "tool_execution_end",
];

export interface TtyChannelOptions {
    env: SpinnerEnv;
    fetch: Fetch;
    /** For tests: the delay after a failed request. */
    retry_delay_ms?: number;
    /** For tests: the process id to report. */
    pid?: number;
}

export interface TtyChannel {
    /** True while a long-poll loop runs. */
    readonly running: boolean;
    /** Resolves after the events posted so far are flushed, for tests. */
    flush(): Promise<void>;
}

/** Registers the hooks; returns the channel so a test can wait on it. */
export function register_tty(pi: ExtensionAPI, options: TtyChannelOptions): TtyChannel {
    const env = options.env;
    const base = agent_route_base(env);
    const fetch_ = options.fetch;
    const retry_delay_ms = options.retry_delay_ms ?? RETRY_DELAY_MS;
    const pid = options.pid ?? process.pid;
    let loop: AbortController | null = null;
    let pending: LifecycleEvent[] = [];
    let flushing: Promise<void> = Promise.resolve();

    const post = async (path: string, body: unknown): Promise<boolean> => {
        try {
            const response = await fetch_(`${base}${path}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(POST_TIMEOUT_MS),
            });
            return response.ok;
        } catch {
            return false;
        }
    };

    const flush_events = (): Promise<void> => {
        flushing = flushing.then(async () => {
            if (pending.length === 0) {
                return;
            }
            const batch = pending;
            pending = [];
            const posted = await post("/events", { events: batch });
            if (!posted) {
                // The daemon is away (a restart); the batch waits with whatever comes next.
                pending = [...batch, ...pending].slice(-EVENTS_PENDING_MAX);
            }
        });
        return flushing;
    };

    for (const name of LIFECYCLE_EVENTS) {
        pi.on(name, (event) => {
            pending.push(event);
            if (pending.length > EVENTS_PENDING_MAX) {
                pending = pending.slice(-EVENTS_PENDING_MAX);
            }
            void flush_events();
        });
    }

    pi.on("session_start", async (_event, ctx) => {
        loop?.abort();
        const controller = new AbortController();
        loop = controller;
        await post("/hello", { pid, commands: pi.getCommands() });
        void poll_loop(controller.signal, ctx);
    });

    pi.on("session_shutdown", () => {
        loop?.abort();
        loop = null;
    });

    /**
     * The long-poll loop. It runs as long as the session lives: the daemon holds each request
     * up to 30 s, so one iteration is one command or one idle period. `signal` ends it.
     */
    async function poll_loop(signal: AbortSignal, ctx: ExtensionContext): Promise<void> {
        let ack = "";
        while (!signal.aborted) {
            let response: Response;
            try {
                response = await fetch_(`${base}/commands${ack}`, {
                    signal: AbortSignal.any([signal, AbortSignal.timeout(POLL_TIMEOUT_MS)]),
                });
            } catch {
                if (signal.aborted) {
                    return;
                }
                await sleep(retry_delay_ms);
                continue;
            }
            ack = "";
            if (response.status === 204) {
                continue;
            }
            if (!response.ok) {
                // 404 while the daemon restarts and has not adopted this pi yet; 5xx likewise.
                await sleep(retry_delay_ms);
                continue;
            }
            let command: AgentExtensionCommand;
            try {
                const body = (await response.json()) as { command: AgentExtensionCommand };
                command = body.command;
            } catch {
                continue;
            }
            const disposition = act(pi, ctx, command);
            const id = encodeURIComponent(command.id);
            ack = `?ack=${id}&disposition=${encodeURIComponent(disposition)}`;
        }
    }

    return {
        get running() {
            return loop !== null && !loop.signal.aborted;
        },
        flush: () => flush_events(),
    };
}

/** The `customType` of a daemon notice in pi's transcript, for example a failed stack job. */
export const NOTICE_TYPE = "spinner_notice";

/**
 * Runs one command and names what pi did with it. A prompt starts a turn when pi is idle and
 * queues as a follow-up when it is busy; a steer queues ahead of the next model call (and
 * starts a turn when idle); an abort stops the run. A notify is the daemon's own message (a
 * failed stack job): a custom message that starts a turn when idle and steers when busy, so
 * the transcript shows it came from Spinner, not from a person. The disposition words are
 * the RPC harness's, so the daemon's callers see the same answers on both paths.
 */
export function act(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    command: AgentExtensionCommand,
): string {
    const idle = ctx.isIdle();
    if (command.type === "abort") {
        ctx.abort();
        return "aborted";
    }
    if (command.type === "compact") {
        // pi's own `/compact` (dogfood #45); it runs in the background and does not wait.
        ctx.compact();
        return "started";
    }
    const raw = command.text ?? "";
    if (raw.length === 0) {
        return "ignored";
    }
    // A notify is the daemon's own text; a prompt or a steer may start with `/skill:`.
    const text = command.type === "notify" ? raw : expand_skill(raw, pi.getCommands());
    if (command.type === "steer") {
        pi.sendUserMessage(with_images(text, command.images), { deliverAs: "steer" });
        return idle ? "started" : "queued";
    }
    if (command.type === "notify") {
        const message = { customType: NOTICE_TYPE, content: text, display: true };
        pi.sendMessage(message, idle ? { triggerTurn: true } : { deliverAs: "steer" });
        return idle ? "started" : "queued";
    }
    const content = with_images(text, command.images);
    if (idle) {
        pi.sendUserMessage(content);
        return "started";
    }
    pi.sendUserMessage(content, { deliverAs: "followUp" });
    return "queued";
}

/**
 * The text alone, or the text and the PNGs at `paths` as images (a preview comment's
 * screenshot, s054). pi turns a path in text into an image only when it is pasted into its
 * editor, so the files are read here. A file that cannot be read is left out: the text names
 * its path, and the agent can still `read` it.
 */
export function with_images(
    text: string,
    paths: readonly string[] | undefined,
): string | (ToolTextContent | ImageContent)[] {
    if (paths === undefined || paths.length === 0) {
        return text;
    }
    const images: ImageContent[] = [];
    for (const path of paths) {
        try {
            const data = readFileSync(path, "base64");
            images.push({ type: "image", data, mimeType: "image/png" });
        } catch {
            continue;
        }
    }
    return images.length === 0 ? text : [{ type: "text", text }, ...images];
}

/**
 * `pi.sendUserMessage` does not expand a `/skill:` command (probe P3 of the EGM design,
 * docs/egm/HARNESS_EVIDENCE.md): the model would see the literal text. So a prompt or a steer
 * that starts with `/skill:<name>` becomes Spinner's instruction to read that skill's file,
 * as EGM advises for hosts without a skill tool (`docs/claude.md`). The path comes from pi's
 * own command list. Any other text, or a skill pi did not load, passes unchanged.
 */
export function expand_skill(text: string, commands: SlashCommandInfo[]): string {
    const match = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/.exec(text);
    if (match === null) {
        return text;
    }
    const name = match[1] ?? "";
    const command = commands.find(
        (entry) =>
            entry.source === "skill" && (entry.name === `skill:${name}` || entry.name === name),
    );
    const path = command?.sourceInfo?.path;
    if (path === undefined || path === "") {
        return text;
    }
    const rest = (match[2] ?? "").trim();
    const read = `Read the skill file at ${path} and follow it in this thread.`;
    return rest.length === 0 ? read : `${read} Arguments: ${rest}`;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
