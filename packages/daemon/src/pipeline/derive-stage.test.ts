// Goal: prove that `derive_stage` implements every row of the stage table in
// docs/SESSION_PROTOCOL.md. Method: build one facts fixture per row from a green baseline PR,
// change only what the row's "Entered when" column names, and assert stage, needs_human and
// stale. Two more tests cover the re-entry arrows: a merge-queue pop-out and a push that
// invalidates the operator's verify tick.
import { describe, expect, it } from "vitest";
import type { PipelineFacts, PrFacts } from "@spinner/protocol";
import { REVIEW_DRAFT_NEEDS_HUMAN } from "@spinner/protocol";
import { derive_stage } from "./derive-stage.js";

const HEAD = "9f3c1e2";

/** An open PR whose checks are green, bot-reviewed, no threads, no reviews, no queue. */
function pr(overrides: Partial<PrFacts> = {}): PrFacts {
    return {
        repo: "backend",
        number: 412,
        url: "https://github.com/acme/acme-backend/pull/412",
        author: "you",
        state: "open",
        head: HEAD,
        checks: "green",
        approval_check: "pending",
        approvals: { required: ["peer"], peer: [], owner: false },
        threads: { bots_open: 0, humans_open: 0, resolved: 0 },
        review: "none",
        bot_reviewed_head: HEAD,
        queue: "none",
        last_activity: "2026-10-26T09:00:00Z",
        ...overrides,
    };
}

function facts(overrides: Partial<PipelineFacts> = {}, prs: PrFacts[] = [pr()]): PipelineFacts {
    return {
        now: "2026-10-26T10:00:00Z",
        has_commits: true,
        closed: false,
        prs,
        pipeline: { verified_locally: false, verified_heads: {}, slack_post: null },
        bots_expected: true,
        stale_after_hours: 3,
        ...overrides,
    };
}

/** Facts in which the operator verified the baseline head. */
function verified(prs: PrFacts[] = [pr()]): PipelineFacts {
    const heads = Object.fromEntries(prs.map((entry) => [entry.repo, entry.head]));
    return facts(
        { pipeline: { verified_locally: true, verified_heads: heads, slack_post: null } },
        prs,
    );
}

describe("derive_stage: diff comments waiting on the operator", () => {
    const thread = (id: number) => ({
        repo: "backend",
        thread: id,
        waiting_on: "human" as const,
        path: "src/app.ts",
        start_line: 4,
        end_line: 4,
    });

    it("is the next action when the pipeline has none, counting the rest", () => {
        const one = derive_stage(facts({ prs: [], diff_waiting: [thread(7)] }));
        expect(one).toEqual({
            stage: "building",
            needs_human: "answer diff comment #7 on backend src/app.ts:4",
            stale: false,
        });
        const two = derive_stage(facts({ prs: [], diff_waiting: [thread(7), thread(9)] }));
        expect(two.needs_human).toBe("answer diff comment #7 on backend src/app.ts:4 and 1 more");
    });

    it("yields to the pipeline's own action", () => {
        const result = derive_stage(facts({ diff_waiting: [thread(7)] }, [pr()]));
        expect(result.needs_human).toBe("verify locally (backend#412)");
    });
});

