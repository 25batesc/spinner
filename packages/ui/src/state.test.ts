// Tests drive the reducer with the same canned events the fixture server replays, so they check
// what a user would see after the stream: which sessions exist and what the feed says.
import { describe, expect, it } from "vitest";

import { buildScript, SESSIONS } from "../fixture/data.ts";
import { FEED_LIMIT, initialState, reduce, sortedSessions, type UiState } from "./state.ts";

function play(state: UiState): UiState {
    let next = reduce(state, { kind: "snapshot", sessions: SESSIONS });
    for (const event of buildScript()) {
        next = reduce(next, { kind: "event", event });
    }
    return next;
}

describe("reduce", () => {
    it("shows the snapshot sessions with the waiting one first", () => {
        const state = reduce(initialState, { kind: "snapshot", sessions: SESSIONS });
        expect(sortedSessions(state).map(([dir]) => dir)).toEqual([
            "s17-refund-flow",
            "s001-bootstrap",
        ]);
    });

    it("applies a replayed stream to sessions, agents and stack", () => {
        const state = play(initialState);
        expect(Object.keys(state.sessions)).not.toContain("s18-csv-export");
        const s17 = state.sessions["s17-refund-flow"];
        expect(s17?.stage).toBe("addressing");
        expect(s17?.agents["backend"]?.process).toBe("idle");
    });

    it("records a feed line for transitions and keeps raw agent output out of it", () => {
        const state = play(initialState);
        const texts = state.feed.map((line) => line.text);
        expect(texts).toContain("peer-review \u2192 addressing: A human left 2 threads");
        expect(texts.some((text) => text.includes("message_update"))).toBe(false);
        expect(state.transcripts["s17-refund-flow/backend"]).toHaveLength(1);
    });

    it("does not let a snapshot overwrite a session the stream already updated", () => {
        const streamed = play(reduce(initialState, { kind: "snapshot", sessions: SESSIONS }));
        const again = reduce(streamed, { kind: "snapshot", sessions: SESSIONS });
        expect(again.sessions["s17-refund-flow"]?.stage).toBe("addressing");
    });

    it("bounds the feed", () => {
        let state = initialState;
        for (let i = 0; i < FEED_LIMIT + 20; i += 1) {
            state = play(state);
        }
        expect(state.feed.length).toBe(FEED_LIMIT);
    });
});
