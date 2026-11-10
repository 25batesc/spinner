// Tests drive the reducer with API v1 events built on the fixture sessions, so they check what
// a user would see after the stream: which sessions exist, which jobs run, what the feed says.
import type { Job, SessionView, SpinnerEvent } from "@spinner/protocol";
import { describe, expect, it } from "vitest";

import { initialSessions, session, stackView, view } from "../fixture/data.ts";
import { missionView } from "../fixture/mission-view.ts";
import { MISSION } from "../fixture/pipeline.ts";
import {
    FEED_LIMIT,
    initialState,
    reduce,
    revisionsOf,
    runningJob,
    sortedSessions,
    agentWorking,
    agoText,
    type UiState,
} from "./state.ts";

const ts = "2026-10-27T10:00:00Z";
const job: Job = {
    id: "j-1", action: "up", session: "s001-bootstrap", state: "running",
    started: ts, finished: null, log: [], error: null,
};

function apply(state: UiState, ...events: SpinnerEvent[]): UiState {
    return events.reduce((next, event) => reduce(next, { kind: "event", event }), state);
}

const loaded = reduce(initialState, { kind: "snapshot", sessions: initialSessions() });

describe("reduce", () => {
    it("lists the newest session first when the operator spoke to none", () => {
        expect(sortedSessions(loaded).map(([dir]) => dir)).toEqual([
            "s001-bootstrap",
            "s17-refund-flow",
        ]);
    });

    it("the session the operator spoke to last comes before a newer one he never spoke to", () => {
        const [, [quietDir, quiet]] = sortedSessions(loaded) as [unknown, [string, SessionView]];
        const older = {
            ...quiet,
            summary: {
                ...quiet.summary,
                session: {
                    ...quiet.summary.session,
                    created: "2020-01-01T00:00:00Z",
                    last_interaction: "2027-01-01T00:00:00Z",
                },
            },
        };
        const state: UiState = { ...loaded, sessions: { ...loaded.sessions, [quietDir]: older } };
        // Created long ago, but spoken to last: it leads, needs-you or not.
        const order = sortedSessions(state).map(([dir]) => dir);
        expect(order[0]).toBe(quietDir);
    });

    it("replaces a session with the view in session.updated and drops it on session.closed", () => {
        const base = session({ id: "s001", slug: "bootstrap", title: "Boot", stage: "verifying" });
        const next = view("s001-bootstrap", base, stackView("s001", "up"));
        const update: SpinnerEvent = {
            type: "session.updated", ts, session: "s001-bootstrap", data: next,
        };
        let state = apply(loaded, update);
        expect(state.sessions["s001-bootstrap"]?.stack.state).toBe("up");
        state = apply(state, { type: "session.closed", ts, session: "s001-bootstrap" });
        expect(Object.keys(state.sessions)).toEqual(["s17-refund-flow"]);
    });

    it("counts mission and threads events per session so views reload", () => {
        const state = apply(
            loaded,
            { type: "mission.changed", ts, session: "s17-refund-flow", author: "ui", sections: [] },
            { type: "mission.changed", ts, session: "s17-refund-flow", author: "ui", sections: [] },
            {
                type: "message.delivered", ts, session: "s17-refund-flow",
                file: null, agent: "ui", how: "log",
            },
            {
                type: "comment.updated", ts, session: "s17-refund-flow",
                id: "c1", state: "open", waiting_on: "operator", author: "lead",
            },
        );
        expect(revisionsOf(state, "s17-refund-flow")).toEqual({
            mission: 2, threads: 0, pipeline: 0, inbox: 1, comments: 1,
        });
        expect(revisionsOf(state, "s001-bootstrap").mission).toBe(0);
    });

    it("tracks a job from started through log lines to finished", () => {
        let state = apply(
            loaded,
            { type: "job.started", ts, session: job.session, job: job.id, data: job },
            { type: "job.log", ts, session: job.session, job: job.id, line: "starting" },
        );
        expect(runningJob(state, "s001-bootstrap")?.log).toEqual(["starting"]);
        expect(runningJob(state, "s17-refund-flow")).toBeUndefined();
        state = apply(state, {
            type: "job.finished", ts, session: job.session, job: job.id, ok: true,
            data: { ...job, state: "ok", log: ["starting"] },
        });
        expect(runningJob(state, "s001-bootstrap")).toBeUndefined();
        expect(state.jobs["j-1"]?.state).toBe("ok");
    });

    it("keeps null-session job events out of the feed", () => {
        const adopt: Job = { ...job, id: "j-2", action: "adopt", session: null };
        const state = apply(loaded, {
            type: "job.started", ts, session: null, job: "j-2", data: adopt,
        });
        expect(state.feed).toEqual([]);
        expect(state.jobs["j-2"]?.session).toBeNull();
    });

    it("does not let a snapshot overwrite a session the stream already updated", () => {
        const base = session({ id: "s001", slug: "bootstrap", title: "Boot" });
        const next = view("s001-bootstrap", base, stackView("s001", "up"));
        const streamed = apply(loaded, {
            type: "session.updated", ts, session: "s001-bootstrap", data: next,
        });
        const again = reduce(streamed, { kind: "snapshot", sessions: initialSessions() });
        expect(again.sessions["s001-bootstrap"]?.stack.state).toBe("up");
    });

    it("bounds the feed and keeps raw agent output out of it", () => {
        let state = loaded;
        const event: SpinnerEvent = {
            type: "pipeline.transition", ts, session: "s17-refund-flow",
            from: "peer-review", to: "addressing", why: "A human left 2 threads",
        };
        for (let i = 0; i < FEED_LIMIT + 20; i += 1) {
            state = apply(state, event);
        }
        expect(state.feed.length).toBe(FEED_LIMIT);
        expect(state.feed[0]?.text).toBe("peer-review \u2192 addressing: A human left 2 threads");
    });

    it("follows the costs event: the figures move and a changed session gets its cost", () => {
        const totals = (usd: number) => ({ usd, tokens_in: 100, tokens_out: 10 });
        const changed = { ...totals(9.5), agents: { backend: { ...totals(9.5), model: "m" } } };
        const state = apply(loaded, {
            type: "costs", ts, session: null,
            today: totals(1), week: totals(2), month: totals(3),
            changed: { "s17-refund-flow": changed, "gone": changed },
        });
        expect(state.costs?.today.usd).toBe(1);
        expect(state.costs?.month.usd).toBe(3);
        expect(state.costs?.revision).toBe(1);
        expect(state.sessions["s17-refund-flow"]?.cost?.usd).toBe(9.5);
        expect(state.sessions["gone"]).toBeUndefined();
        expect(state.feed).toEqual(loaded.feed);
        const again = apply(state, {
            type: "costs", ts, session: null,
            today: totals(1.5), week: totals(2), month: totals(3), changed: {},
        });
        expect(again.costs?.revision).toBe(2);
        expect(again.costs?.today.usd).toBe(1.5);
    });

    it("keeps the structured mission from mission.changed and moves the revision", () => {
        const parsed = missionView(MISSION);
        const state = apply(loaded, {
            type: "mission.changed", ts, session: "s17-refund-flow", author: "backend",
            sections: ["plan"], view: parsed,
        });
        expect(state.missions["s17-refund-flow"]).toBe(parsed);
        expect(revisionsOf(state, "s17-refund-flow").mission).toBe(1);
        // An older daemon sends no view: the workspace loads the route instead.
        const bare = apply(loaded, {
            type: "mission.changed", ts, session: "s17-refund-flow", author: "backend",
            sections: ["plan"],
        });
        expect(bare.missions).toEqual({});
        expect(revisionsOf(bare, "s17-refund-flow").mission).toBe(1);
    });
});

