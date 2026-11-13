// The chat's pure half. Method: fold a history and a live stream that overlap, as a tab that
// reopens sees them, and check each message shows once; then the tool row's summary, the
// window of drawn entries, the keys of the message box and the text with attached images.
import { describe, expect, it } from "vitest";
import type { PiEvent, PiMessage, SessionView } from "@spinner/protocol";

import { chatQuestion } from "./ChatGate.tsx";
import { RESOLVE_NEEDS } from "./design.ts";

import {
    boxRows,
    chatBlocks,
    durationText,
    isSpinnerNotice,
    messageWithFiles,
    modelLabel,
    sendsOnKey,
    slashMatches,
    slashQuery,
    toolSummary,
    toolText,
    windowed,
    withDictation,
    workLabel,
} from "./chat.ts";
import {
    emptyTranscript,
    foldEvent,
    foldHistory,
    mergeTranscripts,
    type Entry,
} from "./transcript.ts";

const USAGE = {
    input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
};

function user(ts: number, text: string): PiMessage {
    return { role: "user", content: text, timestamp: ts };
}

function assistant(ts: number, text: string, tool?: string): PiMessage {
    const args = { command: "ls" };
    const call = { type: "toolCall" as const, id: tool ?? "", name: "bash", arguments: args };
    return {
        role: "assistant", api: "a", provider: "p", model: "m", usage: USAGE,
        stopReason: tool === undefined ? "stop" : "toolUse", timestamp: ts,
        content: [{ type: "text", text }, ...(tool === undefined ? [] : [call])],
    };
}

function result(ts: number, id: string): PiMessage {
    return {
        role: "toolResult", toolCallId: id, toolName: "bash", isError: false, timestamp: ts,
        content: [{ type: "text", text: "a.txt" }],
    };
}

const end = (message: PiMessage): PiEvent => ({ type: "message_end", message });
const start = (message: PiMessage): PiEvent => ({ type: "message_start", message });

function tool(name: string, args: unknown): Extract<Entry, { kind: "tool" }> {
    return { kind: "tool", id: "t", name, args, state: "ok" };
}

describe("the chat's transcript", () => {
    it("folds a history in one pass: messages, tool calls with their results, the cost", () => {
        const history = foldHistory([
            end(user(1, "list the files")),
            end(assistant(2, "Looking.", "call-1")),
            end(result(3, "call-1")),
            end(assistant(4, "One file: a.txt")),
        ]);
        expect(history.entries.map((entry) => entry.kind)).toEqual([
            "user", "assistant", "tool", "assistant",
        ]);
        expect(history.entries[2]).toMatchObject({ id: "call-1", state: "ok", result: "a.txt" });
        expect(history.cost).toBe(0.5);
    });

    it("shows a message once when the history and the live fold both hold it", () => {
        // The tab opened while the tool ran: the history has the call, not its result.
        const looking = assistant(2, "Looking.", "call-1");
        const history = foldHistory([end(user(1, "list")), end(looking)]);
        // The live fold saw the same turn from its start, then the result and the answer.
        const live = [
            start(user(1, "list")), end(user(1, "list")),
            start(assistant(2, "")), end(assistant(2, "Looking.", "call-1")),
            { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: {} },
            { type: "tool_execution_end", toolCallId: "call-1", result: "a.txt", isError: false },
            start(assistant(4, "")),
        ].reduce((state, event) => foldEvent(state, event as PiEvent), emptyTranscript);
        const merged = mergeTranscripts(history, live);
        expect(merged.entries.map((entry) => entry.kind)).toEqual([
            "user", "assistant", "tool", "assistant",
        ]);
        // The history's running call took the live result; the open answer is the live one.
        expect(merged.entries[2]).toMatchObject({ state: "ok", result: "a.txt" });
        expect(merged.entries[3]).toMatchObject({ done: false, ts: 4 });
        // An empty history adds nothing and loses nothing.
        expect(mergeTranscripts(emptyTranscript, live).entries).toHaveLength(live.entries.length);
    });

    it("marks an answer that ended in an error, and counts a message's images", () => {
        const failed = { ...assistant(2, ""), stopReason: "error", errorMessage: "overloaded" };
        const image = { type: "image", data: "", mimeType: "image/png" };
        const content = [{ type: "text", text: "see" }, image];
        const with_image = { role: "user", timestamp: 1, content };
        const history = foldHistory([end(with_image as PiMessage), end(failed as PiMessage)]);
        expect(history.entries[0]).toMatchObject({ text: "see", images: 1 });
        expect(history.entries[1]).toMatchObject({ error: "overloaded" });
    });
});

