#!/usr/bin/env node
// A stand-in for `pi --mode rpc` in tests: the same JSONL framing and record shapes as pi's
// docs/rpc.md and docs/json.md, with no model behind it. A `prompt` records the user's
// message and answers with a fixed text run. During a run a `prompt` is refused unless it
// carries `streamingBehavior`, as pi does: `steer` records the text, `followUp` runs it once
// the run settled. `steer` and `abort` are acknowledged; `get_state` and
// `get_available_models` return canned data. A `prompt` with `images` echoes
// `[<n> image(s) of <m> bytes]` after its
// text, so a test can see that the images arrived. `set_model` takes the two models
// `get_available_models` lists and refuses any other with pi's error; `set_thinking_level`
// takes any level. A `prompt` of `ask confirm`, `ask select`, `ask input` or `ask two` writes
// an `extension_ui_request` (two confirms for `two`) and keeps the run open until each
// `extension_ui_response` arrived; its answer text echoes the responses. `ask widget` writes
// a `setWidget` and a `notify` and settles at once. `compact` is refused before the first
// run ("Nothing to compact"); after one it takes 300 ms between `compaction_start` and
// `compaction_end`, and a `prompt` in that time is refused as pi refuses it. It records its
// argv in FAKE_PI_ARGS_FILE
// when that is set, so a test can check the flags the daemon passed. Exits when stdin closes.
// Plain TypeScript that Node 24 runs directly, like the UI's fixture server.
import { writeFileSync } from "node:fs";

interface Command {
    id?: string;
    type: string;
    /** Of an `extension_ui_response`. */
    value?: string;
    confirmed?: boolean;
    cancelled?: boolean;
    message?: string;
    streamingBehavior?: "steer" | "followUp";
    provider?: string;
    modelId?: string;
    images?: { type: string; data: string; mimeType: string }[];
}

const args_file = process.env["FAKE_PI_ARGS_FILE"];
if (args_file !== undefined && args_file !== "") {
    const spinner_env = Object.fromEntries(
        Object.entries(process.env).filter(
            ([key]) => key.startsWith("SPINNER_") || key.startsWith("PI_"),
        ),
    );
    writeFileSync(
        args_file,
        JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: spinner_env }),
    );
}

const out = (record: unknown): void => {
    process.stdout.write(`${JSON.stringify(record)}\n`);
};
const respond = (command: Command, data: unknown): void =>
    out({ id: command.id, type: "response", command: command.type, success: true, data });
const refuse = (command: Command, error: string): void =>
    out({ id: command.id, type: "response", command: command.type, success: false, error });

let running = false;
/** True between `compaction_start` and `compaction_end`. */
let compacting = false;
/** Runs finished; a compaction needs one, as pi needs something to summarise. */
let runs = 0;
/**
 * Steers received, and `(compact)` for each compact; a `prompt` of `steers?` echoes them, so a
 * test can see what arrived.
 */
const steers: string[] = [];

/** Dialogs this fake asked and has no answer to yet, with the text of the run they hold. */
const asked = new Map<string, string>();
const answers: string[] = [];

const DIALOGS: Record<string, Record<string, unknown>[]> = {
    confirm: [{ method: "confirm", title: "damage-control: rm", message: "Allow this once?" }],
    select: [{ method: "select", title: "Pick one", options: ["red", "green"] }],
    input: [{ method: "input", title: "Name it", placeholder: "a name" }],
    two: [
        { method: "confirm", title: "first", message: "one?" },
        { method: "confirm", title: "second", message: "two?" },
    ],
};

/** Starts a run that waits on the dialogs of `kind`; false when `kind` names none. */
function ask(kind: string, text: string): boolean {
    if (kind === "widget") {
        out({ type: "extension_ui_request", id: "w-1", method: "setWidget", widgetKey: "k" });
        out({ type: "extension_ui_request", id: "n-1", method: "notify", message: "blocked",
            notifyType: "warning" });
        return false;
    }
    const dialogs = DIALOGS[kind];
    if (dialogs === undefined) {
        return false;
    }
    running = true;
    out({ type: "agent_start" });
    said(text);
    dialogs.forEach((dialog, index) => {
        const id = `ui-${kind}-${index + 1}`;
        asked.set(id, text);
        out({ type: "extension_ui_request", id, ...dialog });
    });
    return true;
}

function answered(command: Command): void {
    const text = asked.get(command.id ?? "");
    if (text === undefined) {
        return;
    }
    asked.delete(command.id ?? "");
    const { id, value, confirmed, cancelled } = command;
    answers.push(JSON.stringify({ id, value, confirmed, cancelled }));
    if (asked.size === 0) {
        finish(`${text} -> ${answers.splice(0).join(" ")}`);
    }
}

