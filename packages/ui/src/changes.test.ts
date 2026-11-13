// The Changes rail's pure half. Method: a view with a merged round, a change in review that
// is not checked out, and an empty current change; check the cards, the `+n`, the needs
// line, the actions and the rows of the PRs view.
import { describe, expect, it } from "vitest";
import type { ChangePr, ChangeView, SessionView } from "@spinner/protocol";

import {
    changeActions,
    changeCards,
    checksText,
    diffText,
    opensOnChanges,
    otherChangeNeeds,
    otherOpenChanges,
    prRows,
    stateTone,
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

    it("offers create PR on a building current change, merge and post on an open PR", () => {
        const none = { create: false, merge: false, post: false, test: false };
        const open = { ...none, merge: true, post: true, test: true };
        expect(changeActions(FIRST, true)).toEqual(open);
        // Without a stack there is nothing to test on.
        expect(changeActions(FIRST, false).test).toBe(false);
        const building = change({ current: true, state: "building" });
        expect(changeActions(building, true)).toEqual({ ...none, create: true, test: true });
        const queued = change({ prs: [OPEN_PR], state: "in merge queue" });
        expect(changeActions(queued, true).merge).toBe(false);
        expect(changeActions(ROUND, true)).toEqual(none);
        expect(changeActions(EMPTY, true)).toEqual(none);
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
