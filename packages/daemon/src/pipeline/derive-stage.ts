// The pure function from collected facts to `stage`, `needs_human` and `stale`. It implements
// the stage table in docs/SESSION_PROTOCOL.md, section "Lifecycle and pipeline stages". The
// daemon writes its result into `session.yaml`; nobody sets a stage by hand. A session with
// several PRs is at the earliest stage of its open PRs. No input comes from the network, so
// one fixture per table row proves the table.
import assert from "node:assert/strict";
import type { NeedsHuman, PipelineFacts, PrFacts, Stage, StageResult } from "@spinner/protocol";
import { STAGES, diff_needs_human } from "@spinner/protocol";

/** Upper bound on PRs per session. A session spans a handful of repos, never hundreds. */
const PRS_MAX = 100;

export function derive_stage(facts: PipelineFacts): StageResult {
    assert.ok(facts.prs.length <= PRS_MAX, `more than ${PRS_MAX} PRs in one session`);
    assert.ok(facts.stale_after_hours > 0, "stale_after_hours must be positive");
    return with_diff_comments(facts, derive_pipeline(facts));
}

/**
 * A diff comment thread waiting on the operator is the next action when the pipeline itself
 * has none (MISSION.md s012, Contracts: the pipeline's own `needs_human` wins).
 */
function with_diff_comments(facts: PipelineFacts, result: StageResult): StageResult {
    const waiting = facts.diff_waiting ?? [];
    const first = waiting[0];
    if (first === undefined || result.needs_human !== null || result.stage === "closed") {
        return result;
    }
    return { ...result, needs_human: diff_needs_human(waiting.length, first) };
}

function derive_pipeline(facts: PipelineFacts): StageResult {
    if (facts.closed) {
        return { stage: "closed", needs_human: null, stale: false };
    }
    if (!facts.has_commits && facts.prs.length === 0) {
        return { stage: "planned", needs_human: null, stale: false };
    }
    const open = facts.prs.filter((pr) => pr.state !== "merged" && pr.state !== "closed");
    if (facts.prs.length > 0 && open.length === 0) {
        const all_merged = facts.prs.every((pr) => pr.state === "merged");
        if (all_merged) {
            return { stage: "merged", needs_human: "close or reset", stale: false };
        }
    }
    if (open.length === 0) {
        return { stage: "building", needs_human: null, stale: false };
    }
    const results = open.map((pr) => with_flags(pr, derive_pr(pr, facts)));
    const result = earliest(results);
    assert.ok(STAGES.includes(result.stage));
    return result;
}

/** The stage of one open PR, with the action it waits on. */
function derive_pr(pr: PrFacts, facts: PipelineFacts): StageResult {
    const ref = `${pr.repo}#${pr.number}`;
    if (pr.state === "draft") {
        return { stage: "building", needs_human: null, stale: false };
    }
    if (pr.queue === "popped") {
        const reason = pr.queue_reason ?? "unknown reason";
        const needs_human = `popped out of queue: ${reason} (${ref})`;
        return { stage: "queued", needs_human, stale: false };
    }
    if (pr.queue === "queued" || pr.queue === "merging") {
        return { stage: "queued", needs_human: null, stale: false };
    }
    // Bot threads and red checks win at every later stage: bots re-review after pushes, and a
    // red check needs a fix no matter where the PR was.
    if (pr.threads.bots_open > 0 || pr.checks === "red") {
        return { stage: "fixing", needs_human: null, stale: false };
    }
    const bot_pending = facts.bots_expected && pr.bot_reviewed_head === null;
    if (bot_pending || pr.checks === "pending") {
        return { stage: "bot-review", needs_human: null, stale: false };
    }
    assert.equal(pr.checks, "green");
    if (!is_verified(pr, facts)) {
        return { stage: "verifying", needs_human: `verify locally (${ref})`, stale: false };
    }
    if (pr.threads.humans_open > 0 || pr.review === "changes_requested") {
        return { stage: "addressing", needs_human: null, stale: false };
    }
    if (!has_reviewer_activity(pr)) {
        return { stage: "peer-review", needs_human: null, stale: is_stale(pr, facts) };
    }
    if (pr.approval_check === "pass") {
        return { stage: "approving", needs_human: `land ${ref}`, stale: false };
    }
    return { stage: "approving", needs_human: approving_action(pr), stale: false };
}

