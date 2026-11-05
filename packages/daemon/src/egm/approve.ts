// Design approval (docs/designs/egm-adoption.md, Technical Plan T10, entry 6.2). One click
// pins the doc's normalized hash, copies the doc to `<session>/design/approved.md`, records
// the approval in `session.yaml`, seeds the MISSION.md Plan from the doc's plan entries
// (docs/designs/session-workspace.md, T2 and T4), writes two Log lines, and, with `build`,
// prompts the lead to build the doc's plan. An edit to the doc afterwards invalidates the
// approval (the tracker, 6.6); `clear_approval` removes it. The seed's checks run before any
// write, next to the other refusals, so no approval is recorded that the seed cannot honour.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
    DesignApproval,
    DesignApproveRequest,
    PlanScan,
    SeedResult,
    SessionSummary,
} from "@spinner/protocol";
import {
    APPROVED_COPY,
    CONSOLIDATED_REPORT,
    DESIGN_APPROVALS_MAX,
    EGM_ARTIFACT_DIR,
    LEAD_NAME,
    RESOLVE_REPORT,
    REVIEW_STAGE_REPORTS,
    headings,
    scan,
} from "@spinner/protocol";
import type { AgentManager } from "../agents/manager.js";
import type { SpinnerHome } from "../home.js";
import { round_of } from "../pipeline/rounds.js";
import { SPEC_AUTHOR, type MissionWriter } from "../store/mission-writer.js";
import { read_session, write_session } from "../store/session-store.js";
import { normalized_doc_hash } from "./derive-design.js";
import type { DesignTracker } from "./design.js";
import { seed_checks, seed_log_line, seed_plan } from "./seed-plan.js";

export interface ApproveDeps {
    home: SpinnerHome;
    writer: MissionWriter;
    agents: AgentManager;
    design: DesignTracker;
    now?: () => Date;
}

/** A refusal of step 1 or 2 of T10: the route answers 409 with the message and the count. */
export class ApproveRefusal extends Error {
    constructor(
        message: string,
        readonly blockers: number | null,
    ) {
        super(message);
    }
}

/** The 409 of `approve` with `build` while the lead has no process. */
export const APPROVE_LEAD_NOT_RUNNING =
    "the lead is not running; resume it from its tab, or approve without the build";

/** The reports of the current run whose blockers the approval counts, newest kind first. */
const BLOCKER_REPORTS = [RESOLVE_REPORT, CONSOLIDATED_REPORT, REVIEW_STAGE_REPORTS["9"]];

/** `approve_design`'s result: the session after the record and what the seed did. */
export interface ApproveResult {
    summary: SessionSummary;
    seed: SeedResult;
}

/**
 * T10 steps 1 to 7 with the seed (session-workspace T4). Throws `ApproveRefusal` for each
 * 409. With `build`, a lead without a process is refused before any write, so an approval
 * never stands without its build prompt; the seed's checks refuse before any write too.
 */
export async function approve_design(
    deps: ApproveDeps,
    summary: SessionSummary,
    request: DesignApproveRequest,
): Promise<ApproveResult> {
    const design = summary.session.design;
    if (design?.doc === undefined || design.repo === undefined) {
        throw new ApproveRefusal("no design doc yet", null);
    }
    if (deps.design.view(summary)?.stage === "resolving") {
        throw new ApproveRefusal("the review findings are not resolved yet", null);
    }
    if (design.gate !== undefined) {
        throw new ApproveRefusal("the lead asked a question; answer it first", null);
    }
    const blockers = newest_report_blockers(summary.path);
    if (blockers > 0 && request.blockers_confirmed !== blockers) {
        const message = `The newest review report lists ${blockers} blockers.`;
        throw new ApproveRefusal(message, blockers);
    }
    const doc_path = deps.design.doc_path(summary);
    if (doc_path === null || !existsSync(doc_path)) {
        throw new ApproveRefusal(`the design doc ${design.doc} is missing from the worktree`, null);
    }
    const lead = request.build ? deps.agents.get(summary.dir, LEAD_NAME) : null;
    if (request.build && lead === null) {
        throw new ApproveRefusal(APPROVE_LEAD_NOT_RUNNING, null);
    }
    const read = readFileSync(doc_path, "utf8");
    const entries = scan_for_seed(read);
    const mission = readFileSync(join(summary.path, "MISSION.md"), "utf8");
    const refusal = seed_checks(mission, entries);
    if (refusal !== null) {
        throw new ApproveRefusal(refusal, null);
    }
    // Step 3: the status line. Step 4: the hash and the copy.
    const text = rewrite_status(read);
    writeFileSync(doc_path, text);
    const sha256 = normalized_doc_hash(text);
    mkdirSync(join(summary.path, EGM_ARTIFACT_DIR), { recursive: true });
    writeFileSync(join(summary.path, EGM_ARTIFACT_DIR, APPROVED_COPY), text);
    // Step 5: the record, on a fresh read.
    const now = (deps.now ?? (() => new Date()))();
    const fresh = read_session(deps.home, summary.dir);
    assert.ok(fresh.ok, `${summary.dir} must read back before the approval`);
    const state = fresh.summary.session.design;
    assert.ok(state !== undefined, `${summary.dir} lost its design block`);
    const record: DesignApproval = {
        path: design.doc,
        repo: design.repo,
        sha256,
        at: now.toISOString(),
        blockers,
        round: round_of(fresh.summary.session),
    };
    state.approved = record;
    state.approvals = [...(state.approvals ?? []), record].slice(-DESIGN_APPROVALS_MAX);
    delete state.changed_after_approval;
    write_session(fresh.summary);
    // The seed, after the record (D11). Step 6: the Log lines. Step 7: the build message.
    const sha12 = sha256.slice(0, 12);
    const seed = await seed_mission(deps, summary.dir, design.doc, sha12, entries);
    await deps.writer.write(summary.dir, {
        section: "log",
        mode: "append",
        author: SPEC_AUTHOR,
        text: `design approved: ${design.doc} (${sha12}, ${blockers} listed blockers)`,
    });
    await deps.writer.write(summary.dir, {
        section: "log",
        mode: "append",
        author: SPEC_AUTHOR,
        text: seed_log_line(design.doc, seed),
    });
    if (lead !== null) {
        await lead.prompt(build_message(doc_path, sha256, seed));
    }
    return { summary: fresh.summary, seed };
}

