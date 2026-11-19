// Goal: the transcript log numbers the events the chat folds without a gap, holds a finished
// message as one `message_end`, joins the deltas of an open message, stays under its count
// and byte bounds without losing the run state or the open prompt, and answers a page as
// the events after `since` only when nothing between was dropped or joined. Method: the log
// alone, fed events in pi's order; then a real daemon with the fake rpc pi, to see the
// numbers on the bus and the pages of `GET …/transcript` for a hosted and a stopped agent.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTranscriptResponse, PiEvent, SpinnerEvent } from "@spinner/protocol";
import {
    TRANSCRIPT_BYTES_MAX,
    TRANSCRIPT_EVENTS_MAX,
    TRANSCRIPT_TEXT_CHARS_MAX,
} from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { start_daemon, type Daemon } from "../server.js";
import { create_session } from "../store/session-store.js";
import { agent_pi_dir } from "./harness.js";
import { agent_history_tail } from "./history.js";
import { TranscriptLog, chat_event } from "./transcript-log.js";

const USAGE = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string, timestamp = 1): PiEvent {
    return { type: "message_end", message: { role: "user", content: text, timestamp } };
}

function assistant(type: "message_start" | "message_end", text: string): PiEvent {
    const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text }],
        api: "fake",
        provider: "fake",
        model: "fake",
        usage: USAGE,
        stopReason: "stop" as const,
        timestamp: 2,
    };
    return { type, message };
}

function delta(text: string, kind: "text_delta" | "thinking_delta" = "text_delta"): PiEvent {
    const event = { type: kind, contentIndex: 0, delta: text };
    return { type: "message_update", usage: USAGE, assistantMessageEvent: event };
}

function types(page: AgentTranscriptResponse): string[] {
    return page.events.map((event) => event.type);
}

describe("TranscriptLog", () => {
    it("numbers the chat's events without a gap and skips the rest", () => {
        const log = new TranscriptLog();
        expect(log.append({ type: "agent_start" })?.seq).toBe(1);
        expect(log.append({ type: "turn_start" })).toBeNull();
        expect(log.append(user("hi"))?.seq).toBe(2);
        const tool_delta = { type: "toolcall_delta" as const, contentIndex: 1, delta: "{" };
        const update: PiEvent = {
            type: "message_update",
            usage: USAGE,
            assistantMessageEvent: tool_delta,
        };
        expect(log.append(update)).toBeNull();
        const system = { role: "system", content: "a mission patch" };
        expect(log.append({ type: "message_end", message: system })).toBeNull();
        expect(log.append({ type: "agent_settled", aborted: false })?.seq).toBe(3);
        expect(log.page(0, null)).toMatchObject({ reset: true, next: 3, running: false });
    });

    it("holds a finished message as its message_end, and a tool call as its result", () => {
        const log = new TranscriptLog();
        log.seed([user("an old turn", 0)]);
        log.append({ type: "agent_start" });
        log.append(user("fix it"));
        log.append(assistant("message_start", ""));
        log.append(delta("Do"));
        log.append(delta("ne"));
        // Mid-message: the start and one joined delta, after the messages that ended.
        const mid = log.page(0, null);
        expect(types(mid).slice(2)).toEqual(["message_start", "message_update"]);
        expect(mid.events[3]).toMatchObject({ assistantMessageEvent: { delta: "Done" } });
        expect(mid.running).toBe(true);

        log.append(assistant("message_end", "Done"));
        const call = { toolCallId: "t1", toolName: "bash" };
        log.append({ type: "tool_execution_start", ...call, args: { command: "ls" } });
        log.append({ type: "tool_execution_end", ...call, result: "a\nb", isError: false });
        const running = log.page(0, null);
        expect(types(running).slice(2)).toEqual([
            "message_end",
            "tool_execution_start",
            "tool_execution_end",
        ]);
        const result = {
            role: "toolResult" as const,
            toolCallId: "t1",
            toolName: "bash",
            content: [{ type: "text" as const, text: "a\nb" }],
            isError: false,
            timestamp: 3,
        };
        log.append({ type: "message_end", message: result });
        expect(types(log.page(0, null))).toEqual([
            "message_end",
            "message_end",
            "message_end",
            "message_end",
        ]);
    });

    it("answers the events after `since`, or the whole log when it cannot continue", () => {
        const log = new TranscriptLog();
        log.seed([user("old", 0)]);
        log.append({ type: "agent_start" }); // 1
        log.append(user("go")); // 2
        log.append(assistant("message_start", "")); // 3
        log.append(delta("a")); // 4
        log.append(delta("b")); // 5, joined with 4
        log.append(delta("why", "thinking_delta")); // 6: another kind, held alone
        // A client that folded through 3 or 5 continues; one at 4 is inside the joined run.
        expect(log.page(3, null)).toMatchObject({ reset: false, next: 6 });
        expect(types(log.page(3, null))).toEqual(["message_update", "message_update"]);
        expect(types(log.page(5, null))).toEqual(["message_update"]);
        expect(log.page(4, null).reset).toBe(true);
        expect(log.page(6, null)).toMatchObject({ reset: false, events: [] });
        // Nothing to continue from: a fresh tab, and a number from another pi's log.
        expect(log.page(0, null).reset).toBe(true);
        expect(log.page(99, null).reset).toBe(true);
        expect(types(log.page(0, null))[0]).toBe("message_end");

        // The message ended while a client was at 3: it gets the whole message, once.
        log.append(assistant("message_end", "ab")); // 7
        expect(types(log.page(3, null))).toEqual(["message_end"]);
    });

    it("carries the run state and the open prompt with the page, past the caps", () => {
        const log = new TranscriptLog();
        log.append({ type: "agent_start" });
        const prompt = { id: "p1", kind: "confirm" as const, title: "rm?" };
        log.append({ type: "ui_prompt_start", prompt });
        for (let index = 0; index < TRANSCRIPT_EVENTS_MAX + 10; index += 1) {
            log.append(user(`message ${index}`, index));
        }
        const page = log.page(0, "2026-01-01T00:00:00.000Z");
        expect(page.events).toHaveLength(TRANSCRIPT_EVENTS_MAX);
        expect(page.events[0]).toEqual(user("message 10", 10));
        expect(page).toMatchObject({
            running: true,
            prompt,
            active: "2026-01-01T00:00:00.000Z",
            next: TRANSCRIPT_EVENTS_MAX + 12,
        });
        // A client behind the dropped events takes the whole log; one past them continues.
        expect(log.page(5, null).reset).toBe(true);
        expect(log.page(TRANSCRIPT_EVENTS_MAX, null).reset).toBe(false);

        log.append({ type: "ui_prompt_end", id: "p0" });
        expect(log.page(0, null).prompt).toEqual(prompt);
        log.append({ type: "ui_prompt_end", id: "p1" });
        expect(log.page(0, null).prompt).toBeNull();
        log.append({ type: "ui_prompt_start", prompt });
        log.append({ type: "agent_settled", aborted: false });
        expect(log.page(0, null)).toMatchObject({ running: false, prompt: null });
    });

    it("stays under the byte bound, and keeps the newest event whatever its size", () => {
        const log = new TranscriptLog();
        const text = "x".repeat(TRANSCRIPT_TEXT_CHARS_MAX);
        const count = Math.ceil(TRANSCRIPT_BYTES_MAX / TRANSCRIPT_TEXT_CHARS_MAX) + 5;
        for (let index = 0; index < count; index += 1) {
            log.append(user(text, index));
        }
        const page = log.page(0, null);
        expect(page.events.length).toBeLessThan(count);
        expect(JSON.stringify(page.events).length).toBeLessThanOrEqual(TRANSCRIPT_BYTES_MAX + 64);
        expect(page.events.at(-1)).toEqual(user(text, count - 1));
    });
});

