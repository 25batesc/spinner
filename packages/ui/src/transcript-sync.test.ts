// Goal: a chat follows the daemon's numbered events from one page on. It folds the next
// number, ignores one the page already holds, keeps one that came ahead and asks for a page,
// folds the waiting events after that page, and starts over when the agent's pi starts again
// or the socket reconnects. Method: the pure functions of `transcript-sync.ts` and the
// reducer, fed the events and pages a daemon would send.
import type { AgentTranscriptResponse, PiEvent, PiMessage } from "@spinner/protocol";
import { expect, it } from "vitest";

import { initialState, reduce, transcriptKey, type UiState } from "./state.ts";
import {
    WAITING_MAX,
    applyLive,
    applyPage,
    emptyChat,
    needsPage,
    type ChatState,
} from "./transcript-sync.ts";

const TS = "2026-11-19T10:00:00.000Z";

function user(text: string, timestamp: number): PiEvent {
    const message: PiMessage = { role: "user", content: text, timestamp };
    return { type: "message_end", message };
}

function page(next: number, events: PiEvent[], reset = true): AgentTranscriptResponse {
    return { reset, next, events, running: false, prompt: null, compacting: false, active: null };
}

function texts(chat: ChatState): string[] {
    const entries = chat.transcript.entries;
    return entries.map((entry) => (entry.kind === "user" ? entry.text : entry.kind));
}

it("needs a page first, then folds the numbered events in order", () => {
    expect(needsPage(emptyChat)).toBe(true);
    const synced = applyPage(emptyChat, page(4, [user("one", 1), user("two", 2)]));
    expect(needsPage(synced)).toBe(false);
    expect(synced.cursor).toBe(4);
    expect(texts(synced)).toEqual(["one", "two"]);

    // The next number folds; one the page holds already does nothing.
    const next = applyLive(synced, 5, user("three", 3), TS);
    expect(texts(next)).toEqual(["one", "two", "three"]);
    expect(next).toMatchObject({ cursor: 5, active: TS });
    expect(applyLive(next, 4, user("two", 2), TS)).toBe(next);
    expect(applyLive(next, 5, user("three", 3), TS)).toBe(next);
});

it("keeps an event that came ahead, asks for a page, and folds it after the page", () => {
    const synced = applyPage(emptyChat, page(4, [user("one", 1)]));
    // 5 and 6 were lost; 7 and 8 arrive.
    const ahead = applyLive(applyLive(synced, 7, user("seven", 7), TS), 8, user("eight", 8), TS);
    expect(texts(ahead)).toEqual(["one"]);
    expect(ahead.cursor).toBe(4);
    expect(needsPage(ahead)).toBe(true);
    // The page continues after 4 and already holds 7: only 8 is still to fold.
    const events = [user("five", 5), user("six", 6), user("seven", 7)];
    const caught = applyPage(ahead, page(7, events, false));
    expect(texts(caught)).toEqual(["one", "five", "six", "seven", "eight"]);
    expect(caught.cursor).toBe(8);
    expect(needsPage(caught)).toBe(false);

    // A page that does not reach the waiting event leaves it waiting: another page is due.
    const short = applyPage(ahead, page(5, [user("five", 5)], false));
    expect(short.cursor).toBe(5);
    expect(short.waiting.map((entry) => entry.seq)).toEqual([7, 8]);
    expect(needsPage(short)).toBe(true);
});

it("takes the run state, the open prompt and the compaction from the page", () => {
    const prompt = { id: "p", kind: "confirm" as const, title: "rm?" };
    const active = "2026-11-19T09:59:00.000Z";
    const waiting = applyPage(emptyChat, {
        reset: true,
        next: 9,
        events: [user("go", 1)],
        running: true,
        prompt,
        compacting: true,
        active,
    });
    expect(waiting.transcript).toMatchObject({ running: true, prompt, compacting: true });
    expect(waiting.active).toBe(active);
    const ended = applyLive(waiting, 10, { type: "ui_prompt_end", id: "p" }, TS);
    expect(ended.transcript.prompt).toBeNull();
    // The compaction's end clears the state and leaves a note of what it did.
    const result = { tokensBefore: 412_000, estimatedTokensAfter: 38_400 };
    const done = applyLive(ended, 11, {
        type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false,
    }, TS);
    expect(done.transcript.compacting).toBe(false);
    expect(done.transcript.entries.at(-1)).toEqual({
        kind: "note",
        text: "Context compacted: 412k to about 38.4k tokens.",
    });
});

it("replaces the transcript with a whole page, and starts over when too far behind", () => {
    const old = applyPage(emptyChat, page(4, [user("old", 1)]));
    expect(texts(applyPage(old, page(2, [user("new", 9)])))).toEqual(["new"]);
    // Before any page a live event is folded as it comes, so a tab nobody opened knows it.
    const live = applyLive(emptyChat, 12, user("live", 2), TS);
    expect(texts(live)).toEqual(["live"]);
    expect(live.cursor).toBeNull();

    let behind = old;
    for (let seq = 6; seq < 6 + WAITING_MAX; seq += 1) {
        behind = applyLive(behind, seq, user("x", seq), TS);
    }
    expect(behind.waiting).toHaveLength(WAITING_MAX);
    const over = applyLive(behind, 6 + WAITING_MAX, user("y", 0), TS);
    expect(over).toMatchObject({ cursor: null, waiting: [] });
});

it("the store takes its transcript again after a new pi and after a reconnect", () => {
    const key = transcriptKey("s1", "lead");
    const event = (seq: number, pi: PiEvent) =>
        ({ kind: "event", event: { type: "agent.event", ts: TS, session: "s1", agent: "lead",
            event: pi, seq } }) as const;
    let state: UiState = reduce(initialState, { kind: "connection", status: "open" });
    state = reduce(state, {
        kind: "transcript",
        session: "s1",
        agent: "lead",
        page: page(3, [user("one", 1)]),
    });
    state = reduce(state, event(4, user("two", 2)));
    expect(texts(state.chats[key] ?? emptyChat)).toEqual(["one", "two"]);
    // An event without a number is not the chat's.
    const unnumbered = { type: "agent.event", ts: TS, session: "s1", agent: "lead" } as const;
    const same = reduce(state, {
        kind: "event",
        event: { ...unnumbered, event: { type: "turn_start" } },
    });
    expect(same.chats).toBe(state.chats);

    const spawned = reduce(state, {
        kind: "event",
        event: { type: "agent.spawned", ts: TS, session: "s1", agent: "lead", pid: 7 },
    });
    expect(spawned.chats[key]?.cursor).toBeNull();
    expect(texts(spawned.chats[key] ?? emptyChat)).toEqual(["one", "two"]);

    const closed = reduce(state, { kind: "connection", status: "closed" });
    expect(closed.chats[key]?.cursor).toBe(4);
    const reopened = reduce(closed, { kind: "connection", status: "open" });
    expect(reopened.chats[key]?.cursor).toBeNull();
});