describe("the chat's rows and box", () => {
    it("says what a tool call acts on in one line", () => {
        const bash = tool("bash", { command: "pnpm test\n  --run" });
        expect(toolSummary(bash)).toBe("pnpm test --run");
        expect(toolSummary(tool("read", { path: "src/a.ts", limit: 20 }))).toBe("src/a.ts");
        expect(toolSummary(tool("change", { command: "start", title: "Fix it" }))).toBe(
            "start · Fix it",
        );
        expect(toolSummary(tool("mission_plan", { ids: [1, 2] }))).toBe('{"ids":[1,2]}');
        expect(toolSummary(tool("session_list", {}))).toBe("");
        expect(toolSummary(tool("bash", { command: "x".repeat(300) }))).toHaveLength(141);
        expect(toolText({ a: 1 })).toBe('{\n  "a": 1\n}');
        expect(toolText("plain")).toBe("plain");
    });

    it("draws the newest entries and counts the earlier ones", () => {
        const entries = Array.from({ length: 10 }, (_, index) => index);
        expect(windowed(entries, 4)).toEqual({ entries: [6, 7, 8, 9], earlier: 6 });
        expect(windowed(entries, 50)).toEqual({ entries, earlier: 0 });
    });

    it("sends on Enter, not on Shift+Enter, and not inside an input method", () => {
        expect(sendsOnKey({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true);
        expect(sendsOnKey({ key: "Enter", shiftKey: true, isComposing: false })).toBe(false);
        expect(sendsOnKey({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
        expect(sendsOnKey({ key: "a", shiftKey: false, isComposing: false })).toBe(false);
        expect(boxRows("one")).toBe(1);
        expect(boxRows("a\nb\nc")).toBe(3);
        expect(boxRows("x\n".repeat(40))).toBe(12);
    });

    it("adds each attached file's path to the message", () => {
        expect(messageWithFiles(" fix this ", [])).toBe("fix this");
        expect(messageWithFiles("fix this", ["/s/a.png", "/s/b.csv"])).toBe(
            "fix this\n\nAttached file: /s/a.png\nAttached file: /s/b.csv",
        );
        expect(messageWithFiles("", ["/s/a.png"])).toBe("Attached file: /s/a.png");
    });
});

describe("the chat's turns", () => {
    const u = (ts: number, text: string): Entry => ({ kind: "user", text, ts });
    const a = (ts: number, text: string, thinking = ""): Entry => ({
        kind: "assistant", text, thinking, done: true, ts,
    });
    const t = (id: string, state: "ok" | "error" | "running" = "ok"): Entry => ({
        kind: "tool", id, name: "bash", args: { command: `run ${id}` }, state,
    });

    it("folds a turn's thoughts, remarks and tool calls; the last text is the answer", () => {
        const blocks = chatBlocks(
            [
                u(1000, "fix the test"),
                a(2000, "Let me look.", "The test is flaky."),
                t("1"),
                t("2", "error"),
                a(150_000, "Fixed: the clock was real.", "Done."),
                u(200_000, "thanks"),
                a(208_000, "", "Nothing to do."),
            ],
            false,
        );
        const kinds = blocks.map((block) => block.kind);
        expect(kinds).toEqual(["user", "work", "answer", "user", "work"]);
        const work = blocks[1];
        expect(work).toMatchObject({ steps: 2, failed: 1, seconds: 149, live: false });
        expect(work?.kind === "work" && work.items.map((item) => item.kind)).toEqual([
            "thinking", "remark", "tool", "tool", "thinking",
        ]);
        expect(work?.kind === "work" && workLabel(work)).toBe(
            "Worked for 2m 29s · 2 steps · 1 failed",
        );
        const thought = blocks[4];
        expect(thought?.kind === "work" && workLabel(thought)).toBe("Thought for 8s");
    });

    it("shows a running turn as work, with what the running tool acts on", () => {
        const blocks = chatBlocks([u(1000, "go"), a(2000, "On it."), t("1", "running")], true);
        expect(blocks.map((block) => block.kind)).toEqual(["user", "work"]);
        const work = blocks[1];
        expect(work?.kind === "work" && work.live).toBe(true);
        expect(work?.kind === "work" && workLabel(work)).toBe("Working · bash run 1");
        // A text that streams with no tool after it is the answer, also while the turn runs.
        const streaming = chatBlocks([u(1000, "go"), t("1"), a(3000, "Almost")], true);
        expect(streaming.map((block) => block.kind)).toEqual(["user", "work", "answer"]);
        expect(chatBlocks([], false)).toEqual([]);
    });

    it("says a duration in a few characters", () => {
        expect(durationText(8.4)).toBe("8s");
        expect(durationText(149)).toBe("2m 29s");
        expect(durationText(3840)).toBe("1h 4m");
    });

    it("completes a command after a slash, skills without their prefix", () => {
        const commands = [
            { name: "skill:pr-review", kind: "skill", description: "Review a pull request" },
            { name: "skill:principles", kind: "skill", description: "Engineering principles" },
            { name: "plan", kind: "template", description: "Plan a change" },
        ];
        expect(slashQuery("/pr")).toBe("pr");
        expect(slashQuery("/")).toBe("");
        expect(slashQuery("/plan now")).toBeNull();
        expect(slashQuery("see /plan")).toBeNull();
        expect(slashMatches(commands, "pr").map((c) => c.name)).toEqual([
            "skill:pr-review", "skill:principles",
        ]);
        expect(slashMatches(commands, "change").map((c) => c.name)).toEqual(["plan"]);
        expect(slashMatches(commands, "")).toHaveLength(3);
    });

    it("labels the model and joins dictated words to the text", () => {
        expect(modelLabel("anthropic/claude-opus-5-5")).toBe("claude-opus-5-5");
        expect(modelLabel("openrouter/anthropic/claude-fable-5.2")).toBe("claude-fable-5.2");
        expect(modelLabel(undefined)).toBe("model");
        expect(withDictation("", " fix the test ")).toBe("fix the test");
        expect(withDictation("please", "fix it")).toBe("please fix it");
        expect(withDictation("please ", "fix it")).toBe("please fix it");
        expect(withDictation("keep", "  ")).toBe("keep");
    });
});

it("tells Spinner's own messages to an agent from the operator's", () => {
    expect(isSpinnerNotice("MISSION.md changed by unknown: Log (+1).\nRe-read it.")).toBe(true);
    expect(isSpinnerNotice("Spinner autopilot: your pull request needs you.")).toBe(true);
    expect(isSpinnerNotice('Implement the plan "Exports": /p/exports.md')).toBe(true);
    expect(isSpinnerNotice("please fix the MISSION.md changed by me")).toBe(false);
    expect(isSpinnerNotice("fix the test")).toBe(false);
});

it("shows the lead's open question as the last block of its chat", () => {
    const gate = { question: "Which shape?", options: ["(a) one", "(b) two"], asked: "t1" };
    const view = (design: object | undefined, needs: string | null): SessionView =>
        ({
            board: null,
            summary: { session: { needs_human: needs } },
            ...(design === undefined ? {} : { design }),
        }) as unknown as SessionView;
    expect(chatQuestion(view({ gate, stage: "drafting" }, null))).toEqual({
        key: "t1", label: "lead asks", question: "Which shape?", options: ["(a) one", "(b) two"],
    });
    const resolve = chatQuestion(view({ gate: null, stage: "resolving" }, RESOLVE_NEEDS));
    expect(resolve?.key).toBe("resolve");
    expect(resolve?.options).toHaveLength(3);
    expect(chatQuestion(view({ gate: null, stage: "drafting" }, null))).toBeNull();
    expect(chatQuestion(view(undefined, null))).toBeNull();
});
