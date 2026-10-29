// Reads and creates session directories under `<home>/sessions`. This is the only module that
// knows the on-disk layout from docs/SESSION_PROTOCOL.md. The daemon and the CLI both use it,
// and nothing is cached: every call reads the tree again, which keeps the daemon stateless.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { Session, SessionSummary } from "@spinner/protocol";
import { SESSION_VERSION } from "@spinner/protocol";
import { is_inside_git_repo, type SpinnerHome } from "../home.js";
import { SESSION_PORT_MAX } from "../stack/compose.js";
import { session_numbers_of, spinner_projects_sync } from "../stack/docker.js";
import { session_numbers_in_route_files } from "../stack/host-service.js";
import { render_agents_file, render_mission } from "./mission-template.js";

/** Directories every session has from the start, in the order of the protocol document. */
export const SESSION_SUBDIRS = [
    "agents",
    "skills",
    "worktrees",
    "stack",
    "inbox",
    "threads",
    "log",
    "artifacts",
] as const;

/** Files every session has from the start. */
export const SESSION_FILES = ["session.yaml", "MISSION.md", "AGENTS.md"] as const;

/** Upper bound on sessions in one home. More than this is a sign of a wrong `SPINNER_HOME`. */
const SESSIONS_MAX = 10_000;

export interface ListResult {
    sessions: SessionSummary[];
    /** Directories that exist but could not be read as a session, with the reason. */
    errors: { dir: string; error: string }[];
}

