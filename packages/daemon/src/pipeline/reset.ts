// `spinner reset <session>`: after the round merged, start the next one on the same session.
// A new branch from fresh `base` in every worktree, the PR facts and the verify tick cleared,
// the round's threads moved under `artifacts/`, the Log moved under `## Previous rounds` in
// MISSION.md, and the stack recreated with a fresh database clone when it was up. Agent
// transcripts stay, so an agent resumes with its history (docs/SESSION_PROTOCOL.md, "reset").
// The round's PRs are also recorded in `session.yaml` `rounds`. The `design` block is not
// touched: the design doc and its approvals carry across rounds (docs/designs/egm-adoption.md,
// T14).
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { PipelineConfig, ResetRequest, Session, SessionSummary } from "@spinner/protocol";
import { ROUNDS_MAX } from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";
import {
    read_session_spec,
    session_db,
    stack_down,
    stack_has_database,
    stack_up,
    SESSION_SPEC,
} from "../stack/runner.js";
import { DatabaseServer, server_address } from "../stack/postgres.js";
import { read_session, write_session } from "../store/session-store.js";
import type { GitRunner } from "./github-write.js";
import { archive_round } from "./mission-sections.js";
import { repo_base } from "./pr.js";
import { round_record } from "./rounds.js";
import { THREADS_DIR } from "./threads.js";
import { refresh_session, session_prs } from "./tracker.js";

export interface ResetDeps {
    git: GitRunner;
    config: PipelineConfig;
    log?: (line: string) => void;
    now?: () => Date;
    /** Whether to touch the stack (down, drop the database, up). Off in unit tests. */
    stack?: boolean;
}

/** Pure: why the session may not reset now, or null. */
export function reset_blocker(session: Session): string | null {
    const open = session_prs(session).filter((pr) => pr.state === "open" || pr.state === "draft");
    if (open.length > 0) {
        const names = open.map((pr) => `${pr.repo}#${pr.number}`).join(", ");
        return `open PR${open.length === 1 ? "" : "s"}: ${names}; land or close first`;
    }
    return null;
}

/** `feat/x` → `feat/x-r2`, `feat/x-r2` → `feat/x-r3`. */
export function next_branch(branch: string, round: number): string {
    assert.ok(round >= 2, "the next round is at least 2");
    return `${branch.replace(/-r\d+$/, "")}-r${round}`;
}

export async function reset_session(
    home: SpinnerHome,
    summary: SessionSummary,
    input: ResetRequest,
    deps: ResetDeps,
): Promise<SessionSummary> {
    const blocker = reset_blocker(summary.session);
    if (blocker !== null) {
        throw new Error(`reset refused: ${blocker}`);
    }
    const now = deps.now ?? (() => new Date());
    const previous = summary.session;
    const round = (previous.round ?? 1) + 1;
    const branch = input.branch ?? next_branch(previous.branch, round);
    deps.log?.(`round ${round}: branch ${branch}`);
    const was_up = previous.stack.state === "up";
    if (deps.stack === true && was_up) {
        await stack_down(home, summary, deps.log ?? (() => {}));
    }
    const session: Session = structuredClone(previous);
    // Recorded before the PR facts are cleared; past ROUNDS_MAX the oldest record drops, and
    // its Log stays under `## Previous rounds`.
    session.rounds = [...(previous.rounds ?? []), round_record(previous, now())].slice(
        -ROUNDS_MAX,
    );
    for (const [repo, entry] of Object.entries(session.repos)) {
        entry.pr = null;
        entry.changed = false;
        if (entry.worktree === undefined) {
            continue;
        }
        const cwd = join(summary.path, entry.worktree);
        if (!existsSync(cwd)) {
            deps.log?.(`${repo}: worktree ${entry.worktree} is missing; skipped`);
            continue;
        }
        const base = repo_base(summary, repo);
        await new_branch(deps.git, cwd, branch, base);
        deps.log?.(`${repo}: ${branch} from origin/${base}`);
    }
    session.branch = branch;
    session.round = round;
    session.pipeline = { verified_locally: false, verified_heads: {}, slack_post: null };
    archive_threads(summary, round - 1, deps.log);
    archive_mission(summary, previous, round - 1);
    const refreshed = refresh_session(previous, session, deps.config, now());
    write_session({ ...summary, session: refreshed.session });
    if (deps.stack === true && existsSync(join(summary.path, SESSION_SPEC))) {
        const log = deps.log ?? (() => {});
        const has_database = stack_has_database(read_session_spec(summary).spec);
        if (!has_database) {
            log("database: none (the spec has no database block)");
        } else if (was_up) {
            // The server answered a moment ago (the stack was up), so the clone is dropped now
            // and the stack comes back on a fresh one.
            await recreate_database(summary, log);
        } else {
            // With the stack down the server may be absent; the next `up` drops the clone.
            mark_database_stale(home, summary.dir);
            log(`database ${session_db(summary.session.id)}: re-cloned at the next up`);
        }
        if (was_up) {
            const fresh = read_session(home, summary.dir);
            assert.ok(fresh.ok, fresh.ok ? "" : fresh.error);
            await stack_up(home, fresh.summary, { build: false }, log);
        }
    }
    const check = read_session(home, summary.dir);
    assert.ok(check.ok, "a reset session must read back");
    deps.log?.(`stage: ${check.summary.session.stage}; round ${round} started`);
    return check.summary;
}

