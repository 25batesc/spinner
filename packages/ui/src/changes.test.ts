// The PR view's pure half. Method: a view with a merged round, a change in review that is
// not checked out, and an empty current change; check the cards, the `+n`, the needs line,
// the facts and actions of a block, the PR chip, the rows of the PRs view and the PR table.
import { describe, expect, it } from "vitest";
import type { ChangePr, ChangeView, SessionView } from "@spinner/protocol";

import {
    BUSY,
    changeCards,
    changeStatus,
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
    groupStatus,
    prTableGroups,
    prTableRows,
    startRow,
    ticketUnits,
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

describe("the groups of the PR table", () => {
    const NEEDS_PEER = { required: ["peer" as const], peer: [] as string[], owner: false };
    const pr = (over: Partial<ChangePr>): ChangePr => ({
        ...OPEN_PR, threads: { bots_open: 0, humans_open: 0, resolved: 0 }, review: "none",
        approvals: NEEDS_PEER, ...over,
    });
    const waiting = change({ id: "c22", state: "PR open", stage: "verifying", prs: [pr({})],
        needs_human: "verify locally (backend#5974)", group: "g1" });
    const draft = change({ id: "c15", state: "PR open", stage: "building",
        prs: [pr({ state: "draft", number: 5919 })], group: "g2" });
    const reviewing = change({ id: "c7", state: "in review", stage: "peer-review",
        prs: [pr({ number: 985 })], group: "g1" });
    const loose = change({ id: "c9", state: "fixing CI",
        prs: [pr({ checks: "red", checks_failing: ["Lint"], number: 7 })] });

    it("says where a change stands in the operator's words", () => {
        expect(changeStatus(waiting)).toMatchObject({
            text: "needs you", tone: "warn", title: "verify locally (backend#5974)",
        });
        // A draft, a pull request that waits on a reviewer and one whose checks fail all
        // read `PR open` or close to it in the daemon's state.
        expect(changeStatus(draft).text).toBe("draft");
        expect(changeStatus(reviewing).text).toBe("needs peer review");
        const failing = { text: "CI failing", tone: "fail", title: "Lint" };
        expect(changeStatus(loose)).toMatchObject(failing);
        const pending = change({ state: "PR open", prs: [pr({ checks: "pending" })] });
        expect(changeStatus(pending).text).toBe("pending CI");
        const ready = change({ state: "ready to merge", stage: "approving",
            prs: [pr({ review: "approved", approvals: { ...NEEDS_PEER, peer: ["a"] } })] });
        expect(changeStatus(ready)).toMatchObject({ text: "ready to merge", tone: "ok" });
        expect(changeStatus(ROUND)).toMatchObject({ text: "merged", tone: "done" });
    });

    it("puts the open rows under their groups' headlines, the ungrouped last", () => {
        const groups = [
            { id: "g1", name: "Client-ready rule", purpose: "No card without a price" },
            { id: "g2", name: "Past requests", purpose: "",
              hold: { by: "lead", reason: "waits on #5954", at: "2026-11-23T10:00:00Z" } },
        ];
        const view = { ...view_with([reviewing, loose, draft, waiting]), groups } as SessionView;
        const table = prTableGroups(view, new Date("2026-11-23T12:00:00Z"));
        const drawn = table.map((bucket) => [
            bucket.group?.name ?? null,
            bucket.rows.map((row) => row.change.id),
        ]);
        expect(drawn).toEqual([
                ["Client-ready rule", ["c22", "c7"]],
                ["Past requests", ["c15"]],
                [null, ["c9"]],
            ]);
        // A group's one status is its most pressing member's; a hold says so whatever else.
        expect(table[0]?.status).toMatchObject({ text: "needs you" });
        expect(table[1]?.status).toMatchObject({ text: "on hold", title: "waits on #5954 (lead)" });
        // The row keeps its own status in the State column.
        expect(table[1]?.rows[0]?.state.text).toBe("draft");
        expect(groupStatus(groups[0] ?? null, [reviewing])?.text).toBe("needs peer review");
        // Without any group the table is one bucket with no headline.
        const flat = prTableGroups(view_with([reviewing, loose]), new Date());
        expect(flat).toHaveLength(1);
        expect(flat[0]?.group).toBeNull();
    });
});

describe("the Linear tickets of the pull requests", () => {
    const ticket = (number: number, state: string, parent: string | null = null) => ({
        id: `i${number}`, identifier: `GKA-${number}`, title: `ticket ${number}`, state, parent,
        url: `https://linear.app/knit/issue/GKA-${number}`, synced: "",
    });
    const api_url = "https://github.com/acme/api/pull/87";
    const api = { ...OPEN_PR, repo: "api", number: 87, url: api_url };
    const LANDED_URL = "https://github.com/acme/backend/pull/9";
    const both = change({ id: "c1", prs: [OPEN_PR, api], group: "g1" });
    const landed = change({
        id: "c2", state: "merged",
        prs: [{ ...OPEN_PR, number: 9, state: "merged", url: LANDED_URL }],
    });
    const linear = {
        prs: {
            [OPEN_PR.url ?? ""]: ticket(2, "In Review", "GKA-1"),
            [api.url]: ticket(3, "In Progress", "GKA-1"),
            [LANDED_URL]: ticket(4, "In Dev Env"),
        },
        parents: { g1: ticket(1, "In Progress") },
    };
    const base = view_with([landed, both]);
    const session = { ...base.summary.session, linear };
    const view = {
        ...base, summary: { ...base.summary, session },
        groups: [{ id: "g1", name: "Exports", purpose: "Export every list" }],
    } as SessionView;

    it("gives each row of the PR table its ticket, and a group its parent ticket", () => {
        const rows = prTableRows(view, new Date());
        expect(rows.open.map((row) => [row.name, row.ticket?.identifier ?? null])).toEqual([
            ["backend #482", "GKA-2"], ["api #87", "GKA-3"],
        ]);
        expect(rows.finished[0]?.ticket?.identifier).toBe("GKA-4");
        expect(prTableGroups(view, new Date())[0]?.ticket?.identifier).toBe("GKA-1");
        // A session without tickets has none to show.
        expect(prTableRows(view_with([both]), new Date()).open[0]?.ticket).toBeNull();
    });

    it("lists the tickets across sessions by unit of work, the open units first", () => {
        const units = ticketUnits([["s9-exports", view], ["s1-none", view_with([both])]]);
        expect(units.open).toHaveLength(1);
        expect(units.open[0]).toMatchObject({
            dir: "s9-exports", session: "Exports", parent: { identifier: "GKA-1" }, done: false,
        });
        expect(units.open[0]?.rows.map((row) => [
            row.ticket.identifier, row.ticket.state, row.pr?.name, row.pr?.status.text,
        ])).toEqual([
            ["GKA-2", "In Review", "backend #482", "in review"],
            ["GKA-3", "In Progress", "api #87", "in review"],
        ]);
        // A unit whose pull requests all ended is done; its ticket keeps Linear's state.
        const done = units.done.map((unit) => {
            const row = unit.rows[0];
            return [unit.parent, row?.ticket.state, row?.pr?.status.text];
        });
        expect(done).toEqual([[null, "In Dev Env", "merged"]]);
    });
});

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

    it("draws the PR table: a row per pull request or change, its cells, links and detail", () => {
        const now = new Date("2026-11-12T10:16:00Z");
        const api: ChangePr = {
            ...OPEN_PR, repo: "api", number: 87, url: "https://github.com/acme/api/pull/87",
            title: "POST /refunds", author: "sam",
            head: "0123456789abcdef", review: "none", last_activity: "2026-11-12T10:00:00Z",
            approvals: { required: ["peer"], peer: [], owner: false },
            threads: { bots_open: 0, humans_open: 0, resolved: 2 },
        };
        const red: ChangePr = {
            ...OPEN_PR, number: 9, url: "https://github.com/acme/backend/pull/9", checks: "red", checks_failing: ["lint", "e2e"],
            review: "changes_requested",
        };
        const two = change({ prs: [OPEN_PR, api], needs_human: "land backend#482", on: "c0" });
        const fixing = change({ id: "c3", title: "Fix it", state: "fixing CI", prs: [red] });
        const bare = change({ id: "c4", title: "Copy edits", state: "building", current: true });
        const rows = prTableRows(view_with([ROUND, two, fixing, bare]), now);
        expect(rows.open.map((row) => [row.key, row.name, row.title, row.tone])).toEqual([
            ["c4", "no PR", "Copy edits", "idle"],
            ["c3:backend#9", "backend #9", "Fix it", "bad"],
            ["c1:backend#482", "backend #482", "Parallel exports", "idle"],
            ["c1:api#87", "api #87", "POST /refunds", "idle"],
        ]);
        expect(rows.finished.map((row) => [row.key, row.ci, row.review])).toEqual([
            ["r1:backend#482", null, null],
        ]);
        const [none, fail, first, second] = rows.open;
        expect(none?.ci).toBeNull();
        expect(none?.facts.map((fact) => [fact.label, fact.text])).toEqual([
            ["change", "building"], ["branch", "feat/exports"],
        ]);
        const url = "https://github.com/acme/backend/pull/9";
        expect(fail?.ci).toEqual({
            mark: "✗", text: "red", tone: "fail", href: `${url}/checks`, title: "lint, e2e",
        });
        expect(fail?.review).toEqual({ text: "changes requested", tone: "fail" });
        expect(fail?.threads).toMatchObject({ text: "2 open", tone: "warn", href: `${url}/files` });
        // The State column says where the change stands in the operator's words.
        expect(fail?.state).toEqual({ text: "CI failing", tone: "fail", title: "lint, e2e" });
        expect(first?.state).toEqual({
            text: "needs you", tone: "warn", title: "land backend#482",
        });
        expect([first?.ci?.mark, first?.ci?.text, first?.ci?.title]).toEqual([
            "✓", "green", undefined,
        ]);
        expect(first?.size).toEqual({ text: "+84 −31", tone: "plain", title: "4 files" });
        // Nobody reviewed and a required approval is missing: review required.
        expect(second?.review).toEqual({ text: "review required", tone: "warn" });
        expect(second?.threads?.text).toBe("none");
        expect(second?.updated).toEqual({ text: "16 min ago", tone: "plain" });
        const pull = "https://github.com/acme/api/pull/87";
        expect(second?.facts.map((fact) => [fact.label, fact.column, fact.href])).toEqual([
            ["state", undefined, undefined],
            ["CI", "ci", undefined],
            ["approval", undefined, undefined],
            ["review", "review", undefined],
            ["threads", "threads", undefined],
            ["size", "size", undefined],
            ["head", undefined, `${pull}/commits/0123456789abcdef`],
            ["updated", "updated", undefined],
            ["author", undefined, undefined],
            ["change", "state", undefined],
            ["branch", undefined, undefined],
            ["on", undefined, undefined],
        ]);
        // The row that needs him opens first, else the current one, else none.
        expect(startRow(rows.open)).toBe("c1:backend#482");
        expect(startRow(rows.open.filter((row) => row.change.id !== "c1"))).toBe("c4");
        expect(startRow(rows.finished)).toBeNull();
    });
});
