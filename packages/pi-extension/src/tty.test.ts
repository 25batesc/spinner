// Goal: under SPINNER_HARNESS=tty the extension posts hello at session_start, pulls commands
// off the long-poll and turns them into sendUserMessage / abort with the right disposition on
// the next poll, and posts the lifecycle events. Method: a fake pi that records calls and
// lets the test fire events, and a fake daemon (`node:http`) that hands out a scripted list
// of commands and records every request.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentExtensionCommand } from "@spinner/protocol";
import { register } from "./index.js";
import type { ExtensionAPI, ExtensionContext } from "./pi-api.js";
import { act, expand_skill } from "./tty.js";

interface FakePi extends ExtensionAPI {
    sent: Array<{ text: string; deliverAs: string | undefined }>;
    custom: Array<{ customType: string; content: string; options: unknown }>;
    handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
    fire(event: string, payload: unknown, ctx: ExtensionContext): Promise<void>;
}

function fake_pi(): FakePi {
    const pi = {
        sent: [],
        custom: [],
        handlers: new Map(),
        registerTool: () => undefined,
        registerCommand: () => undefined,
        sendUserMessage: (text: string, options?: { deliverAs?: string }) => {
            pi.sent.push({ text, deliverAs: options?.deliverAs });
        },
        sendMessage: (
            message: { customType: string; content: string; display: boolean },
            options?: unknown,
        ) => {
            pi.custom.push({ customType: message.customType, content: message.content, options });
        },
        getCommands: () => [{ name: "help", source: "extension" as const }],
        on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
            pi.handlers.set(event, [...(pi.handlers.get(event) ?? []), handler]);
            return () => undefined;
        },
        fire: async (event: string, payload: unknown, ctx: ExtensionContext) => {
            for (const handler of pi.handlers.get(event) ?? []) {
                await handler(payload, ctx);
            }
        },
    } as unknown as FakePi;
    return pi;
}

function fake_ctx(
    idle: boolean,
    aborted: { count: number },
    compacted = { count: 0 },
): ExtensionContext {
    return {
        cwd: "/tmp",
        hasUI: true,
        ui: { notify: () => undefined },
        isIdle: () => idle,
        abort: () => {
            aborted.count += 1;
        },
        compact: () => {
            compacted.count += 1;
        },
    };
}

interface Recorded {
    method: string;
    path: string;
    body: unknown;
}

/** Serves hello, events, and a scripted list of commands; after the list, 204 at once. */
async function fake_daemon(
    script: AgentExtensionCommand[],
): Promise<{ url: string; requests: Recorded[]; close(): void }> {
    const requests: Recorded[] = [];
    const queue = [...script];
    const server: Server = createServer((request, response) => {
        let raw = "";
        request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
        request.on("end", () => {
            const path = request.url ?? "";
            const body = raw.length === 0 ? undefined : (JSON.parse(raw) as unknown);
            requests.push({ method: request.method ?? "", path, body });
            if (path.includes("/commands")) {
                const next = queue.shift();
                if (next === undefined) {
                    response.writeHead(204);
                    response.end();
                    return;
                }
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify({ command: next }));
                return;
            }
            response.writeHead(path.endsWith("/events") ? 202 : 200, {
                "content-type": "application/json",
            });
            response.end(JSON.stringify({ ok: true }));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("no address");
    }
    return {
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => {
            server.closeAllConnections();
            server.close();
        },
    };
}

function until(check: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
        let polls = 0;
        const timer = setInterval(() => {
            polls += 1;
            if (check()) {
                clearInterval(timer);
                resolve();
            } else if (polls > 300) {
                clearInterval(timer);
                reject(new Error("condition not met in time"));
            }
        }, 10);
    });
}

let daemon: { close(): void } | null = null;

afterEach(() => {
    daemon?.close();
    daemon = null;
});

