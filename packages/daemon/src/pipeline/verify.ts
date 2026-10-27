// `spinner verify <session>`: records the operator's local test as the gate before peer
// review. The tick names the head SHA per repo, so a later push is detectable and clears it
// (see `apply_pr_facts`). The stage is re-derived at once, so `spinner board` shows
// peer-review without waiting for the next poll.
import assert from "node:assert/strict";
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

/** Pure: the session with the tick recorded for every PR it currently has. */
export function record_verify(session: Session, by: string, now: Date): Session {
    assert.ok(by.length > 0, "verify needs a name");
    const prs = session_prs(session);
    if (prs.length === 0) {
        throw new Error(`session ${session.id} has no PR to verify`);
    }
    const verified_heads = Object.fromEntries(prs.map((pr) => [pr.repo, pr.head]));
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
    const ticked = record_verify(read.summary.session, input.by, now());
    const refreshed = refresh_session(read.summary.session, ticked, input.config, now());
    write_session({ ...read.summary, session: refreshed.session });
    const check = read_session(home, input.dir);
    assert.ok(check.ok, "a verified session must read back");
    return check.summary;
}