/** A clean worktree gets a new branch at fresh `origin/<base>`; a dirty one stops the reset. */
async function new_branch(
    git: GitRunner,
    cwd: string,
    branch: string,
    base: string,
): Promise<void> {
    const status = await git(cwd, ["status", "--porcelain"]);
    if (status.trim().length > 0) {
        throw new Error(dirty_message(cwd, status));
    }
    await git(cwd, ["fetch", "origin", base]);
    await git(cwd, ["checkout", "-b", branch, `origin/${base}`]);
}

/** The reset refusal names at most this many dirty paths, then counts the rest. */
export const DIRTY_PATHS_SHOWN_MAX = 10;

/**
 * The refusal of a dirty worktree (dogfood #38): the first `DIRTY_PATHS_SHOWN_MAX` paths of
 * `git status --porcelain` with their status codes, then how many more. The operator then
 * sees at once whether the change is work to keep or a stray file.
 */
export function dirty_message(cwd: string, porcelain: string): string {
    const lines = porcelain.split("\n").filter((line) => line.trim().length > 0);
    assert.ok(lines.length > 0, "a dirty message needs at least one status line");
    const shown = lines.slice(0, DIRTY_PATHS_SHOWN_MAX).map((line) => line.trimEnd());
    const rest = lines.length - shown.length;
    const more = rest > 0 ? `, and ${rest} more` : "";
    return (
        `${cwd}: uncommitted changes (${shown.join(", ")}${more}); ` +
        "commit or stash before reset"
    );
}

/** Moves `threads/*` to `artifacts/round-<n>/threads/` so the next round starts empty. */
function archive_threads(
    summary: SessionSummary,
    round: number,
    log: ResetDeps["log"],
): void {
    const dir = join(summary.path, THREADS_DIR);
    if (!existsSync(dir)) {
        return;
    }
    const files = readdirSync(dir);
    if (files.length === 0) {
        return;
    }
    const target = join(summary.path, "artifacts", `round-${round}`, THREADS_DIR);
    mkdirSync(target, { recursive: true });
    for (const name of files) {
        renameSync(join(dir, name), join(target, name));
    }
    log?.(`moved ${files.length} thread file(s) to artifacts/round-${round}/threads`);
}

function archive_mission(summary: SessionSummary, previous: Session, round: number): void {
    const path = join(summary.path, "MISSION.md");
    if (!existsSync(path)) {
        return;
    }
    const prs = session_prs(previous)
        .map((pr) => `${pr.repo}#${pr.number} (${pr.state})`)
        .join(", ");
    const line = `${previous.branch} · PRs: ${prs.length > 0 ? prs : "none"}`;
    writeFileSync(path, archive_round(readFileSync(path, "utf8"), round, line));
}

/** Records that the clone is from a previous round; `stack_up` drops it before it clones. */
function mark_database_stale(home: SpinnerHome, dir: string): void {
    const current = read_session(home, dir);
    assert.ok(current.ok, current.ok ? "" : current.error);
    const session = current.summary.session;
    const stack = { ...session.stack, db_stale: true };
    write_session({ ...current.summary, session: { ...session, stack } });
}

/** Drops the session database so the next `up` clones the template again. */
async function recreate_database(
    summary: SessionSummary,
    log: (line: string) => void,
): Promise<void> {
    const { spec } = read_session_spec(summary);
    const server = new DatabaseServer(server_address(spec.database));
    await server.wait_ready(spec.database?.server !== "external");
    const db = session_db(summary.session.id);
    log(`database ${db}: ${await server.drop_database(db)}; re-cloned on the next up`);
}