describe("chat_event", () => {
    it("cuts a long text, leaves image bytes out, and stubs what is still too big", () => {
        const long = "y".repeat(TRANSCRIPT_TEXT_CHARS_MAX + 50);
        const cut = chat_event(user(long));
        const cut_text = (cut as { message: { content: string } }).message.content;
        expect(cut_text.startsWith("y".repeat(TRANSCRIPT_TEXT_CHARS_MAX))).toBe(true);
        expect(cut_text.endsWith("… [50 more characters not shown]")).toBe(true);

        const image = { type: "image" as const, data: "QUJD".repeat(1000), mimeType: "image/png" };
        const content = [{ type: "text" as const, text: "look" }, image];
        const shown = chat_event({
            type: "message_end",
            message: { role: "user", content, timestamp: 1 },
        });
        expect(shown).toEqual({
            type: "message_end",
            message: {
                role: "user",
                content: [{ type: "text", text: "look" }, { ...image, data: "" }],
                timestamp: 1,
            },
        });

        // A write of a long file: the path stays, the content is cut.
        const call = { toolCallId: "t", toolName: "write" };
        const args = { path: "a.txt", content: long };
        const start = chat_event({ type: "tool_execution_start", ...call, args });
        expect(start).toMatchObject({ args: { path: "a.txt" } });
        expect(JSON.stringify(start).length).toBeLessThan(long.length + 200);

        // Nested texts the cut does not reach: the event keeps its shape, not its body.
        const edits = Array.from({ length: 10 }, () => ({ oldText: long, newText: long }));
        const nested = chat_event({ type: "tool_execution_start", ...call, args: { edits } });
        expect(nested).toMatchObject({ ...call, args: { note: expect.stringMatching(/bytes/) } });
        const result = { content: [{ type: "text", text: "ok" }], details: { edits } };
        const ended = chat_event({ type: "tool_execution_end", ...call, result, isError: false });
        expect(ended).toMatchObject({ ...call, result: expect.stringMatching(/not shown/) });
    });
});

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(here, "..", "..", "test", "fixtures", "fake-pi.ts");

