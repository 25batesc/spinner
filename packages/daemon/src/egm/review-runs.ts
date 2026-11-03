// The review-run archive (docs/designs/egm-adoption.md, Technical Plan T7, entry 3.8). The
// current review run is the set of report files directly in `<session>/design/`. Before the
// app starts `egm-review` or `egm-review-loop`, the reports of the earlier run move into
// `<session>/design/reviews/<id>/`, so each run keeps its own reports and the stage reads
// only the new run. Ids are `r1`, `r2`, …; a new run never takes the id of an archived one.
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { DesignReviewRun } from "@spinner/protocol";
import {
    EGM_ARTIFACT_DIR,
    REVIEW_ARCHIVE_DIR,
    REVIEW_REPORT_FILES,
    REVIEW_RUNS_MAX,
} from "@spinner/protocol";

const RUN_ID = /^r(\d{1,2})$/;

export interface ArchiveResult {
    /** The id the earlier run's reports moved under, or null when no report moved. */
    archived: string | null;
    /** The id of the run that starts now. */
    next: string;
}

/** The number of an id `r<n>`, or 0 for null or another name. */
function run_number(id: string | null): number {
    const match = id === null ? null : RUN_ID.exec(id);
    return match === null ? 0 : Number(match[1]);
}

/**
 * Moves the current run's reports into `reviews/<target>/` and returns the id of the next
 * run. The target is `current.id` when a run is recorded, else one past the highest archived
 * id. Throws before any move when the target directory exists or the next id passes
 * `REVIEW_RUNS_MAX`.
 */
export function archive_review_run(
    session_path: string,
    current: DesignReviewRun | null,
): ArchiveResult {
    const design = join(session_path, EGM_ARTIFACT_DIR);
    const archive = join(design, REVIEW_ARCHIVE_DIR);
    const archived_ids = existsSync(archive)
        ? readdirSync(archive, { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .map((entry) => run_number(entry.name))
        : [];
    const highest = Math.max(0, ...archived_ids);
    const current_number = current === null ? 0 : run_number(current.id);
    const reports = REVIEW_REPORT_FILES.filter((name) => existsSync(join(design, name)));
    const target =
        reports.length === 0
            ? null
            : (current?.id ?? `r${Math.max(highest, current_number) + 1}`);
    const next_number = Math.max(highest, current_number, run_number(target)) + 1;
    if (next_number > REVIEW_RUNS_MAX) {
        throw new Error(
            `${REVIEW_RUNS_MAX} review runs are archived; move ${archive} aside by hand`,
        );
    }
    if (target !== null) {
        const directory = join(archive, target);
        if (existsSync(directory)) {
            throw new Error(`${directory} already exists`);
        }
        mkdirSync(directory, { recursive: true });
        for (const name of reports) {
            renameSync(join(design, name), join(directory, name));
        }
    }
    return { archived: target, next: `r${next_number}` };
}
