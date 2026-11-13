// The chat's pure half. Method: fold a history and a live stream that overlap, as a tab that
// reopens sees them, and check each message shows once; then the tool row's summary, the
// window of drawn entries, the keys of the message box and the text with attached images.
import { describe, expect, it } from "vitest";
import type { PiEvent, PiMessage } from "@spinner/protocol";

import {
    boxRows,
    messageWithImages,
    sendsOnKey,
    toolSummary,
    toolText,
    windowed,
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

    it("adds each attached image's path to the message", () => {
        expect(messageWithImages(" fix this ", [])).toBe("fix this");
        expect(messageWithImages("fix this", ["/s/a.png", "/s/b.png"])).toBe(
            "fix this\n\nAttached image: /s/a.png\nAttached image: /s/b.png",
        );
        expect(messageWithImages("", ["/s/a.png"])).toBe("Attached image: /s/a.png");
    });
});
