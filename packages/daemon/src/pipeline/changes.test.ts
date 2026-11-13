// The pure functions of a session's changes. Method: build a session with one pull request,
// start and switch changes on it, and check that the top-level fields and the records swap
// without losing a fact; focus a change, alter it, store it back into a file that moved on.
import { describe, expect, it } from "vitest";
import type { PullRequest, Session } from "@spinner/protocol";
import { SESSION_VERSION } from "@spinner/protocol";
import {
    change_branch,
    change_state,
    changes_view,
    current_change,
    focus_change,
    next_change_id,
    open_change_ids,
    stacked_base,
    start_change,
    store_change,
    switch_change,
} from "./changes.js";

function pr_with(over: Partial<PullRequest>): PullRequest {
    return {
        number: 7,
        url: "https://github.com/acme/app/pull/7",
        author: "owner-1",
        state: "open",
        head: "a".repeat(40),
        checks: "green",
        approval_check: "pending",
        approvals: { required: ["peer"], peer: [], owner: false },
        threads: { bots_open: 0, humans_open: 0, resolved: 0 },
        review: "none",
        bot_reviewed_head: null,
        queue: "none",
        last_activity: "2026-11-12T10:00:00Z",
        ...over,
    };
}

function session_with(pr: PullRequest | null): Session {
    return {
        version: SESSION_VERSION,
        id: "s9",
        slug: "exports",
        title: "Parallel exports",
        created: "2026-11-12T09:00:00Z",
        stage: pr === null ? "planned" : "peer-review",
        needs_human: null,
        branch: "feat/exports",
        base: "main",
        repos: { app: { path: "/code/app", worktree: "worktrees/app", changed: pr !== null, pr } },
        pipeline: {
            verified_locally: true,
            verified_heads: { app: "a".repeat(40) },
            slack_post: "p1",
        },
        stack: { state: "none" },
        agents: {},
    };
}

const SECOND = {
    id: "c2",
    title: "Fix the export button",
    branch: "feat/fix-the-export-button",
    started: "2026-11-12T11:00:00Z",
    keep_current: true,
};