function handle(command: Command): void {
    switch (command.type) {
        case "extension_ui_response":
            answered(command);
            return;
        case "get_state":
            respond(command, {
                sessionId: "fake-session",
                thinkingLevel: "off",
                isStreaming: running,
                isCompacting: false,
                steeringMode: "one-at-a-time",
                followUpMode: "one-at-a-time",
                autoCompactionEnabled: true,
                messageCount: 0,
                pendingMessageCount: 0,
            });
            return;
        case "get_available_models":
            respond(command, {
                models: [
                    { provider: "anthropic", id: "claude-x", contextWindow: 2000, reasoning: true },
                    { provider: "openai", id: "gpt-y", contextWindow: 1000, reasoning: false },
                ],
            });
            return;
        case "prompt":
            if (compacting) {
                refuse(
                    command,
                    "Cannot submit a prompt while compaction is in progress. " +
                        "Wait for compaction to finish and retry.",
                );
                return;
            }
            if (command.message === "fail") {
                refuse(command, "no");
                return;
            }
            if (command.message === "exit") {
                // A pi that dies mid-review (the swarm reads `failed` from the exit).
                respond(command, { disposition: "started" });
                setTimeout(() => process.exit(0), 50);
                return;
            }
            if (command.message?.startsWith("/") === true) {
                // An extension command runs at once and starts no run, as pi does.
                respond(command, { disposition: "handled" });
                return;
            }
            if (running) {
                queue(command);
                return;
            }
            respond(command, { disposition: "started" });
            if (command.message?.startsWith("ask ") === true) {
                if (ask(command.message.slice(4), command.message)) {
                    return;
                }
            }
            run(`${command.message ?? ""}${images_suffix(command)}`);
            return;
        case "steer":
            steers.push(command.message ?? "");
            respond(command, { disposition: "queued" });
            return;
        case "get_commands":
            respond(command, {
                commands: [
                    {
                        name: "spinner-reload",
                        description: "Reload context",
                        source: "extension",
                        sourceInfo: { path: "/fake/ext.ts" },
                    },
                ],
            });
            return;
        case "abort":
            respond(command, undefined);
            return;
        case "set_model": {
            const model = `${command.provider ?? ""}/${command.modelId ?? ""}`;
            if (model !== "anthropic/claude-x" && model !== "openai/gpt-y") {
                refuse(command, `Model not found: ${model}`);
                return;
            }
            respond(command, { provider: command.provider, id: command.modelId });
            return;
        }
        case "set_thinking_level":
            respond(command, undefined);
            return;
        case "compact": {
            if (runs === 0) {
                out({ type: "compaction_start", reason: "manual" });
                const errorMessage = "Compaction failed: Nothing to compact (session too small)";
                out({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false,
                    errorMessage });
                refuse(command, "Nothing to compact (session too small)");
                return;
            }
            steers.push("(compact)");
            compacting = true;
            out({ type: "compaction_start", reason: "manual" });
            const result = { summary: "compacted", firstKeptEntryId: "x", tokensBefore: 9000,
                estimatedTokensAfter: 1200 };
            setTimeout(() => {
                compacting = false;
                out({ type: "compaction_end", reason: "manual", result, aborted: false,
                    willRetry: false });
                respond(command, result);
            }, 300);
            return;
        }
        default:
            refuse(command, "unknown");
    }
}

/** Texts that wait for the run to settle (`streamingBehavior: "followUp"`). */
const follow_ups: string[] = [];

/** A `prompt` during a run: queued by its `streamingBehavior`, refused without one. */
function queue(command: Command): void {
    if (command.streamingBehavior === undefined) {
        refuse(command, "Agent is already processing. Specify streamingBehavior.");
        return;
    }
    const text = `${command.message ?? ""}${images_suffix(command)}`;
    (command.streamingBehavior === "steer" ? steers : follow_ups).push(text);
    respond(command, { disposition: "queued" });
}

/** ` [n image(s) of m bytes]` when the command carries images, else nothing. */
function images_suffix(command: Command): string {
    const images = command.images ?? [];
    if (images.length === 0) {
        return "";
    }
    const bytes = images.reduce((sum, image) => sum + Buffer.from(image.data, "base64").length, 0);
    return ` [${images.length} image(s) of ${bytes} bytes]`;
}

/**
 * A prompt that starts with `slow` keeps the run open for 400 ms before it settles, so a
 * test can steer a busy agent; every other prompt settles at once.
 */
function run(text: string): void {
    running = true;
    out({ type: "agent_start" });
    said(text);
    if (text.startsWith("slow")) {
        setTimeout(() => finish(text), 400);
        return;
    }
    finish(text);
}

/** The user's message as pi records it when a run takes it: a start and an end. */
function said(text: string): void {
    const message = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
    out({ type: "message_start", message });
    out({ type: "message_end", message });
}

function finish(text: string): void {
    const echoed = text === "steers?" ? `steers: ${JSON.stringify(steers)}` : text;
    const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost };
    const message = {
        role: "assistant",
        content: [{ type: "text", text: `echo: ${echoed}` }],
        api: "fake",
        provider: "fake",
        model: "fake",
        usage,
        stopReason: "stop",
        timestamp: Date.now(),
    };
    out({ type: "turn_start" });
    out({ type: "message_start", message });
    const delta = { type: "text_delta", contentIndex: 0, delta: `echo: ${echoed}` };
    out({ type: "message_update", usage, assistantMessageEvent: delta });
    out({ type: "message_end", message });
    out({ type: "turn_end", message, toolResults: [] });
    out({ type: "agent_end", messages: [message], willRetry: false });
    out({ type: "agent_settled", aborted: false });
    running = false;
    runs += 1;
    const next = follow_ups.shift();
    if (next !== undefined) {
        run(next);
    }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim().length > 0) {
            handle(JSON.parse(line) as Command);
        }
        newline = buffer.indexOf("\n");
    }
});
process.stdin.on("end", () => process.exit(0));
