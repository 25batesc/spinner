// `Implement` (docs/designs/talk-change-ship.md, 4.5): attaches a plan of the library to a
// session. The plan's document becomes the session's approved design (a copy under
// `design/approved.md`, the record in `session.yaml`), the MISSION.md Plan is seeded from its
// entries, and the lead is told to build it, one change per step. The session stays on the
// `direct` track. The checks run before any write, as `approve_design` does.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
    APPROVED_COPY,
    DESIGN_APPROVALS_MAX,
    EGM_ARTIFACT_DIR,
    PLANS_REPO,
    scan,
    type DesignApproval,
    type PlanRecord,
    type PlanScan,
    type SeedResult,
    type SessionSummary,
} from "@spinner/protocol";
import { normalized_doc_hash } from "../egm/derive-design.js";
import { seed_checks, seed_log_line, seed_plan } from "../egm/seed-plan.js";
import type { SpinnerHome } from "../home.js";
import { round_of } from "../pipeline/rounds.js";
import { SPEC_AUTHOR, type MissionWriter } from "../store/mission-writer.js";
import { read_session, write_session } from "../store/session-store.js";
import { plan_doc_path, read_plan, with_implementation, write_plan } from "./library.js";

export interface ImplementDeps {
    home: SpinnerHome;
    writer: MissionWriter;
    now?: () => Date;
}

/** Why `Implement` cannot run; the route answers 409 (404 for an unknown plan). */
export class PlanRefusal extends Error {
    constructor(
        message: string,
        readonly status: 404 | 409 = 409,
    ) {
        super(message);
    }
}

/** What `Implement` needs of a plan, read and checked before any write. */
export interface PlanToImplement {
    record: PlanRecord;
    doc_path: string;
    text: string;
    entries: PlanScan;
}

/** Reads the plan and its document. Throws `PlanRefusal` without either. */
export function plan_to_implement(home: SpinnerHome, id: string): PlanToImplement {
    const stored = read_plan(home, id);
    if (stored === null) {
        throw new PlanRefusal(`no plan ${id}`, 404);
    }
    // The lead of the planning session names the plan with `session_title`; that title
    // is the plan's from then on, also after the session is archived.
    const record = with_origin_title(home, stored);
    const doc_path = plan_doc_path(home, record);
    if (doc_path === null) {
        throw new PlanRefusal("the plan has no document yet");
    }
    const text = readFileSync(doc_path, "utf8");
    let entries: PlanScan;
    try {
        entries = scan(text);
    } catch (error) {
        throw new PlanRefusal(error instanceof Error ? error.message : String(error));
    }
    return { record, doc_path, text, entries };
}

/** The record with the title of its planning session, when that session lives; stored. */
function with_origin_title(home: SpinnerHome, record: PlanRecord): PlanRecord {
    if (record.origin === null) {
        return record;
    }
    const origin = read_session(home, record.origin);
    if (!origin.ok || origin.summary.session.kind !== "plan") {
        return record;
    }
    const title = origin.summary.session.title;
    if (title === record.title) {
        return record;
    }
    const renamed = { ...record, title };
    write_plan(home, renamed);
    return renamed;
}

/** Why this session cannot implement the plan, or null. */
export function implement_blocker(summary: SessionSummary, plan: PlanToImplement): string | null {
    const kind = summary.session.kind ?? "session";
    if (kind !== "session") {
        return `${summary.dir} is a ${kind} session; a plan is implemented in a code session`;
    }
    const mission_file = join(summary.path, "MISSION.md");
    if (!existsSync(mission_file)) {
        return `${summary.dir} has no MISSION.md`;
    }
    return seed_checks(readFileSync(mission_file, "utf8"), plan.entries);
}

/**
 * Attaches the plan to the session: the copy, the record, the seeded Plan, the Log lines and
 * the plan's `implementations`. Returns what the seed did. The caller tells the lead.
 */
export async function attach_plan(
    deps: ImplementDeps,
    summary: SessionSummary,
    plan: PlanToImplement,
): Promise<SeedResult> {
    const blocker = implement_blocker(summary, plan);
    if (blocker !== null) {
        throw new PlanRefusal(blocker);
    }
    const now = (deps.now ?? (() => new Date()))();
    const sha256 = normalized_doc_hash(plan.text);
    const sha12 = sha256.slice(0, 12);
    const doc = `${plan.record.id}/${basename(plan.doc_path)}`;
    mkdirSync(join(summary.path, EGM_ARTIFACT_DIR), { recursive: true });
    writeFileSync(join(summary.path, EGM_ARTIFACT_DIR, APPROVED_COPY), plan.text);
    const fresh = read_session(deps.home, summary.dir);
    assert.ok(fresh.ok, `${summary.dir} must read back before the plan is attached`);
    const session = fresh.summary.session;
    const approval: DesignApproval = {
        path: doc,
        repo: PLANS_REPO,
        sha256,
        at: now.toISOString(),
        blockers: 0,
        round: round_of(session),
    };
    const previous = session.design;
    session.design = {
        ...(previous ?? { track: "direct" }),
        doc,
        repo: PLANS_REPO,
        approved: approval,
        approvals: [...(previous?.approvals ?? []), approval].slice(-DESIGN_APPROVALS_MAX),
    };
    delete session.design.changed_after_approval;
    write_session(fresh.summary);
    let counts: ReturnType<typeof seed_plan> | null = null;
    await deps.writer.rewrite(summary.dir, SPEC_AUTHOR, (mission) => {
        counts = seed_plan(mission, plan.entries);
        return counts.mission_text;
    });
    assert.ok(counts !== null, "the rewrite must have run the seed");
    const { added, kept, stale, orphaned } = counts as ReturnType<typeof seed_plan>;
    const seed: SeedResult = { doc_path: doc, sha12, added, kept, stale, orphaned };
    for (const text of [
        `plan attached: ${plan.record.title} (${plan.record.id}, ${sha12})`,
        seed_log_line(doc, seed),
    ]) {
        await deps.writer.write(summary.dir, {
            section: "log",
            mode: "append",
            author: SPEC_AUTHOR,
            text,
        });
    }
    const latest = read_plan(deps.home, plan.record.id) ?? plan.record;
    const implementation = { session: summary.dir, at: now.toISOString(), sha12 };
    write_plan(deps.home, with_implementation(latest, implementation));
    return seed;
}

/** The text the lead gets: what the plan is, where it is, and how to build it. */
export function implement_message(plan: PlanToImplement, seed: SeedResult): string {
    return [
        `Implement the plan "${plan.record.title}": ${plan.doc_path} (sha256 ${seed.sha12}).`,
        "Read it in full first. The MISSION.md Plan holds one item per plan entry",
        `(${seed.added} added, ${seed.kept} kept), each linked to its entry by the \`[n.n]\``,
        "token at the start of the line. Build the entries in order, on the fast path: one",
        "change (`change` `start`) per step or per group of steps that ship together, each",
        "with its own pull request; verify each before you open it. Tick an item with",
        "`mission_plan` tick the moment its entry is done. An entry that cannot be built as",
        "written goes under Open questions with the entry id; do not redesign the plan. Add a",
        "worker with `agent_add` only when two entries can be built at the same time.",
    ].join(" ");
}