/**
 * A thread the fixer flagged is the operator's decision, so it is the next action while the
 * PR is in fixing or addressing and nothing else waits on them.
 */
function with_flags(pr: PrFacts, result: StageResult): StageResult {
    const flagged = pr.threads.flagged ?? 0;
    const in_threads = result.stage === "fixing" || result.stage === "addressing";
    if (flagged === 0 || !in_threads || result.needs_human !== null) {
        return result;
    }
    const noun = flagged === 1 ? "thread" : "threads";
    return { ...result, needs_human: `${flagged} ${noun} flagged on ${pr.repo}#${pr.number}` };
}

/** The operator's tick counts only for the head it was given on. A push invalidates it. */
function is_verified(pr: PrFacts, facts: PipelineFacts): boolean {
    if (!facts.pipeline.verified_locally) {
        return false;
    }
    const heads = facts.pipeline.verified_heads ?? {};
    return heads[pr.repo] === pr.head;
}

/** A reviewer has acted once any human thread exists, a decision is in, or anyone approved. */
function has_reviewer_activity(pr: PrFacts): boolean {
    if (pr.review !== "none") {
        return true;
    }
    if (pr.approvals.peer.length > 0 || pr.approvals.owner) {
        return true;
    }
    return pr.threads.humans_open > 0 || pr.approval_check === "pass";
}

/** Quiet time counts from the later of the PR's and the Slack post's last activity. */
function is_stale(pr: PrFacts, facts: PipelineFacts): boolean {
    const pr_last = Date.parse(pr.last_activity);
    const slack_last = Date.parse(facts.pipeline.slack_activity?.last_activity ?? "");
    const last = Number.isNaN(slack_last) ? pr_last : Math.max(pr_last, slack_last);
    const now = Date.parse(facts.now);
    assert.ok(!Number.isNaN(last), `last_activity "${pr.last_activity}" is not a timestamp`);
    assert.ok(!Number.isNaN(now), `now "${facts.now}" is not a timestamp`);
    const quiet_hours = (now - last) / 3_600_000;
    return quiet_hours >= facts.stale_after_hours;
}

/**
 * In approving, the action is the operator's only when the rule includes the owner, the peer
 * has approved and the owner has not. Everything else waits on the peer.
 */
function approving_action(pr: PrFacts): NeedsHuman {
    const owner_required = pr.approvals.required.includes("owner");
    const peer_required = pr.approvals.required.includes("peer");
    const peer_done = !peer_required || pr.approvals.peer.length > 0;
    if (owner_required && peer_done && !pr.approvals.owner) {
        return `approve ${pr.repo}#${pr.number}`;
    }
    return null;
}

/** The earliest stage wins; its `needs_human` is the first non-null one among the earliest. */
function earliest(results: StageResult[]): StageResult {
    assert.ok(results.length > 0, "earliest() needs at least one result");
    let best: StageResult = results[0] as StageResult;
    for (const result of results.slice(1)) {
        if (stage_index(result.stage) < stage_index(best.stage)) {
            best = result;
        } else if (result.stage === best.stage && best.needs_human === null) {
            const stale = best.stale || result.stale;
            best = { stage: best.stage, needs_human: result.needs_human, stale };
        }
    }
    return best;
}

export function stage_index(stage: Stage): number {
    const index = STAGES.indexOf(stage);
    assert.ok(index >= 0, `unknown stage ${stage}`);
    return index;
}
