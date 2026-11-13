// The plans library (docs/designs/talk-change-ship.md, 4.1 to 4.4): `<home>/plans/<id>/`
// holds one plan, its document and `plan.json`. A plan outlives the session it was written
// in. This file reads and writes the records, imports the approved design docs of older
// sessions, and builds the list the Plans view shows. The design tracker writes the document
// (a planning session's designs directory is its plan directory); `implement.ts` attaches a
// plan to a session.
import assert from "node:assert/strict";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
    APPROVED_COPY,
    CONSOLIDATED_REPORT,
    EGM_ARTIFACT_DIR,
    PLANS_REPO,
    scan,
    type PlanImplementation,
    type PlanRecord,
    type PlanSessionView,
    type PlanStatus,
    type PlanView,
    type Session,
    type SessionSummary,
} from "@spinner/protocol";
import { normalized_doc_hash } from "../egm/derive-design.js";
import type { SpinnerHome } from "../home.js";
import { plan_items } from "../egm/seed-plan.js";

/** The record's file in a plan's directory. */
export const PLAN_RECORD = "plan.json";
/** The document's name for an imported design; a planning session's lead names its own. */
export const PLAN_DOC_DEFAULT = "plan.md";
/** The library lists at most this many plans, newest first; a home past it shows the newest. */
export const PLANS_MAX = 500;
/** A plan's `implementations` keeps at most this many; past it the oldest drops. */
export const PLAN_IMPLEMENTATIONS_MAX = 50;

const PLAN_ID = /^[a-z0-9][a-z0-9-]*$/;

export function is_plan_id(id: string): boolean {
    return PLAN_ID.test(id) && id.length <= 120;
}

export function plan_dir(home: SpinnerHome, id: string): string {
    assert.ok(is_plan_id(id), `"${id}" is not a plan id`);
    return join(home.plans, id);
}

/** The plan's record, or null when the directory or the file is absent or unreadable. */
export function read_plan(home: SpinnerHome, id: string): PlanRecord | null {
    if (!is_plan_id(id)) {
        return null;
    }
    const file = join(home.plans, id, PLAN_RECORD);
    if (!existsSync(file)) {
        return null;
    }
    try {
        const record = JSON.parse(readFileSync(file, "utf8")) as PlanRecord;
        return typeof record.id === "string" && Array.isArray(record.implementations)
            ? record
            : null;
    } catch {
        return null;
    }
}

export function write_plan(home: SpinnerHome, record: PlanRecord): void {
    const dir = plan_dir(home, record.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, PLAN_RECORD), `${JSON.stringify(record, null, 4)}\n`);
}

export interface NewPlan {
    id: string;
    title: string;
    project: string | null;
    origin: string | null;
    now: Date;
}

/** Creates the plan's directory and record; an existing record is returned as it is. */
export function ensure_plan(home: SpinnerHome, input: NewPlan): PlanRecord {
    const existing = read_plan(home, input.id);
    if (existing !== null) {
        return existing;
    }
    const at = input.now.toISOString();
    const record: PlanRecord = {
        id: input.id,
        title: input.title,
        created: at,
        updated: at,
        project: input.project,
        doc: null,
        origin: input.origin,
        implementations: [],
    };
    write_plan(home, record);
    return record;
}

/**
 * The absolute path of the plan's document, or null without one: the file the record names,
 * else the one `.md` file in the directory (a lead that wrote it and did not name it yet).
 */
export function plan_doc_path(home: SpinnerHome, record: PlanRecord): string | null {
    const dir = plan_dir(home, record.id);
    if (record.doc !== null) {
        const named = join(dir, record.doc);
        return existsSync(named) ? named : null;
    }
    if (!existsSync(dir)) {
        return null;
    }
    const docs = readdirSync(dir).filter((name) => name.endsWith(".md"));
    const only = docs.length === 1 ? docs[0] : undefined;
    return only === undefined ? null : join(dir, only);
}

/** The record with one more implementation, newest last, bounded. */
export function with_implementation(
    record: PlanRecord,
    implementation: PlanImplementation,
): PlanRecord {
    const others = record.implementations.filter(
        (entry) => entry.session !== implementation.session,
    );
    return {
        ...record,
        updated: implementation.at,
        implementations: [...others, implementation].slice(-PLAN_IMPLEMENTATIONS_MAX),
    };
}

/** Every record of the library, newest first, at most `PLANS_MAX`. */
export function list_plans(home: SpinnerHome): PlanRecord[] {
    if (!existsSync(home.plans)) {
        return [];
    }
    const records: PlanRecord[] = [];
    for (const name of readdirSync(home.plans)) {
        const record = read_plan(home, name);
        if (record !== null) {
            records.push(record);
        }
    }
    records.sort((a, b) => b.created.localeCompare(a.created));
    return records.slice(0, PLANS_MAX);
}

