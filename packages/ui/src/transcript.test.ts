// Folds the fixture's scripted pi reply, the same events the fixture daemon sends, and checks
// what the agent tab would show: the user turn, the streamed answer, the tool call and the cost.
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