describe("the tty channel", () => {
    it("posts hello, acts on commands, acks with the disposition, posts events", async () => {
        const served = await fake_daemon([
            { id: "c-1", type: "prompt", text: "hello there" },
            { id: "c-2", type: "steer", text: "also this" },
            { id: "c-3", type: "notify", text: "Spinner: the stack job `up` failed" },
            { id: "c-4", type: "abort" },
        ]);
        daemon = served;
        const pi = fake_pi();
        const registered = register(pi, {
            env: {
                SPINNER_SESSION_DIR: "/sessions/s1-x",
                SPINNER_AGENT: "engine",
                SPINNER_DAEMON_URL: served.url,
                SPINNER_HARNESS: "tty",
            },
            tty: { retry_delay_ms: 10, pid: 4242 },
        });
        expect(registered?.tty).toBe(true);
        expect(registered?.tty_channel).not.toBeNull();
        const aborted = { count: 0 };
        const ctx = fake_ctx(true, aborted);
        await pi.fire("session_start", { type: "session_start" }, ctx);
        await until(() => aborted.count === 1);
        // The ack for the abort is the poll after it; wait for the request, not the effect.
        await until(() => served.requests.some((r) => r.path.includes("ack=c-4")));
        const hello = served.requests.find((r) => r.path.endsWith("/hello"));
        expect(hello?.body).toEqual({
            pid: 4242,
            commands: [{ name: "help", source: "extension" }],
        });
        expect(pi.sent).toEqual([
            { text: "hello there", deliverAs: undefined },
            { text: "also this", deliverAs: "steer" },
        ]);
        const polls = served.requests
            .filter((r) => r.path.includes("/commands"))
            .map((r) => r.path);
        expect(polls[0]).toBe("/sessions/s1-x/agents/engine/commands");
        expect(polls[1]).toBe("/sessions/s1-x/agents/engine/commands?ack=c-1&disposition=started");
        expect(polls[2]).toBe("/sessions/s1-x/agents/engine/commands?ack=c-2&disposition=started");
        expect(polls[3]).toBe("/sessions/s1-x/agents/engine/commands?ack=c-3&disposition=started");
        expect(polls[4]).toBe("/sessions/s1-x/agents/engine/commands?ack=c-4&disposition=aborted");
        expect(pi.custom).toEqual([
            {
                customType: "spinner_notice",
                content: "Spinner: the stack job `up` failed",
                options: { triggerTurn: true },
            },
        ]);

        await pi.fire("agent_start", { type: "agent_start" }, ctx);
        await pi.fire("agent_settled", { type: "agent_settled", aborted: false }, ctx);
        await pi.fire("message_update", { type: "message_update" }, ctx);
        await registered?.tty_channel?.flush();
        const posted = served.requests
            .filter((r) => r.path.endsWith("/events"))
            .flatMap((r) => (r.body as { events: Array<{ type: string }> }).events)
            .map((event) => event.type);
        expect(posted).toEqual(["agent_start", "agent_settled"]);

        await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
        expect(registered?.tty_channel?.running).toBe(false);
    });

    it("does not open the channel without SPINNER_HARNESS=tty", () => {
        const pi = fake_pi();
        const registered = register(pi, {
            env: {
                SPINNER_SESSION_DIR: "/sessions/s1-x",
                SPINNER_AGENT: "engine",
                SPINNER_DAEMON_URL: "http://127.0.0.1:1",
            },
        });
        expect(registered?.tty).toBe(false);
        expect(registered?.tty_channel).toBeNull();
        expect(pi.handlers.has("session_start")).toBe(false);
    });

    it("expand_skill: a loaded skill becomes the read instruction; other text stays", () => {
        const commands = [
            { name: "help", source: "extension" as const },
            {
                name: "skill:egm-brainstorm",
                source: "skill" as const,
                sourceInfo: { path: "/egm/skills/egm-brainstorm/SKILL.md" },
            },
            { name: "egm-draft", source: "skill" as const, sourceInfo: { path: "/egm/d.md" } },
            { name: "skill:no-path", source: "skill" as const },
        ];
        const read = "Read the skill file at /egm/skills/egm-brainstorm/SKILL.md";
        expect(expand_skill("/skill:egm-brainstorm", commands)).toBe(
            `${read} and follow it in this thread.`,
        );
        expect(expand_skill("/skill:egm-draft Context File: /b.md.", commands)).toBe(
            "Read the skill file at /egm/d.md and follow it in this thread. " +
                "Arguments: Context File: /b.md.",
        );
        expect(expand_skill("/skill:unknown x", commands)).toBe("/skill:unknown x");
        expect(expand_skill("/skill:no-path", commands)).toBe("/skill:no-path");
        expect(expand_skill("please run /skill:egm-draft", commands)).toBe(
            "please run /skill:egm-draft",
        );
        expect(expand_skill("/help", commands)).toBe("/help");
    });

    it("act: expands a /skill: prompt and steer, never a notify", () => {
        const pi = fake_pi();
        const path = "/egm/skills/egm-review/SKILL.md";
        pi.getCommands = () => [
            { name: "skill:egm-review", source: "skill", sourceInfo: { path } },
        ];
        const busy = fake_ctx(false, { count: 0 });
        act(pi, busy, { id: "c-1", type: "prompt", text: "/skill:egm-review /d.md" });
        act(pi, busy, { id: "c-2", type: "steer", text: "/skill:egm-review" });
        act(pi, busy, { id: "c-3", type: "notify", text: "/skill:egm-review" });
        const read = `Read the skill file at ${path} and follow it in this thread.`;
        expect(pi.sent).toEqual([
            { text: `${read} Arguments: /d.md`, deliverAs: "followUp" },
            { text: read, deliverAs: "steer" },
        ]);
        expect(pi.custom[0]?.content).toBe("/skill:egm-review");
    });

    it("act: compact runs pi's compaction, busy or idle, and sends no message (#45)", () => {
        const pi = fake_pi();
        const compacted = { count: 0 };
        expect(act(pi, fake_ctx(false, { count: 0 }, compacted), { id: "c-1", type: "compact" }))
            .toBe("started");
        expect(act(pi, fake_ctx(true, { count: 0 }, compacted), { id: "c-2", type: "compact" }))
            .toBe("started");
        expect(compacted.count).toBe(2);
        expect(pi.sent).toEqual([]);
        expect(pi.custom).toEqual([]);
    });

    it("act: a busy pi queues a prompt as a follow-up and a steer as a steer", () => {
        const pi = fake_pi();
        const aborted = { count: 0 };
        const busy = fake_ctx(false, aborted);
        expect(act(pi, busy, { id: "c-1", type: "prompt", text: "p" })).toBe("queued");
        expect(act(pi, busy, { id: "c-2", type: "steer", text: "s" })).toBe("queued");
        expect(act(pi, busy, { id: "c-3", type: "prompt", text: "" })).toBe("ignored");
        expect(act(pi, busy, { id: "c-4", type: "notify", text: "n" })).toBe("queued");
        expect(pi.sent).toEqual([
            { text: "p", deliverAs: "followUp" },
            { text: "s", deliverAs: "steer" },
        ]);
        expect(pi.custom).toEqual([
            { customType: "spinner_notice", content: "n", options: { deliverAs: "steer" } },
        ]);
    });
});
