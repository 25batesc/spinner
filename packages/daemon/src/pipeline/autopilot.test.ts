// The autopilot's pure step (docs/designs/talk-change-ship.md, 1.5). Method: a session with
// one open pull request and hand-built thread views; each case changes one fact (the checks,
// the head, a thread) and reads the message and the next state.
import { describe, expect, it } from "vitest";
import {
    AUTOPILOT_RED_MAX,
    SESSION_VERSION,
    type AutopilotState,
    type CheckState,
    type PrThreadsView,
    type Session,
    type ThreadView,
} from "@spinner/protocol";
import { autopilot_step, baseline_autopilot, empty_autopilot } from "./autopilot.js";

function session_with(checks: CheckState, head: string, failing: string[] = []): Session {
    return {
        version: SESSION_VERSION,
        id: "s7",
        slug: "refunds",
        title: "Refunds",
        created: "2026-11-12T00:00:00Z",
        stage: "bot-review",
        needs_human: null,
        branch: "feat/refunds",
        base: "main",
        repos: {
            backend: {
                path: "/code/backend",
                changed: true,
                pr: {
                    number: 12,
                    url: "https://github.com/acme/backend/pull/12",
                    author: "owner-1",
                    state: "open",
                    head,
                    checks,
                    checks_failing: failing,
                } as never,
            },
        },
        stack: { state: "none" },
        agents: {},
    };
}

function thread(id: string, patch: Partial<ThreadView> = {}): ThreadView {
    return {
        id,
        label: `T${id.slice(-1)}`,
        state: "open",
        outdated: false,
        author: "reviewer-1",
        author_kind: "human",
        path: "src/a.ts",
        line: 3,
        body: "why?",
        replies: [],
        replied: false,
        flagged: null,
        ...patch,
    };
}

function view(threads: ThreadView[]): PrThreadsView {
    return {
        repo: "backend",
        number: 12,
        url: "https://github.com/acme/backend/pull/12",
        head: "aaaaaaa1",
        checks: "pending",
        review: "none",
        open_bot: 0,
        open_human: threads.length,
        resolved: 0,
        flagged: 0,
        threads,
        file: "threads/backend-12.md",
    };
}

describe("autopilot_step", () => {
    it("says nothing while checks are pending or green and no thread is new", () => {
        const empty = empty_autopilot();
        expect(autopilot_step(session_with("pending", "aaaaaaa1"), [], empty).message).toBeNull();
        const green = autopilot_step(session_with("green", "aaaaaaa1"), [view([])], empty);
        expect(green).toEqual({ message: null, state: empty, stopped: [] });
    });

    it("tells red checks once per head, names the failing checks, resets on green", () => {
        const red = session_with("red", "aaaaaaa1", ["test", "lint"]);
        const first = autopilot_step(red, [], empty_autopilot());
        expect(first.message).toContain("Checks failed on backend#12 at aaaaaaa");
        expect(first.message).toContain("Failing: test, lint.");
        expect(first.message).toContain("Do not wait for the operator");
        expect(first.state.red).toEqual({ backend: { head: "aaaaaaa1", rounds: 1 } });
        // The same head again: told already.
        expect(autopilot_step(red, [], first.state).message).toBeNull();
        // A new red head: told, second round.
        const second = autopilot_step(session_with("red", "bbbbbbb2"), [], first.state);
        expect(second.message).toContain("at bbbbbbb");
        expect(second.state.red["backend"]).toEqual({ head: "bbbbbbb2", rounds: 2 });
        // Green: the count starts over.
        const green = autopilot_step(session_with("green", "ccccccc3"), [], second.state);
        expect(green.state.red).toEqual({});
    });

    it("stops after the cap of red heads in a row and says so to the operator", () => {
        let state: AutopilotState = empty_autopilot();
        for (let round = 1; round <= AUTOPILOT_RED_MAX; round += 1) {
            const step = autopilot_step(session_with("red", `head000${round}`), [], state);
            expect(step.message, `round ${round}`).not.toBeNull();
            expect(step.stopped).toEqual([]);
            if (round === AUTOPILOT_RED_MAX) {
                expect(step.message).toContain(`red head ${AUTOPILOT_RED_MAX} in a row`);
            }
            state = step.state;
        }
        const over = autopilot_step(session_with("red", "head0009"), [], state);
        expect(over.message).toBeNull();
        expect(over.stopped).toEqual([
            `backend#12: checks red at ${AUTOPILOT_RED_MAX} heads in a row`,
        ]);
        // Told once: the same head again neither tells nor reports.
        expect(autopilot_step(session_with("red", "head0009"), [], over.state).stopped).toEqual([]);
    });

    it("tells new open threads once; flagged and resolved ones are left out", () => {
        const threads = [
            thread("PRRT_1"),
            thread("PRRT_2", { author_kind: "bot", author: "bot[bot]" }),
            thread("PRRT_3", { flagged: "a product call" }),
            thread("PRRT_4", { state: "resolved" }),
        ];
        const step = autopilot_step(session_with("pending", "aaaaaaa1"), [view(threads)], {
            red: {},
            threads: [],
        });
        expect(step.message).toContain("2 new review thread(s) on backend#12: T1, T2.");
        expect(step.message).toContain("threads/backend-12.md");
        expect(step.state.threads).toEqual(["PRRT_1", "PRRT_2"]);
        const session = session_with("pending", "aaaaaaa1");
        const again = autopilot_step(session, [view(threads)], step.state);
        expect(again.message).toBeNull();
        const more = [...threads, thread("PRRT_5")];
        const next = autopilot_step(session, [view(more)], step.state);
        expect(next.message).toContain("1 new review thread(s) on backend#12: T5.");
    });

    it("the baseline records what stands, so history is never sent", () => {
        const red = session_with("red", "aaaaaaa1");
        const base = baseline_autopilot(red, [view([thread("PRRT_1"), thread("PRRT_2")])]);
        expect(base).toEqual({
            red: { backend: { head: "aaaaaaa1", rounds: 1 } },
            threads: ["PRRT_1", "PRRT_2"],
        });
        const views = [view([thread("PRRT_1"), thread("PRRT_2")])];
        expect(autopilot_step(red, views, base).message).toBeNull();
    });
});