/** Lists every session directory that has a readable `session.yaml`, sorted by name. */
export function list_sessions(home: SpinnerHome): ListResult {
    const result: ListResult = { sessions: [], errors: [] };
    if (!existsSync(home.sessions)) {
        return result;
    }
    const entries = readdirSync(home.sessions, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort();
    assert.ok(entries.length <= SESSIONS_MAX, `more than ${SESSIONS_MAX} sessions in ${home.root}`);
    for (const dir of entries) {
        const read = read_session(home, dir);
        if (read.ok) {
            result.sessions.push(read.summary);
        } else {
            result.errors.push({ dir, error: read.error });
        }
    }
    return result;
}

export type ReadResult = { ok: true; summary: SessionSummary } | { ok: false; error: string };

/** Reads one session by directory name. Never throws: a bad file is a reported error. */
export function read_session(home: SpinnerHome, dir: string): ReadResult {
    assert.ok(dir.length > 0, "session dir name must not be empty");
    assert.ok(!dir.includes("/"), "session dir name must not contain a slash");
    const path = join(home.sessions, dir);
    const file = join(path, "session.yaml");
    if (!existsSync(file)) {
        return { ok: false, error: `${file} does not exist` };
    }
    let parsed: unknown;
    try {
        parsed = parse(readFileSync(file, "utf8"));
    } catch (error) {
        return { ok: false, error: `${file}: ${describe_error(error)}` };
    }
    const shape = check_session_shape(parsed);
    if (shape !== null) {
        return { ok: false, error: `${file}: ${shape}` };
    }
    return { ok: true, summary: { dir, path, session: parsed as Session } };
}

/** Writes `session.yaml` back. The caller holds the whole session, so this is one atomic write. */
export function write_session(summary: SessionSummary): void {
    assert.ok(summary.session.id.length > 0, "session id must not be empty");
    assert.ok(existsSync(summary.path), `${summary.path} does not exist`);
    writeFileSync(join(summary.path, "session.yaml"), stringify(summary.session));
}

/** Finds a session by directory name (`s17-refund-flow`) or by id (`s17`). */
export function find_session(home: SpinnerHome, name: string): SessionSummary | null {
    assert.ok(name.length > 0, "session name must not be empty");
    const result = list_sessions(home);
    const match = result.sessions.find(
        (entry) => entry.dir === name || entry.session.id === name,
    );
    return match ?? null;
}

/**
 * A structural check that is cheap and dependency-free. The JSON schema in the protocol
 * package is the full definition; this check only rejects files that cannot be a session.
 */
function check_session_shape(value: unknown): string | null {
    if (typeof value !== "object" || value === null) {
        return "not a YAML mapping";
    }
    const record = value as Record<string, unknown>;
    if (typeof record["version"] !== "number") {
        return "missing numeric `version`";
    }
    if (record["version"] > SESSION_VERSION) {
        return `version ${record["version"]} is newer than supported ${SESSION_VERSION}`;
    }
    for (const key of ["id", "slug", "title", "stage"]) {
        if (typeof record[key] !== "string") {
            return `missing string \`${key}\``;
        }
    }
    return null;
}

export interface CreateSessionInput {
    title: string;
    /** Optional slug. Derived from the title when absent. */
    slug?: string;
    /** Clock for `created` and the first Log line. Defaults to the wall clock. */
    now?: Date;
    /** PR URLs the session is adopted from; the mission says so and lists them. */
    adopted?: string[];
}

/**
 * Creates a session directory with `session.yaml`, `MISSION.md`, `AGENTS.md` and the empty
 * subdirectories from the protocol. Returns the new session. Throws when the home is inside a
 * git repository or when the directory already exists.
 */
export function create_session(home: SpinnerHome, input: CreateSessionInput): SessionSummary {
    assert.ok(input.title.trim().length > 0, "title must not be empty");
    if (is_inside_git_repo(home.root)) {
        throw new Error(`${home.root} is inside a git repository; move SPINNER_HOME outside it`);
    }
    const now = input.now ?? new Date();
    const slug = input.slug ?? slugify(input.title);
    assert.ok(slug.length > 0, `title "${input.title}" does not yield a slug`);
    const id = next_session_id(home);
    const dir = `${id}-${slug}`;
    const path = join(home.sessions, dir);
    if (existsSync(path)) {
        throw new Error(`session directory ${path} already exists`);
    }

    const session: Session = {
        version: SESSION_VERSION,
        id,
        slug,
        title: input.title,
        created: iso_local(now),
        stage: "planned",
        needs_human: "write Goal and Done when in MISSION.md",
        branch: `feat/${slug}`,
        base: "main",
        repos: {},
        stack: { state: "none" },
        agents: {},
    };

    mkdirSync(path, { recursive: true });
    for (const subdir of SESSION_SUBDIRS) {
        mkdirSync(join(path, subdir));
    }
    writeFileSync(join(path, "session.yaml"), stringify(session));
    const mission = render_mission({
        id,
        title: input.title,
        time: hhmm(now),
        ...(input.adopted === undefined ? {} : { adopted: input.adopted }),
    });
    writeFileSync(join(path, "MISSION.md"), mission);
    writeFileSync(join(path, "AGENTS.md"), render_agents_file({ id, dir }));

    const check = read_session(home, dir);
    assert.ok(check.ok, "a freshly written session must read back");
    return check.summary;
}

/**
 * Upper bound on the numeric part of a session id. The port range ends at `s455`
 * (65500-65599); a higher id would be told to bind a port that does not exist.
 */
const SESSION_NUMBER_MAX = SESSION_PORT_MAX;

/**
 * `s001`, `s002`, ...: one more than the highest id among live and archived sessions, the
 * route files of the machine's proxy directory and the running `spinner-s<n>` compose
 * projects, so an id (and the ports, hostnames, database and branch names derived from it)
 * is never reused after `close` and never shared by two homes on one machine.
 */
export function next_session_id(home: SpinnerHome): string {
    let highest = 0;
    if (home.ids_scope === "machine") {
        for (const number of session_numbers_in_route_files(home.proxy)) {
            highest = Math.max(highest, number);
        }
        for (const number of session_numbers_of(spinner_projects_sync())) {
            highest = Math.max(highest, number);
        }
    }
    for (const dir of [home.sessions, home.archive]) {
        if (!existsSync(dir)) {
            continue;
        }
        for (const entry of readdirSync(dir)) {
            const match = /^s(\d+)-/.exec(entry);
            if (match?.[1] !== undefined) {
                highest = Math.max(highest, Number.parseInt(match[1], 10));
            }
        }
    }
    const next = highest + 1;
    assert.ok(next <= SESSION_NUMBER_MAX, `session ids are exhausted at s${SESSION_NUMBER_MAX}`);
    return `s${String(next).padStart(3, "0")}`;
}

/** Lower-case, ASCII letters and digits only, runs of other characters become one dash. */
export function slugify(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
}

function hhmm(date: Date): string {
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
}

/** ISO 8601 with the local UTC offset, like `2026-10-20T11:40:00-04:00`. */
function iso_local(date: Date): string {
    const offset_minutes = -date.getTimezoneOffset();
    const sign = offset_minutes >= 0 ? "+" : "-";
    const abs = Math.abs(offset_minutes);
    const offset_hours = String(Math.floor(abs / 60)).padStart(2, "0");
    const offset_rest = String(abs % 60).padStart(2, "0");
    const local = new Date(date.getTime() + offset_minutes * 60_000);
    const stamp = local.toISOString().slice(0, 19);
    return `${stamp}${sign}${offset_hours}:${offset_rest}`;
}

function describe_error(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
