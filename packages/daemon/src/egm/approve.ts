// Design approval (docs/designs/egm-adoption.md, Technical Plan T10, entry 6.2). One click
// pins the doc's normalized hash, copies the doc to `<session>/design/approved.md`, records
// the approval in `session.yaml`, writes a Log line, and, with `build`, prompts the lead to
// build the doc's plan. An edit to the doc afterwards invalidates the approval (the tracker,
// 6.6); `clear_approval` removes it. The daemon does not parse the doc's plan (review B1):
// the build message tells the lead to copy each plan entry into MISSION.md itself.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DesignApproval, DesignApproveRequest, SessionSummary } from "@spinner/protocol";
import {
    APPROVED_COPY,
    CONSOLIDATED_REPORT,
    DESIGN_APPROVALS_MAX,
    EGM_ARTIFACT_DIR,
    LEAD_NAME,
    RESOLVE_REPORT,
    REVIEW_STAGE_REPORTS,
} from "@spinner/protocol";
import type { AgentManager } from "../agents/manager.js";
import type { SpinnerHome } from "../home.js";
import { round_of } from "../pipeline/rounds.js";
import { SPEC_AUTHOR, type MissionWriter } from "../store/mission-writer.js";
import { read_session, write_session } from "../store/session-store.js";
import { normalized_doc_hash } from "./derive-design.js";
import type { DesignTracker } from "./design.js";

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

/**
 * T10 steps 1 to 7. Throws `ApproveRefusal` for each 409. With `build`, a lead without a
 * process is refused before any write, so an approval never stands without its build prompt.
 */
export async function approve_design(
    deps: ApproveDeps,
    summary: SessionSummary,
    request: DesignApproveRequest,
): Promise<SessionSummary> {
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
    // Step 3: the status line. Step 4: the hash and the copy.
    const text = rewrite_status(readFileSync(doc_path, "utf8"));
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
    // Step 6: the Log line. Step 7: the build message.
    const sha12 = sha256.slice(0, 12);
    await deps.writer.write(summary.dir, {
        section: "log",
        mode: "append",
        author: SPEC_AUTHOR,
        text: `design approved: ${design.doc} (${sha12}, ${blockers} listed blockers)`,
    });
    if (lead !== null) {
        await lead.prompt(build_message(doc_path, sha256));
    }
    return fresh.summary;
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

/** The text the lead gets with `build` (6.2), with the absolute doc path. */
export function build_message(doc_path: string, sha256: string): string {
    return [
        `The design is approved: ${doc_path} (sha256 ${sha256.slice(0, 12)}).`,
        "Build to its Detailed Implementation Plan.",
        "First add one MISSION.md Plan item per plan entry (each `##### n.n` heading) with",
        "mission_plan add, in the doc's order. The item text is `plan <id>: <heading text>`",
        "without the trailing `( … )` part, because the Plan reads a trailing parenthesis as",
        "the owner. Tick an item with mission_plan tick the moment its entry is done. Add a",
        "worker per phase with agent_add when the work is parallel; its brief owns that",
        "phase's files. A change to the design invalidates the approval and locks your code",
        "writes: edit the doc, then ask the operator to re-approve.",
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

const HEADING = /^(#{2,4})\s+(.*)$/u;
const SEVERITY = /\bSeverity:\s*(Blocker|High)\b/iu;
const SECTION = /(🔴|\bBlockers?\b)/iu;
const FENCE = "```";
/** Upper bound on lines read from a report. */
const REPORT_LINES_MAX = 100_000;

interface Heading {
    level: number;
    text: string;
}

/**
 * The blockers a review report lists, from its headings only (6.2, review v2 N-11). Severity
 * mode counts headings with `Severity: Blocker` or `Severity: High`. When it finds none,
 * section mode counts the headings one level below a `🔴` or `Blockers` heading of level 2
 * or 3, up to the next heading of that level or higher. Lines inside code fences are skipped.
 */
export function count_listed_blockers(text: string): number {
    const headings = headings_of(text);
    const severity = headings.filter((heading) => SEVERITY.test(heading.text)).length;
    if (severity > 0) {
        return severity;
    }
    let section: number | null = null;
    let count = 0;
    for (const heading of headings) {
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

/** The `##` to `####` headings outside fenced code blocks, in order. */
function headings_of(text: string): Heading[] {
    // A report is EGM's output, not ours: past the bound the rest is not read.
    const lines = text.replace(/\r\n/g, "\n").split("\n").slice(0, REPORT_LINES_MAX);
    const headings: Heading[] = [];
    let fenced = false;
    for (const line of lines) {
        if (line.startsWith(FENCE)) {
            fenced = !fenced;
            continue;
        }
        if (fenced) {
            continue;
        }
        const match = HEADING.exec(line);
        if (match !== null) {
            headings.push({ level: (match[1] ?? "").length, text: match[2] ?? "" });
        }
    }
    return headings;
}
