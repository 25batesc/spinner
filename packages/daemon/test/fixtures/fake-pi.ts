#!/usr/bin/env node
// A stand-in for `pi --mode rpc` in tests: the same JSONL framing and record shapes as pi's
// docs/rpc.md and docs/json.md, with no model behind it. A `prompt` answers with a fixed
// text run; `steer` and `abort` are acknowledged; `get_state` and `get_available_models`
// return canned data. It records its argv in FAKE_PI_ARGS_FILE when that is set, so a test
// can check the flags the daemon passed. Exits when stdin closes. Plain TypeScript that Node 24
// runs directly, like the UI's fixture server.
import { writeFileSync } from "node:fs";

interface Command {
    id?: string;
    type: string;
    message?: string;
}

const args_file = process.env["FAKE_PI_ARGS_FILE"];
if (args_file !== undefined && args_file !== "") {
    const spinner_env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.startsWith("SPINNER_")),
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
/** Steers received; a `prompt` of `steers?` echoes them, so a test can see what arrived. */
const steers: string[] = [];

function handle(command: Command): void {
    switch (command.type) {
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
            respond(command, { disposition: running ? "queued" : "started" });
            run(command.message ?? "");
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
        default:
            refuse(command, "unknown");
    }
}

/**
 * A prompt that starts with `slow` keeps the run open for 400 ms before it settles, so a
 * test can steer a busy agent; every other prompt settles at once.
 */
function run(text: string): void {
    running = true;
    out({ type: "agent_start" });
    if (text.startsWith("slow")) {
        setTimeout(() => finish(text), 400);
        return;
    }
    finish(text);
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
