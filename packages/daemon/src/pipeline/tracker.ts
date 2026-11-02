// Glue between `session.yaml` and the pure stage derivation: builds `PipelineFacts` from a
// session, applies freshly collected PR facts to it, re-derives `stage` and `needs_human`,
// and reports transitions. Every function here is pure, so the poller's behaviour (a push
// clears the verify tick, a stage change is a transition) is testable with no GitHub and no
// disk. The session store writes the file.
import assert from "node:assert/strict";
import type {
    PipelineConfig,
    PipelineFacts,
    PrFacts,
    PullRequest,
    Session,
    Stage,
} from "@spinner/protocol";
import { derive_stage } from "./derive-stage.js";

/** The PRs of a session, with the repo key each belongs to. Repos without a PR are skipped. */
export function session_prs(session: Session): PrFacts[] {
    const prs: PrFacts[] = [];
    for (const [repo, entry] of Object.entries(session.repos)) {
        if (entry.pr !== undefined && entry.pr !== null) {
            prs.push({ repo, ...entry.pr });
        }
    }
    return prs;
}

export function facts_from_session(
    session: Session,
    config: PipelineConfig,
    now: Date,
): PipelineFacts {
    return {
        now: now.toISOString(),
        has_commits: Object.values(session.repos).some((repo) => repo.changed),
        closed: false,
        prs: session_prs(session),
        pipeline: session.pipeline ?? { verified_locally: false, slack_post: null },
        bots_expected: config.github.bot_logins.length > 0,
        stale_after_hours: config.threads.stale_after_hours,
        diff_waiting: (session.diff?.threads ?? []).filter((t) => t.waiting_on === "human"),
    };
}

/**
 * Pure: a copy of the session with the new facts for one repo's PR. When the head moved
 * since the operator's tick, `verified_locally` is cleared so the board asks again for what
 * ships. The repo must exist; adopt creates it before the first poll.
 */
export function apply_pr_facts(session: Session, repo: string, pr: PullRequest): Session {
    const entry = session.repos[repo];
    assert.ok(entry !== undefined, `session ${session.id} has no repo "${repo}"`);
    const next: Session = structuredClone(session);
    const next_entry = next.repos[repo];
    assert.ok(next_entry !== undefined);
    next_entry.pr = pr;
    next_entry.changed = true;
    const pipeline = next.pipeline ?? { verified_locally: false, slack_post: null };
    const verified_head = pipeline.verified_heads?.[repo];
    if (pipeline.verified_locally && verified_head !== undefined && verified_head !== pr.head) {
        pipeline.verified_locally = false;
    }
    next.pipeline = pipeline;
    return next;
}

export interface Transition {
    from: Stage;
    to: Stage;
    /** Repo and PR of a queue-state change, for example `backend#412 queued → popped`. */
    queue_changes: string[];
}

export interface RefreshResult {
    session: Session;
    /** Present when the stage or a PR's queue state differs from `previous`. */
    transition: Transition | null;
}

/**
 * Pure: re-derives `stage` and `needs_human` and reports whether anything the operator must
 * hear about changed. A merge-queue pop-out keeps the stage at `queued`, so queue changes
 * count as transitions too; a plain poll with the same facts is not one.
 */
export function refresh_session(
    previous: Session,
    session: Session,
    config: PipelineConfig,
    now: Date,
): RefreshResult {
    const result = derive_stage(facts_from_session(session, config, now));
    const next: Session = { ...session, stage: result.stage, needs_human: result.needs_human };
    const queue_changes = queue_diff(previous, next);
    const changed = previous.stage !== next.stage || queue_changes.length > 0;
    const transition = changed ? { from: previous.stage, to: next.stage, queue_changes } : null;
    return { session: next, transition };
}

function queue_diff(previous: Session, next: Session): string[] {
    const changes: string[] = [];
    for (const pr of session_prs(next)) {
        const before = previous.repos[pr.repo]?.pr?.queue ?? "none";
        if (before !== pr.queue) {
            changes.push(`${pr.repo}#${pr.number} ${before} → ${pr.queue}`);
        }
    }
    return changes;
}
