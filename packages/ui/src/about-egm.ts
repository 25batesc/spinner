// The About EGM block's pure parts (docs/designs/egm-adoption.md, entries 1.36 and 1.37): the
// state line of `GET /egm`, and the reload key that moves when an `egm` job starts or ends.
import type { EgmStatus, Job } from "@spinner/protocol";

/** The state line under the notice; the pi-subagents part shows only when it is missing. */
export function egmLine(status: EgmStatus): string {
    const missing = status.subagents ? "" : " · pi-subagents missing";
    if (status.state === "ready") {
        // A ready home always has a marker. The null check is for the type of `fetched_at`.
        const fetched = status.fetched_at;
        const date = fetched === null ? "" : ` · fetched ${fetched.slice(0, 10)}`;
        return `ready${date}${missing}`;
    }
    if (status.state === "fetching") {
        return `fetching…${missing}`;
    }
    if (status.state === "failed") {
        return `failed: ${status.error ?? "unknown error"}${missing}`;
    }
    return `not fetched${missing}`;
}

/**
 * `egm#<id of the last egm job>#<state of that job>`. The last job is the one started last; a
 * `job.finished` event changes its state, so the key moves and the block loads `GET /egm` again.
 */
export function egmKey(jobs: readonly Job[]): string {
    let last: Job | undefined;
    for (const job of jobs) {
        if (job.action === "egm" && (last === undefined || job.started >= last.started)) {
            last = job;
        }
    }
    return last === undefined ? "egm#none#none" : `egm#${last.id}#${last.state}`;
}