describe("agentWorking and agoText", () => {
    it("reads a running agent and words the time since the last interaction", () => {
        const fixture = loaded.sessions["s17-refund-flow"]!;
        // The fixture's refund session has a running agent; the same with every agent idle:
        const idleAgents = Object.fromEntries(
            Object.entries(fixture.summary.session.agents ?? {}).map(([name, agent]) => [
                name,
                { ...agent, process: "idle" as const },
            ]),
        );
        const view = {
            ...fixture,
            summary: {
                ...fixture.summary,
                session: { ...fixture.summary.session, agents: idleAgents },
            },
        };
        const running = {
            ...view,
            summary: {
                ...view.summary,
                session: {
                    ...view.summary.session,
                    agents: {
                        lead: { harness: "tty" as const, model: "m", process: "running" as const },
                    },
                },
            },
        };
        expect(agentWorking(view)).toBe(false);
        expect(agentWorking(running)).toBe(true);
        const now = new Date("2026-11-09T12:00:00Z");
        expect(agoText(undefined, now)).toBeNull();
        expect(agoText("not a date", now)).toBeNull();
        expect(agoText("2026-11-09T11:59:40Z", now)).toBe("just now");
        expect(agoText("2026-11-09T11:55:00Z", now)).toBe("5 min ago");
        expect(agoText("2026-11-09T09:00:00Z", now)).toBe("3 h ago");
        expect(agoText("2026-11-07T11:00:00Z", now)).toBe("2 d ago");
    });
});