describe("derive_stage: one row of the stage table per test", () => {
    it("planned: session created, no commits", () => {
        const result = derive_stage(facts({ has_commits: false }, []));
        expect(result).toEqual({ stage: "planned", needs_human: null, stale: false });
    });

    it("building: commits on the branch, no PR", () => {
        expect(derive_stage(facts({}, [])).stage).toBe("building");
    });

    it("building: a draft PR", () => {
        expect(derive_stage(facts({}, [pr({ state: "draft" })])).stage).toBe("building");
    });

    it("bot-review: PR open and the bot has not posted yet", () => {
        const result = derive_stage(facts({}, [pr({ bot_reviewed_head: null })]));
        expect(result).toEqual({ stage: "bot-review", needs_human: null, stale: false });
    });

    it("bot-review: checks still pending", () => {
        expect(derive_stage(facts({}, [pr({ checks: "pending" })])).stage).toBe("bot-review");
    });

    it("bot-review is skipped when no bot logins are configured", () => {
        const result = derive_stage(
            facts({ bots_expected: false }, [pr({ bot_reviewed_head: null })]),
        );
        expect(result.stage).toBe("verifying");
    });

    it("fixing: an open bot thread", () => {
        const threads = { bots_open: 1, humans_open: 0, resolved: 3 };
        expect(derive_stage(facts({}, [pr({ threads })])).stage).toBe("fixing");
    });

    it("fixing: checks red, even after the PR was verified", () => {
        expect(derive_stage(verified([pr({ checks: "red" })])).stage).toBe("fixing");
    });

    it("verifying: no open threads, checks green, head not yet verified", () => {
        const result = derive_stage(facts());
        expect(result).toEqual({
            stage: "verifying",
            needs_human: "verify locally (backend#412)",
            stale: false,
        });
    });

    it("peer-review: verified and no reviewer activity yet", () => {
        const result = derive_stage(verified());
        expect(result).toEqual({ stage: "peer-review", needs_human: null, stale: false });
    });

    it("peer-review marks stale after N quiet hours", () => {
        const quiet = { ...verified(), now: "2026-10-26T12:00:01Z" };
        expect(derive_stage(quiet).stale).toBe(true);
    });

    it("addressing: a human thread open", () => {
        const threads = { bots_open: 0, humans_open: 1, resolved: 3 };
        expect(derive_stage(verified([pr({ threads })])).stage).toBe("addressing");
    });

    it("addressing: changes requested", () => {
        const result = derive_stage(verified([pr({ review: "changes_requested" })]));
        expect(result.stage).toBe("addressing");
    });

    it("approving: threads resolved, checks green, approval check waiting on the peer", () => {
        const approved = pr({
            review: "approved",
            approvals: { required: ["peer"], peer: [], owner: true },
        });
        const result = derive_stage(verified([approved]));
        expect(result).toEqual({ stage: "approving", needs_human: null, stale: false });
    });

    it("approving: owner required, peer approved, owner has not", () => {
        const approvals: PrFacts["approvals"] = {
            required: ["peer", "owner"],
            peer: ["peer-1"],
            owner: false,
        };
        const bot_pr = pr({ author: "devin-ai-integration", review: "approved", approvals });
        const result = derive_stage(verified([bot_pr]));
        expect(result.needs_human).toBe("approve backend#412");
        expect(result.stage).toBe("approving");
    });

    it("approving: the approval check passed and nothing is queued yet", () => {
        const ready = pr({ review: "approved", approval_check: "pass" });
        const result = derive_stage(verified([ready]));
        expect(result).toEqual({
            stage: "approving",
            needs_human: "land backend#412",
            stale: false,
        });
    });

    it("queued: enqueued in the merge queue", () => {
        const queued = pr({ review: "approved", approval_check: "pass", queue: "queued" });
        const result = derive_stage(verified([queued]));
        expect(result).toEqual({ stage: "queued", needs_human: null, stale: false });
    });

    it("merged: every PR merged into base", () => {
        const result = derive_stage(facts({}, [pr({ state: "merged" })]));
        expect(result).toEqual({ stage: "merged", needs_human: "close or reset", stale: false });
    });

    it("closed: torn down and archived", () => {
        expect(derive_stage(facts({ closed: true })).stage).toBe("closed");
    });
});

describe("derive_stage: re-entry arrows", () => {
    it("a merge-queue pop-out stays in queued and names the reason", () => {
        const popped = pr({ queue: "popped", queue_reason: "CI_FAILURE" });
        const result = derive_stage(verified([popped]));
        expect(result).toEqual({
            stage: "queued",
            needs_human: "popped out of queue: CI_FAILURE (backend#412)",
            stale: false,
        });
    });

    it("a new push clears the verify tick: the verified head no longer matches", () => {
        const before = verified();
        expect(derive_stage(before).stage).toBe("peer-review");
        const pushed = { ...before, prs: [pr({ head: "41ab0d7" })] };
        expect(derive_stage(pushed).stage).toBe("verifying");
    });

    it("new bot threads re-enter fixing from approving", () => {
        const threads = { bots_open: 1, humans_open: 0, resolved: 9 };
        const late = pr({ review: "approved", approval_check: "pass", threads });
        expect(derive_stage(verified([late])).stage).toBe("fixing");
    });
});

describe("derive_stage: several PRs", () => {
    it("uses the earliest stage among open PRs and ignores merged ones", () => {
        const admin = pr({ repo: "admin", number: 98, checks: "pending" });
        const web = pr({ repo: "web", number: 7, state: "merged" });
        const result = derive_stage(verified([pr(), admin, web]));
        expect(result.stage).toBe("bot-review");
    });
});

describe("derive_stage: the design stage (2.17, Technical Plan T7)", () => {
    const planned = (design: PipelineFacts["design"]): PipelineFacts =>
        facts({ has_commits: false, design }, []);

    it("before approval, the design's needs wins and the stage stays the pipeline's", () => {
        const result = derive_stage(planned({ stage: "drafted", needs: "review the design" }));
        expect(result).toEqual({
            stage: "planned",
            needs_human: "review the design",
            stale: false,
        });
        // It also wins over the pipeline's own action.
        const verifying = facts({ design: { stage: "design-ready", needs: "approve the design" } });
        expect(derive_stage(verifying)).toMatchObject({
            stage: "verifying",
            needs_human: "approve the design",
        });
    });

    it("before approval, null design needs keeps the pipeline's text", () => {
        expect(derive_stage(planned({ stage: "intake", needs: null })).needs_human).toBeNull();
        const verifying = facts({ design: { stage: "drafting", needs: null } });
        expect(derive_stage(verifying).needs_human).toBe("verify locally (backend#412)");
    });

    it("at approved, the design's needs fills only a null needs_human", () => {
        const gate = { stage: "approved" as const, needs: "answer the lead: Which store?" };
        expect(derive_stage(planned(gate)).needs_human).toBe("answer the lead: Which store?");
        const verifying = derive_stage(facts({ design: gate }));
        expect(verifying.needs_human).toBe("verify locally (backend#412)");
    });

    it("a review draft still wins over the design's needs", () => {
        const both = facts(
            { has_commits: false, review_draft: true, design: { stage: "drafted", needs: "x" } },
            [],
        );
        expect(derive_stage(both).needs_human).toBe(REVIEW_DRAFT_NEEDS_HUMAN);
    });
});