/** The doc's plan scan; a scan past its bounds is a refusal, not a 500. */
function scan_for_seed(text: string): PlanScan {
    try {
        return scan(text);
    } catch (error) {
        throw new ApproveRefusal(error instanceof Error ? error.message : String(error), null);
    }
}

/** Writes the seeded Plan through the writer's chain and returns the counts. */
async function seed_mission(
    deps: ApproveDeps,
    dir: string,
    doc_path: string,
    sha12: string,
    entries: PlanScan,
): Promise<SeedResult> {
    let counts: ReturnType<typeof seed_plan> | null = null;
    await deps.writer.rewrite(dir, SPEC_AUTHOR, (mission) => {
        counts = seed_plan(mission, entries);
        return counts.mission_text;
    });
    assert.ok(counts !== null, "the rewrite must have run the seed");
    const { added, kept, stale, orphaned } = counts as ReturnType<typeof seed_plan>;
    return { doc_path, sha12, added, kept, stale, orphaned };
}

/** Removes `design.approved`, `changed_after_approval` and `approved.md`; keeps the history. */
export function clear_approval(deps: Pick<ApproveDeps, "home">, summary: SessionSummary): void {
    const fresh = read_session(deps.home, summary.dir);
    assert.ok(fresh.ok, `${summary.dir} must exist to clear its approval`);
    const state = fresh.summary.session.design;
    if (state !== undefined) {
        delete state.approved;
        delete state.changed_after_approval;
        write_session(fresh.summary);
    }
    rmSync(join(summary.path, EGM_ARTIFACT_DIR, APPROVED_COPY), { force: true });
}

/** The text the lead gets with `build` (6.2, session-workspace T4 and T10). */
export function build_message(doc_path: string, sha256: string, seed: SeedResult): string {
    const flagged =
        seed.stale.length === 0 && seed.orphaned.length === 0
            ? ""
            : ` Items marked stale (${seed.stale.join(", ") || "none"}) or orphaned (${
                  seed.orphaned.join(", ") || "none"
              }) no longer match the doc: re-point each with mission_plan edit and a new token.`;
    return [
        `The design is approved: ${doc_path} (sha256 ${sha256.slice(0, 12)}).`,
        "Build to its Detailed Implementation Plan.",
        `The MISSION.md Plan holds one item per plan entry (${seed.added} added, ${seed.kept}`,
        "kept), each linked to its entry by the `[n.n]` token at the start of the line; the",
        "token survives mission_plan edit. Assign owners with mission_plan assign. Tick an item",
        "with mission_plan tick the moment its entry is done; an entry's done mark follows its",
        "linked items only. Split an entry with mission_plan add and `entry: \"n.n\"`. A",
        "worker's Roster Doing cell names `#id` so the item reads doing. An entry that cannot",
        "be built as written goes under Open questions with the entry id. Add a worker per",
        "phase with agent_add when the work is parallel; its brief owns that phase's files. A",
        "change to the design invalidates the approval and locks your code writes: edit the",
        `doc, then ask the operator to re-approve; the seed runs again.${flagged}`,
    ].join(" ");
}

/** `* **Status:** …` becomes `* **Status:** Approved`; a doc without the line is unchanged. */
export function rewrite_status(text: string): string {
    return text.replace(/^(\*\s+\*\*Status:\*\*\s*).*$/mu, "$1Approved");
}

/** The blockers that the newest report of the current run lists; 0 without a report. */
export function newest_report_blockers(session_path: string): number {
    for (const name of BLOCKER_REPORTS) {
        const path = join(session_path, EGM_ARTIFACT_DIR, name);
        if (existsSync(path)) {
            return count_listed_blockers(readFileSync(path, "utf8"));
        }
    }
    return 0;
}

const SEVERITY = /\bSeverity:\s*(Blocker|High)\b/iu;
const SECTION = /(🔴|\bBlockers?\b)/iu;
/** A report is EGM's output, not ours; the shared walker throws past this many lines. */
const REPORT_LINES_MAX = 100_000;

/**
 * The blockers a review report lists, from its `##` to `####` headings only (6.2, review v2
 * N-11), read with the shared fence-aware walker (session-workspace D8). Severity mode counts
 * headings with `Severity: Blocker` or `Severity: High`. When it finds none, section mode
 * counts the headings one level below a `🔴` or `Blockers` heading of level 2 or 3, up to the
 * next heading of that level or higher.
 */
export function count_listed_blockers(text: string): number {
    const listed = headings(text, REPORT_LINES_MAX).filter(
        (heading) => heading.level >= 2 && heading.level <= 4,
    );
    const severity = listed.filter((heading) => SEVERITY.test(heading.text)).length;
    if (severity > 0) {
        return severity;
    }
    let section: number | null = null;
    let count = 0;
    for (const heading of listed) {
        if (section !== null && heading.level <= section) {
            section = null;
        }
        if (section === null) {
            if ((heading.level === 2 || heading.level === 3) && SECTION.test(heading.text)) {
                section = heading.level;
            }
            continue;
        }
        if (heading.level === section + 1) {
            count += 1;
        }
    }
    return count;
}
