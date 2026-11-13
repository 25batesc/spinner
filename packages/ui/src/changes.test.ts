// The PR view's pure half. Method: a view with a merged round, a change in review that is
// not checked out, and an empty current change; check the cards, the `+n`, the needs line,
// the facts and actions of a block, the PR chip and the rows of the PRs view.
import { describe, expect, it } from "vitest";
import type { ChangePr, ChangeView, SessionView } from "@spinner/protocol";

import {
    BUSY,
    changeCards,
    checksText,
    ciMark,
    diffText,
    opensOnChanges,
    otherChangeNeeds,
    otherOpenChanges,
    prActions,
    prChip,
    prFacts,
    prRows,
    stateTone,
    SWITCH_FIRST,
    threadsText,
} from "./changes.ts";

function change(over: Partial<ChangeView>): ChangeView {
    return {
        id: "c1", title: "Parallel exports", branch: "feat/exports", current: false,
        state: "in review", stage: "peer-review", needs_human: null, prs: [], on: null,
        started: "2026-11-12T09:00:00Z", ended: null,
        ...over,
    };
}

const OPEN_PR: ChangePr = {
    repo: "backend", number: 482, url: "https://github.com/acme/backend/pull/482",
    state: "open", checks: "green", threads: { bots_open: 1, humans_open: 1, resolved: 3 },
    diff: { files: 4, additions: 84, deletions: 31 },
};

function view_with(changes: ChangeView[], stack = "down"): SessionView {
    return {
        summary: { dir: "s9-exports", path: "/x", session: { title: "Exports" } },
        kind: "session", board: null, stack: { state: stack }, changes,
    } as unknown as SessionView;
}

const ROUND = change({ id: "r1", state: "merged", prs: [{ ...OPEN_PR, state: "merged" }] });
const FIRST = change({ prs: [OPEN_PR], needs_human: "land backend#482" });
const EMPTY = change({ id: "c2", title: "Fix the button", current: true, state: "empty" });