describe("a session's changes", () => {
    it("reads a file from before step 2 as one change, c1", () => {
        const session = session_with(pr_with({}));
        expect(current_change(session)).toEqual({
            id: "c1",
            title: "Parallel exports",
            started: "2026-11-12T09:00:00Z",
        });
        expect(next_change_id(session)).toBe("c2");
        expect(open_change_ids(session)).toEqual(["c1"]);
    });

    it("start puts the current change aside with every fact and leaves an empty one", () => {
        const first = session_with(pr_with({}));
        const next = start_change(first, SECOND);
        expect(next.branch).toBe("feat/fix-the-export-button");
        expect(next.change).toEqual({ id: "c2", title: SECOND.title, started: SECOND.started });
        expect(next.repos["app"]).toMatchObject({ changed: false, pr: null });
        expect(next.pipeline).toEqual({
            verified_locally: false,
            verified_heads: {},
            slack_post: null,
        });
        expect(next.stage).toBe("planned");
        const record = next.changes?.[0];
        expect(record).toMatchObject({ id: "c1", branch: "feat/exports", stage: "peer-review" });
        expect(record?.repos["app"]?.pr?.number).toBe(7);
        expect(record?.pipeline?.slack_post).toBe("p1");
        expect(next_change_id(next)).toBe("c3");
        expect(open_change_ids(next)).toEqual(["c1"]);
    });

    it("start does not keep a current change with no commit and no pull request", () => {
        const next = start_change(session_with(null), { ...SECOND, keep_current: false });
        expect(next.changes).toEqual([]);
        expect(current_change(next).id).toBe("c2");
    });

    it("switch brings a record back and the facts survive the round trip", () => {
        const first = session_with(pr_with({}));
        const second = start_change(first, SECOND);
        const back = switch_change(second, "c1", true);
        expect(back.branch).toBe("feat/exports");
        expect(back.repos["app"]?.pr?.number).toBe(7);
        expect(back.pipeline).toEqual(first.pipeline);
        expect(back.stage).toBe("peer-review");
        expect(back.changes?.map((entry) => entry.id)).toEqual(["c2"]);
        // The empty second change is dropped when it is not kept.
        expect(switch_change(second, "c1", false).changes).toEqual([]);
    });

    it("focus shows a record at the top level, without the session-level facts", () => {
        const second = start_change(session_with(pr_with({})), SECOND);
        second.design = { track: "design" } as Session["design"];
        expect(focus_change(second, "c2")).toBe(second);
        const focused = focus_change(second, "c1");
        expect(focused.branch).toBe("feat/exports");
        expect(focused.repos["app"]?.pr?.number).toBe(7);
        expect(current_change(focused).id).toBe("c1");
        expect(focused.design).toBeUndefined();
        expect(() => focus_change(second, "c9")).toThrow(/no change "c9"/);
    });

    it("store writes only the change's fields, into wherever the change is now", () => {
        const first = session_with(pr_with({}));
        // A job focused on c1 while it was current; it saw the pull request merge.
        const seen: Session = structuredClone(first);
        seen.repos["app"] = { ...first.repos["app"]!, pr: pr_with({ state: "merged" }) };
        seen.stage = "merged";
        seen.agents = { stale: { harness: "tty", model: "m", process: "idle" } };
        // Meanwhile the lead started c2, and an agent joined.
        const disk = start_change(first, SECOND);
        disk.agents = { lead: { harness: "tty", model: "m", process: "running" } };
        const stored = store_change(disk, seen, "c1");
        expect(stored.branch).toBe("feat/fix-the-export-button");
        expect(stored.repos["app"]?.pr).toBeNull();
        expect(Object.keys(stored.agents)).toEqual(["lead"]);
        const record = stored.changes?.[0];
        expect(record).toMatchObject({ id: "c1", branch: "feat/exports", stage: "merged" });
        expect(record?.repos["app"]?.pr?.state).toBe("merged");
        expect(record?.ended).toBe("2026-11-12T10:00:00Z");
        // Stored for the current change, the facts land at the top level.
        const top = store_change(first, seen, "c1");
        expect(top.repos["app"]?.pr?.state).toBe("merged");
        expect(top.stage).toBe("merged");
        expect(top.agents).toEqual({});
        // A change that is gone stores nothing.
        expect(store_change(disk, seen, "c9")).toEqual(disk);
    });

    it("names a branch from the title and never reuses one", () => {
        const first = session_with(pr_with({}));
        expect(change_branch(first, "fix-the-button")).toBe("feat/fix-the-button");
        expect(change_branch(first, "exports")).toBe("feat/exports-2");
        const second = start_change(first, { ...SECOND, branch: "feat/exports-2" });
        expect(change_branch(second, "exports")).toBe("feat/exports-3");
    });

    it("a change started on another opens against its branch while its PR is open", () => {
        const first = session_with(pr_with({}));
        const stacked = start_change(first, { ...SECOND, on: "c1" });
        expect(stacked_base(stacked, "app")).toBe("feat/exports");
        const merged = store_change(stacked, session_merged(first), "c1");
        expect(stacked_base(merged, "app")).toBeNull();
        expect(stacked_base(start_change(first, SECOND), "app")).toBeNull();
    });

    it("says a change's state in plain words", () => {
        expect(change_state("planned", [], false)).toBe("empty");
        expect(change_state("building", [], true)).toBe("building");
        const pr = { repo: "app", ...pr_with({}) };
        expect(change_state("verifying", [pr], true)).toBe("PR open");
        expect(change_state("fixing", [{ ...pr, checks: "red" }], true)).toBe("fixing CI");
        const threads = { bots_open: 0, humans_open: 2, resolved: 0 };
        expect(change_state("addressing", [{ ...pr, threads }], true)).toBe("answering review");
        expect(change_state("peer-review", [pr], true)).toBe("in review");
        expect(change_state("approving", [pr], true)).toBe("ready to merge");
        expect(change_state("queued", [{ ...pr, queue: "queued" }], true)).toBe("in merge queue");
        expect(change_state("merged", [{ ...pr, state: "merged" }], true)).toBe("merged");
        expect(change_state("building", [{ ...pr, state: "closed" }], true)).toBe("closed");
    });

    it("lists rounds, records and the current change, oldest first", () => {
        const second = start_change(session_with(pr_with({})), SECOND);
        const round = {
            round: 1,
            branch: "feat/old",
            prs: [{ repo: "app", number: 3, url: null, state: "merged" as const, merged_at: null }],
            started: null,
            ended: null,
            source: "mission" as const,
        };
        const views = changes_view(second, [round]);
        expect(views.map((view) => [view.id, view.current, view.state])).toEqual([
            ["r1", false, "merged"],
            ["c1", false, "in review"],
            ["c2", true, "empty"],
        ]);
        expect(views[0]?.prs).toEqual([{ repo: "app", number: 3, url: null, state: "merged" }]);
        expect(views[1]?.prs[0]?.number).toBe(7);
    });
});

function session_merged(first: Session): Session {
    const seen: Session = structuredClone(first);
    seen.repos["app"] = { ...first.repos["app"]!, pr: pr_with({ state: "merged" }) };
    seen.stage = "merged";
    return seen;
}