describe("the transcript through the daemon", () => {
    let root: string;
    let home: SpinnerHome;
    let daemon: Daemon;
    let events: SpinnerEvent[];

    beforeEach(async () => {
        chmodSync(FAKE_PI, 0o755);
        root = mkdtempSync(join(tmpdir(), "spinner-transcript-"));
        home = resolve_home({ SPINNER_HOME: join(root, "home") });
        mkdirSync(home.root, { recursive: true });
        daemon = await start_daemon({
            home,
            port: 0,
            log: () => undefined,
            poll_seconds: 0,
            notify: async () => undefined,
            ui_dir: null,
            observe_interval_ms: 60_000,
            pi: FAKE_PI,
            extension: null,
            cwd: root,
        });
        events = [];
        daemon.bus.subscribe((event) => events.push(event));
    });

    afterEach(async () => {
        await daemon.close();
        rmSync(root, { recursive: true, force: true });
    });

    async function get(path: string): Promise<Response> {
        return fetch(`http://127.0.0.1:${daemon.port}${path}`);
    }

    async function post(path: string, body: unknown): Promise<Response> {
        return fetch(`http://127.0.0.1:${daemon.port}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
    }

    async function until(check: () => boolean): Promise<void> {
        for (let poll = 0; poll < 500; poll += 1) {
            if (check()) {
                return;
            }
            await new Promise((resolve_) => setTimeout(resolve_, 10));
        }
        throw new Error("condition not met in time");
    }

    it("numbers live events, serves pages, and reads a stopped agent's file", async () => {
        const summary = create_session(home, { title: "Transcript" });
        mkdirSync(join(summary.path, "agents", "ui"), { recursive: true });
        writeFileSync(join(summary.path, "agents", "ui", "BRIEF.md"), "# ui\n");
        // What an earlier pi left in the transcript file: two turns and a system message.
        const pi_dir = join(summary.path, agent_pi_dir("ui"));
        mkdirSync(pi_dir, { recursive: true });
        const lines = [
            { type: "session", id: "ui" },
            { type: "message", message: { role: "user", content: "first", timestamp: 1 } },
            { type: "message", message: { role: "system", content: "a patch" } },
            { type: "message", message: { role: "user", content: "second", timestamp: 2 } },
        ];
        const text = lines.map((line) => JSON.stringify(line)).join("\n");
        writeFileSync(join(pi_dir, "t.jsonl"), text);
        expect(agent_history_tail(summary.path, "ui", 1)).toEqual([user("second", 2)]);

        const route = `/sessions/${summary.dir}/agents/ui`;
        expect((await get(`${route}/transcript`)).status).toBe(404);
        const added = await post(`/sessions/${summary.dir}/agents`, { name: "ui" });
        expect(added.status).toBe(201);
        await until(() => events.some((event) => event.type === "agent.settled"));

        // Every numbered event is on the bus once, in order, from 1; the rest have no number.
        const numbered = events.flatMap((event) =>
            event.type === "agent.event" && event.seq !== undefined ? [event.seq] : [],
        );
        expect(numbered).toEqual(numbered.map((_, index) => index + 1));
        const unnumbered = events.flatMap((event) =>
            event.type === "agent.event" && event.seq === undefined ? [event.event.type] : [],
        );
        expect(unnumbered).toEqual(expect.arrayContaining(["turn_end", "agent_end"]));

        const whole = (await (await get(`${route}/transcript`)).json()) as AgentTranscriptResponse;
        expect(whole).toMatchObject({ reset: true, next: numbered.length, running: false });
        expect(whole.events.slice(0, 2)).toEqual([user("first", 1), user("second", 2)]);
        expect(whole.events.every((event) => event.type === "message_end")).toBe(true);
        expect(typeof whole.active).toBe("string");

        // A client at the end gets nothing; after one more turn it gets that turn alone.
        const at = `${route}/transcript?since=${whole.next}`;
        expect(await (await get(at)).json()).toMatchObject({ reset: false, events: [] });
        events.length = 0;
        await post(`${route}/prompt`, { text: "again" });
        await until(() => events.some((event) => event.type === "agent.settled"));
        const more = (await (await get(at)).json()) as AgentTranscriptResponse;
        expect(more.reset).toBe(false);
        expect(JSON.stringify(more.events)).toContain("echo: again");
        expect((await get(`${route}/transcript?since=-1`)).status).toBe(400);

        // Stopped: the page is the file's tail, from 0, with no run and no activity.
        await post(`${route}/stop`, {});
        await until(() => events.some((event) => event.type === "agent.exited"));
        const stopped = (await (await get(at)).json()) as AgentTranscriptResponse;
        expect(stopped).toMatchObject({ reset: true, next: 0, running: false, active: null });
        expect(stopped.events.slice(0, 2)).toEqual([user("first", 1), user("second", 2)]);
    }, 30_000);
});