/**
 * Imports the approved design of every session, live or archived, that has one and no plan
 * (4.4): the copy becomes the plan's document and the session its first implementation.
 * Returns the ids imported. A session that cannot be read is skipped.
 */
export function import_designs(home: SpinnerHome, now: Date): string[] {
    const imported: string[] = [];
    for (const root of [home.sessions, home.archive]) {
        if (!existsSync(root)) {
            continue;
        }
        for (const dir of readdirSync(root)) {
            const copy = join(root, dir, EGM_ARTIFACT_DIR, APPROVED_COPY);
            if (!is_plan_id(dir) || !existsSync(copy) || read_plan(home, dir) !== null) {
                continue;
            }
            const session = session_or_null(join(root, dir));
            // A session that implements a plan of the library holds a copy too; it is not
            // a plan of its own.
            if (session === null || session.design?.repo === PLANS_REPO) {
                continue;
            }
            const text = readFileSync(copy, "utf8");
            const at = session.design?.approved?.at ?? statSync(copy).mtime.toISOString();
            mkdirSync(join(home.plans, dir), { recursive: true });
            copyFileSync(copy, join(home.plans, dir, PLAN_DOC_DEFAULT));
            write_plan(home, {
                id: dir,
                title: session.title,
                created: at,
                updated: now.toISOString(),
                project: session.project ?? null,
                doc: PLAN_DOC_DEFAULT,
                origin: dir,
                implementations: [
                    { session: dir, at, sha12: normalized_doc_hash(text).slice(0, 12) },
                ],
            });
            imported.push(dir);
        }
    }
    return imported;
}

function session_or_null(path: string): Session | null {
    const file = join(path, "session.yaml");
    if (!existsSync(file)) {
        return null;
    }
    try {
        const parsed = parse(readFileSync(file, "utf8")) as Session;
        return typeof parsed?.title === "string" ? parsed : null;
    } catch {
        return null;
    }
}

/** The entries of the document's plan section; 0 for a document the scan refuses. */
function entry_ids(doc_path: string | null): string[] {
    if (doc_path === null) {
        return [];
    }
    try {
        return scan(readFileSync(doc_path, "utf8")).entries.map((entry) => entry.id);
    } catch {
        return [];
    }
}

/**
 * How far a session is with the plan: of the entries its MISSION.md Plan links, how many
 * have every linked item ticked.
 */
function progress_of(
    session_path: string,
    ids: readonly string[],
): { done: number; entries: number } {
    const file = join(session_path, "MISSION.md");
    if (!existsSync(file) || ids.length === 0) {
        return { done: 0, entries: 0 };
    }
    const items = plan_items(readFileSync(file, "utf8"));
    let done = 0;
    let entries = 0;
    for (const id of ids) {
        const linked = items.filter((item) => item.entry === id);
        if (linked.length === 0) {
            continue;
        }
        entries += 1;
        done += linked.every((item) => item.checked) ? 1 : 0;
    }
    return { done, entries };
}

/** Pure but for file reads: the plans as the Plans view lists them, newest first. */
export function plan_views(home: SpinnerHome, live: readonly SessionSummary[]): PlanView[] {
    const by_dir = new Map(live.map((summary) => [summary.dir, summary]));
    return list_plans(home).map((record) => {
        const ids = entry_ids(plan_doc_path(home, record));
        const sessions: PlanSessionView[] = record.implementations.map((entry) => {
            const summary = by_dir.get(entry.session);
            const path = summary?.path ?? join(home.archive, entry.session);
            return {
                session: entry.session,
                live: summary !== undefined,
                title: summary?.session.title ?? null,
                ...progress_of(path, ids),
            };
        });
        const origin = record.origin === null ? undefined : by_dir.get(record.origin);
        const planning = origin?.session.kind === "plan" ? origin : undefined;
        const done = sessions.reduce((most, entry) => Math.max(most, entry.done), 0);
        return {
            ...record,
            // The planning session's title is the plan's while it lives: the lead retitles it.
            title: planning?.session.title ?? record.title,
            status: plan_status(ids.length, done, sessions.length, planning),
            entries: ids.length,
            done,
            session: planning?.dir ?? null,
            sessions,
        };
    });
}

/** Pure: the plan's status from its entries, its progress and its planning session. */
export function plan_status(
    entries: number,
    done: number,
    implementations: number,
    planning: SessionSummary | undefined,
): PlanStatus {
    if (entries === 0) {
        return "draft";
    }
    if (implementations > 0) {
        return done >= entries ? "done" : "implementing";
    }
    const reviewed =
        planning !== undefined &&
        existsSync(join(planning.path, EGM_ARTIFACT_DIR, CONSOLIDATED_REPORT));
    return reviewed ? "reviewed" : "drafted";
}
