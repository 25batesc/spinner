// The extension's half of the tty channel (MISSION.md s009, Contracts "tty contract"). Under
// `SPINNER_HARNESS=tty` pi runs interactively in a pty the daemon owns, and this module is the
// daemon's only way in: at `session_start` it posts `hello` (pid, slash commands) and opens
// the `commands` long-poll; each command becomes `pi.sendUserMessage` (a prompt, or a steer
// through `deliverAs`) or `ctx.abort()`, and the next poll carries the ack. The lifecycle
// events the daemon folds into `busy` and `agent.settled` are posted to `events` as pi hands
// them to the extension. `session_shutdown` stops the loop; a reload starts a fresh one.
import { readFileSync } from "node:fs";
import type { AgentExtensionCommand } from "@spinner/protocol";
import { split_model } from "@spinner/protocol";
import { agent_route_base, type SpinnerEnv } from "./env.js";
import type {
    ImageContent,
    ToolTextContent,
    ExtensionAPI,
    ExtensionContext,
    LifecycleEvent,
    LifecycleEventName,
    PiModel,
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

/**
 * The message events, which the chat needs live (docs/designs/talk-change-ship.md, 5.2). pi
 * hands `message_update` a growing snapshot of the whole message per token; the channel
 * posts the text and thinking deltas only, joined while they wait, and the whole message
 * once, at `message_end`. Image bytes are left out: the chat shows a count, not the image.
 */
export const MESSAGE_EVENTS: readonly LifecycleEventName[] = [
    "message_start",
    "message_update",
    "message_end",
];

/** The message without its image bytes; any other content stays as pi gave it. */
function without_image_data(message: unknown): unknown {
    if (typeof message !== "object" || message === null) {
        return message;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
        return message;
    }
    const slim = content.map((part: unknown) => {
        const image = typeof part === "object" && part !== null &&
            (part as { type?: unknown }).type === "image";
        return image ? { ...(part as object), data: "" } : part;
    });
    return { ...(message as object), content: slim };
}

/**
 * The event as the channel posts it, or null for one it drops. A `message_update` keeps its
 * delta alone, and only a text or a thinking delta: the tool call's arguments arrive whole
 * with `message_end` and `tool_execution_start`.
 */
export function wire_message_event(event: LifecycleEvent): LifecycleEvent | null {
    if (event.type === "message_update") {
        const delta = event["assistantMessageEvent"] as { type?: unknown } | undefined;
        if (delta?.type !== "text_delta" && delta?.type !== "thinking_delta") {
            return null;
        }
        return { type: "message_update", assistantMessageEvent: delta };
    }
    return { type: event.type, message: without_image_data(event["message"]) };
}

/**
 * Appends `event` to the waiting events. A delta that follows a delta of the same kind and
 * content index joins it, so a long answer waits as one event per flush, not one per token.
 */
export function push_pending(pending: LifecycleEvent[], event: LifecycleEvent): void {
    type Delta = { type: string; contentIndex: number; delta: string };
    const last = pending[pending.length - 1];
    if (event.type === "message_update" && last?.type === "message_update") {
        const next = event["assistantMessageEvent"] as Delta;
        const held = last["assistantMessageEvent"] as Delta;
        if (held.type === next.type && held.contentIndex === next.contentIndex) {
            last["assistantMessageEvent"] = { ...held, delta: held.delta + next.delta };
            return;
        }
    }
    pending.push(event);
}

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

    const enqueue = (event: LifecycleEvent): void => {
        push_pending(pending, event);
        if (pending.length > EVENTS_PENDING_MAX) {
            pending = pending.slice(-EVENTS_PENDING_MAX);
        }
        void flush_events();
    };
    for (const name of LIFECYCLE_EVENTS) {
        pi.on(name, (event) => enqueue(event));
    }
    for (const name of MESSAGE_EVENTS) {
        // The handler returns nothing: a returned message would replace pi's own.
        pi.on(name, (event) => {
            const wire = wire_message_event(event);
            if (wire !== null) {
                enqueue(wire);
            }
        });
    }

    // The daemon records pi's model and thinking level in `session.yaml`: as they are once
    // `hello` is in (a fresh or a resumed pi), and on every change, from Spinner or from the
    // operator in pi's own terminal.
    pi.on("model_select", (event) => {
        enqueue({ type: "model_select", model: model_name(event.model) });
    });
    pi.on("thinking_level_select", (event) => {
        enqueue({ type: "thinking_level_select", level: event.level });
    });

    pi.on("session_start", async (_event, ctx) => {
        loop?.abort();
        const controller = new AbortController();
        loop = controller;
        await post("/hello", { pid, commands: pi.getCommands() });
        if (ctx.model !== undefined) {
            enqueue({ type: "model_select", model: model_name(ctx.model) });
        }
        enqueue({ type: "thinking_level_select", level: pi.getThinkingLevel() });
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
            const disposition = await act(pi, ctx, command);
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
 * the RPC harness's, so the daemon's callers see the same answers on both paths. A
 * `set_model` or a `set_thinking` answers `ok`, or pi's error as the daemon shows it.
 */
export async function act(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    command: AgentExtensionCommand,
): Promise<string> {
    if (command.type === "set_model") {
        return set_model(pi, ctx, command.model ?? "");
    }
    if (command.type === "set_thinking") {
        if (command.level === undefined) {
            return "set_thinking needs a level";
        }
        pi.setThinkingLevel(command.level);
        return "ok";
    }
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

/** `provider/id` through pi's model registry: `ok`, or why pi did not take it. */
async function set_model(pi: ExtensionAPI, ctx: ExtensionContext, model: string): Promise<string> {
    const parts = split_model(model);
    if (parts === null) {
        return `model ${model} is not provider/id`;
    }
    const found = ctx.modelRegistry.find(parts.provider, parts.id);
    if (found === undefined) {
        return `pi does not know the model ${model}`;
    }
    try {
        const taken = await pi.setModel(found);
        return taken ? "ok" : `pi has no API key for ${parts.provider}`;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

function model_name(model: PiModel): string {
    return `${model.provider}/${model.id}`;
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
