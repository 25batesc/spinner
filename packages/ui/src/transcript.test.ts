// Folds the fixture's scripted pi reply, the same events the fixture daemon sends, and checks
// what the agent tab would show: the user turn, the streamed answer, the tool call and the cost.
import type { AgentPrompt, PiEvent } from "@spinner/protocol";
import { expect, it } from "vitest";

import { replyScript } from "../fixture/server.ts";
import { promptChoices } from "./ChatPrompt.tsx";
import { postFailure } from "./events-client.ts";
import { compactionNote, emptyTranscript, foldEvent, foldPage } from "./transcript.ts";

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

it("holds the prompt pi waits on until its own end, or until the run settles", () => {
    const prompt = { id: "p1", kind: "confirm" as const, title: "damage-control", message: "ok?" };
    const mid = play("fix it", 6);
    const waiting = foldEvent(mid, { type: "ui_prompt_start", prompt });
    expect(waiting.prompt).toEqual(prompt);
    expect(waiting.running).toBe(true);
    // The end of another prompt leaves this one open; its own end closes it.
    expect(foldEvent(waiting, { type: "ui_prompt_end", id: "p0" }).prompt).toEqual(prompt);
    expect(foldEvent(waiting, { type: "ui_prompt_end", id: "p1" }).prompt).toBeNull();
    // A settled run drops a prompt that got no end.
    expect(foldEvent(waiting, { type: "agent_settled", aborted: false }).prompt).toBeNull();
});

it("shows an extension's notification as a note", () => {
    const note: PiEvent = { type: "ui_notify", message: "blocked", level: "warning" };
    const noted = foldEvent(play("fix it"), note);
    expect(noted.entries.at(-1)).toEqual({ kind: "note", text: "blocked" });
});

it("says what a compaction did, or why it did not happen", () => {
    const end = { type: "compaction_end" as const, reason: "manual" as const, willRetry: false };
    const result = { tokensBefore: 9000, estimatedTokensAfter: 1200 };
    const done = { ...end, aborted: false, result };
    expect(compactionNote(done)).toBe("Context compacted: 9k to about 1.2k tokens.");
    const failed = { ...end, aborted: false, errorMessage: "Compaction failed: Already compacted" };
    expect(compactionNote(failed)).toBe(
        "Compaction failed: Already compacted. The context is as it was.",
    );
    expect(compactionNote({ ...end, aborted: true })).toMatch(/stopped/);
    expect(compactionNote({ ...end, aborted: false })).toBe("Context compacted.");
    // The start sets the state the status line reads; the end clears it.
    const started = foldEvent(play("fix it"), { type: "compaction_start", reason: "manual" });
    expect(started.compacting).toBe(true);
    expect(foldEvent(started, done).compacting).toBe(false);
    // A page that holds the end shows the same note as the live event did.
    expect(foldPage([done]).entries).toEqual(foldEvent(emptyTranscript, done).entries);
});

it("shows the daemon's own sentence for a refused request", () => {
    const error = "Cannot submit a prompt while compaction is in progress.";
    const body = JSON.stringify({ error });
    expect(postFailure("/sessions/s1/agents/lead/prompt", 400, body)).toBe(error);
    expect(postFailure("/x", 502, "Bad Gateway")).toBe("POST /x failed (502): Bad Gateway");
});

it("offers the buttons a prompt's kind takes", () => {
    const labels = (prompt: AgentPrompt) => promptChoices(prompt).map((choice) => choice.label);
    expect(labels({ id: "c", kind: "confirm", title: "t" })).toEqual(["Allow", "Deny"]);
    const select: AgentPrompt = { id: "s", kind: "select", title: "t", options: ["red", "green"] };
    expect(promptChoices(select)[1]).toEqual({
        label: "green",
        answer: { kind: "value", value: "green" },
    });
    expect(labels(select)).toEqual(["red", "green", "Cancel"]);
    expect(labels({ id: "i", kind: "input", title: "t" })).toEqual(["Cancel"]);
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
