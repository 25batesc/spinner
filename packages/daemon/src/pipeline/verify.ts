// `spinner verify <session>`: records the operator's local test as the gate before peer
// review. The tick names the head SHA per repo, so a later push is detectable and clears it
// (see `apply_pr_facts`). The stage is re-derived at once, so `spinner board` shows
// peer-review without waiting for the next poll. A session without a PR can be verified too
// (s003 Contracts, 13:49): the tick then records each worktree's head.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PipelineConfig, Session, SessionSummary } from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";
import { read_session, write_session } from "../store/session-store.js";
import { refresh_session, session_prs } from "./tracker.js";

export interface VerifyInput {
    dir: string;
    /** Who ticked; the local user name by default. */
    by: string;
    config: PipelineConfig;
    now?: () => Date;
}

/**
 * Pure: the session with the tick recorded for every PR it currently has, or, before any PR
 * exists, for every worktree head in `worktree_heads` (repo key to SHA).
 */
export function record_verify(
    session: Session,
    by: string,
    now: Date,
    worktree_heads: Record<string, string> = {},
): Session {
    assert.ok(by.length > 0, "verify needs a name");
    const prs = session_prs(session);
    const verified_heads =
        prs.length > 0 ? Object.fromEntries(prs.map((pr) => [pr.repo, pr.head])) : worktree_heads;
    const pipeline = session.pipeline ?? { verified_locally: false, slack_post: null };
    return {
        ...session,
        pipeline: {
            ...pipeline,
            verified_locally: true,
            verified_heads,
            verified_at: now.toISOString(),
            verified_by: by,
        },
    };
}

export function verify_session(home: SpinnerHome, input: VerifyInput): SessionSummary {
    const now = input.now ?? (() => new Date());
    const read = read_session(home, input.dir);
    if (!read.ok) {
        throw new Error(read.error);
    }
    const heads = worktree_heads(read.summary);
    const ticked = record_verify(read.summary.session, input.by, now(), heads);
    const refreshed = refresh_session(read.summary.session, ticked, input.config, now());
    write_session({ ...read.summary, session: refreshed.session });
    const check = read_session(home, input.dir);
    assert.ok(check.ok, "a verified session must read back");
    return check.summary;
}

/** The HEAD of each worktree the session has, read with git; repos without one are skipped. */
export function worktree_heads(summary: SessionSummary): Record<string, string> {
    const heads: Record<string, string> = {};
    for (const [repo, entry] of Object.entries(summary.session.repos)) {
        if (entry.worktree === undefined) {
            continue;
        }
        const path = join(summary.path, entry.worktree);
        if (!existsSync(path)) {
            continue;
        }
        const out = execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" });
        heads[repo] = out.trim();
    }
    return heads;
}