describe("the Changes rail", () => {
    it("shows the current change first, then the others, and folds the finished", () => {
        const cards = changeCards(view_with([ROUND, FIRST, EMPTY]));
        expect(cards.open.map((card) => card.id)).toEqual(["c2", "c1"]);
        expect(cards.finished.map((card) => card.id)).toEqual(["r1"]);
        // An empty change that is not the current one says nothing.
        const stale = change({ id: "c3", state: "empty" });
        expect(changeCards(view_with([stale, FIRST])).open.map((c) => c.id)).toEqual(["c1"]);
        expect(changeCards(view_with([])).open).toEqual([]);
    });

    it("counts the other open changes and carries their needs line with the title", () => {
        const view = view_with([ROUND, FIRST, EMPTY]);
        expect(otherOpenChanges(view)).toBe(1);
        expect(otherChangeNeeds(view)).toBe("land backend#482 · Parallel exports");
        expect(otherChangeNeeds(view_with([EMPTY]))).toBeNull();
    });

    it("says a pull request's checks, threads and size in a few words", () => {
        expect(checksText(OPEN_PR)).toBe("✓ checks");
        const red = { ...OPEN_PR, checks: "red" as const, checks_failing: ["lint", "test"] };
        expect(checksText(red)).toBe("✗ checks (lint, test)");
        expect(checksText({ ...OPEN_PR, checks: "pending" })).toBe("… checks");
        expect(checksText({ ...OPEN_PR, state: "merged" })).toBe("");
        expect(threadsText(OPEN_PR)).toBe("2 threads");
        expect(threadsText({ repo: "a", number: 1, url: null, state: "open" })).toBe("");
        expect(diffText(OPEN_PR)).toBe("+84 −31");
        expect(diffText({ repo: "a", number: 1, url: null, state: "merged" })).toBe("");
        expect(stateTone("ready to merge")).toBe("ok");
        expect(stateTone("fixing CI")).toBe("bad");
    });

    it("lays out a pull request's facts, with the gates only while it is open", () => {
        const now = new Date("2026-11-12T10:05:00Z");
        const pr: ChangePr = {
            ...OPEN_PR, head: "0123456789abcdef", checks: "red", checks_failing: ["lint", "e2e"],
            approvals: { required: ["peer", "owner"], peer: ["sam"], owner: false },
            approval_check: "fail", review: "changes_requested", queue: "popped",
            queue_reason: "conflict", last_activity: "2026-11-12T10:00:00Z",
            threads: { bots_open: 1, humans_open: 2, resolved: 3, flagged: 1 },
        };
        expect(prFacts(pr, now).map((fact) => [fact.label, fact.text, fact.tone])).toEqual([
            ["state", "open", "plain"],
            ["CI", "red: lint, e2e", "fail"],
            ["approval", "needs peer + owner · sam approved", "warn"],
            ["approval check", "fail", "fail"],
            ["review", "changes requested", "fail"],
            ["threads", "1 bot · 2 people open · 3 resolved · 1 flagged", "fail"],
            ["merge queue", "popped: conflict", "fail"],
            ["size", "+84 −31 in 4 files", "plain"],
            ["head", "0123456", "plain"],
            ["updated", "5 min ago", "plain"],
        ]);
        const approved = { required: ["peer" as const], peer: ["sam"], owner: false };
        const green = prFacts({ ...OPEN_PR, approvals: approved }, now);
        expect(green.find((fact) => fact.label === "approval")).toMatchObject({
            text: "needs peer · sam approved", tone: "ok",
        });
        // A pending approval check says nothing: without one configured it stays pending.
        expect(green.some((fact) => fact.label === "approval check")).toBe(false);
        // Merged: no gates; a round's bare record has only its state.
        const merged = prFacts({ ...pr, state: "merged" }, now).map((fact) => fact.label);
        expect(merged).toEqual(["state", "threads", "size", "head", "updated"]);
        const bare = prFacts({ repo: "a", number: 1, url: null, state: "merged" }, now);
        expect(bare).toEqual([{ label: "state", text: "merged", tone: "done" }]);
    });

    it("offers each PR action that applies, disabled with the reason it cannot run now", () => {
        const names = (actions: { name: string; reason: string | null }[]) =>
            actions.map((action) => [action.name, action.reason]);
        expect(names(prActions(change({ prs: [OPEN_PR], current: true }), true, false))).toEqual([
            ["test", null], ["review", null], ["fix", null], ["post", null],
            ["approve", null], ["merge", null],
        ]);
        // Not checked out: review and fix need a switch; merge waits on nothing but the queue.
        expect(names(prActions(FIRST, false, true))).toEqual([
            ["review", SWITCH_FIRST], ["fix", SWITCH_FIRST], ["post", BUSY],
            ["approve", BUSY], ["merge", null],
        ]);
        const quiet = { ...OPEN_PR, threads: { bots_open: 0, humans_open: 0, resolved: 3 } };
        const done = change({
            current: true, prs: [quiet], approved: true, state: "in merge queue",
        });
        expect(names(prActions(done, false, false))).toEqual([
            ["review", null], ["fix", "No open review thread to answer."], ["post", null],
            ["approve", "You approved this head already."], ["merge", "It is in the merge queue."],
        ]);
        const building = change({ current: true, state: "building" });
        expect(names(prActions(building, true, false))).toEqual([["test", null], ["create", null]]);
        expect(names(prActions({ ...building, current: false }, false, false))).toEqual([
            ["create", SWITCH_FIRST],
        ]);
        expect(prActions(ROUND, true, false)).toEqual([]);
        expect(prActions(EMPTY, true, false)).toEqual([]);
    });

    it("labels the PR chip by its one number or the count, toned by the worst open PR", () => {
        expect(prChip(view_with([EMPTY]))).toBeNull();
        const one = prChip(view_with([FIRST, EMPTY]));
        expect([one?.label, one?.tone, one?.title]).toEqual([
            "#482", "warn", "backend#482 · open",
        ]);
        const red = change({ id: "c3", prs: [{ ...OPEN_PR, number: 9, checks: "red" }] });
        const many = prChip(view_with([ROUND, FIRST, red]));
        expect([many?.label, many?.tone]).toEqual(["3", "fail"]);
        // The rows follow the PR view: the open changes newest first, then the finished.
        expect(many?.rows.map((row) => [row.change.id, row.pr.number])).toEqual([
            ["c3", 9], ["c1", 482], ["r1", 482],
        ]);
        expect(prChip(view_with([ROUND]))?.tone).toBe("done");
        expect([ciMark(OPEN_PR), ciMark({ ...OPEN_PR, checks: "red" })]).toEqual(["✓", "✗"]);
        expect(ciMark({ ...OPEN_PR, state: "merged" })).toBe("");
    });

    it("lists every pull request across sessions, the ones that need him first", () => {
        const quiet = change({ id: "c1", prs: [{ ...OPEN_PR, number: 9 }] });
        const rows = prRows([
            ["s8-a", view_with([quiet])],
            ["s9-exports", view_with([ROUND, FIRST, EMPTY])],
            ["s7-review", { ...view_with([FIRST]), kind: "review" } as SessionView],
        ]);
        expect(rows.open.map((row) => [row.dir, row.pr.number])).toEqual([
            ["s9-exports", 482],
            ["s8-a", 9],
        ]);
        expect(rows.finished.map((row) => row.change.id)).toEqual(["r1"]);
    });

    it("opens the right pane on the rail when the stack is down and a PR exists", () => {
        expect(opensOnChanges(view_with([FIRST, EMPTY]))).toBe(true);
        expect(opensOnChanges(view_with([FIRST, EMPTY], "up"))).toBe(false);
        expect(opensOnChanges(view_with([EMPTY]))).toBe(false);
    });
});
