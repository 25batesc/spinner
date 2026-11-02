// The `review` step (MISSION.md s015, Plan item 3): `POST /sessions/:dir/review` starts the
// review swarm (`agents/swarm.ts`) on each open PR of the session, or on the one `pr` names.
// This module holds the pure halves: which PRs a review runs on, and the models from the
// settings. Before s015 the step ran the operator's `review-blast` script; the swarm runs
// the same brief as agents of the session, so the chips, terminals and costs show.
import type { ReviewRequest, SessionSummary, Settings } from "@spinner/protocol";
import { REVIEW_MODELS_DEFAULT, REVIEW_N_DEFAULT } from "@spinner/protocol";

export interface ReviewTarget {
    /** Repo key of `session.repos`. */
    key: string;
    number: number;
    url: string;
}

/**
 * The PRs a review runs on: every open or draft PR of the session, or the one `pr` names.
 * Throws when the session has none, or when `pr` names a repo without an open PR.
 */
export function review_targets(summary: SessionSummary, input: ReviewRequest): ReviewTarget[] {
    const open: ReviewTarget[] = [];
    for (const [key, repo] of Object.entries(summary.session.repos)) {
        const pr = repo.pr;
        if (pr === null || pr === undefined) {
            continue;
        }
        if (pr.state !== "open" && pr.state !== "draft") {
            continue;
        }
        open.push({ key, number: pr.number, url: pr.url });
    }
    if (input.pr !== undefined) {
        const one = open.filter((target) => target.key === input.pr);
        if (one.length === 0) {
            throw new Error(`${summary.dir} has no open PR for repo "${input.pr}"`);
        }
        return one;
    }
    if (open.length === 0) {
        throw new Error(`${summary.dir} has no open PR to review`);
    }
    return open;
}

/** The models and the count from the settings, else the defaults. */
export function review_settings(settings: Settings): { models: readonly string[]; n: number } {
    return {
        models: settings.review?.models ?? REVIEW_MODELS_DEFAULT,
        n: settings.review?.n ?? REVIEW_N_DEFAULT,
    };
}
