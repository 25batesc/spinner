// Folds the fixture's scripted pi reply, the same events the fixture daemon sends, and checks
// what the agent tab would show: the user turn, the streamed answer, the tool call and the cost.
import type { PiEvent } from "@spinner/protocol";
import { expect, it } from "vitest";

import { replyScript } from "../fixture/server.ts";
import { emptyTranscript, foldEvent } from "./transcript.ts";

function play(prompt: string, upTo = Infinity) {
    return replyScript(prompt)
        .slice(0, upTo)
        .reduce(foldEvent, emptyTranscript);
}

it("shows the user turn, the answer, the tool call and the cost after a full reply", () => {
    const done = play("fix it");
    expect(done.running).toBe(false);
    expect(done.cost).toBeCloseTo(0.003);
    expect(done.entries.map((e) => e.kind)).toEqual(["user", "assistant", "tool"]);
    const assistant = done.entries.find((e) => e.kind === "assistant");
    expect(assistant).toMatchObject({ text: "Done: fix it", done: true });
    const tool = done.entries.find((e) => e.kind === "tool");
    expect(tool).toMatchObject({ name: "bash", state: "ok" });
});

it("streams: mid-reply the answer is partial, the tool runs and the agent is working", () => {
    const mid = play("fix it", 6);
    expect(mid.running).toBe(true);
    expect(mid.entries.find((e) => e.kind === "assistant")).toMatchObject({
        text: "Done: ",
        done: false,
    });
    expect(mid.entries.find((e) => e.kind === "tool")).toMatchObject({ state: "running" });
    expect(mid.cost).toBe(0);
});

it("rebuilds a tab from the daemon's history, which has `message_end` records only", () => {
    const usage = {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
    };
    const history: PiEvent[] = [
        { type: "message_end", message: { role: "user", content: "hi", timestamp: 0 } },
        {
            type: "message_end",
            message: {
                role: "assistant", api: "x", provider: "x", model: "x", usage,
                stopReason: "toolUse", timestamp: 0,
                content: [
                    { type: "text", text: "looking" },
                    { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } },
                ],
            },
        },
        {
            type: "message_end",
            message: {
                role: "toolResult", toolCallId: "c1", toolName: "read", isError: false,
                content: [{ type: "text", text: "contents" }], timestamp: 0,
            },
        },
    ];
    const folded = history.reduce(foldEvent, emptyTranscript);
    expect(folded.entries.map((e) => e.kind)).toEqual(["user", "assistant", "tool"]);
    expect(folded.entries[2]).toMatchObject({ name: "read", state: "ok", result: "contents" });
    expect(folded.cost).toBe(0.5);
});
