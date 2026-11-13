// `change start` and `change switch` (docs/designs/talk-change-ship.md, 2.3): the git work
// that makes another change the current one of a session. Both refuse on uncommitted work,
// push the current branch when it has a remote branch, move every worktree to the new or
// chosen branch, then swap the change fields in `session.yaml` (`changes.ts`). The stack is
// not touched.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
    ChangeStartRequest,
    PipelineConfig,
    Session,
    SessionSummary,
} from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";
import { read_session, slugify, write_session } from "../store/session-store.js";
import {
    change_branch,
    current_change,
    has_change,
    next_change_id,
    start_change,
    switch_change,
} from "./changes.js";
import type { GitRunner } from "./github-write.js";
import { append_log_line } from "./mission-sections.js";
import { clock, repo_base } from "./pr.js";
import { dirty_message } from "./reset.js";
import { ahead_behind, remote_ref } from "./sync.js";
import { refresh_session } from "./tracker.js";

export interface ChangeDeps {
    git: GitRunner;
    config: PipelineConfig;
    log?: (line: string) => void;
    now?: () => Date;
}

interface Worktree {
    repo: string;
    cwd: string;
}

/** The session's worktrees that exist on disk, in `session.yaml` order. */
function worktrees_of(summary: SessionSummary): Worktree[] {
    const worktrees: Worktree[] = [];
    for (const [repo, entry] of Object.entries(summary.session.repos)) {
        if (entry.worktree === undefined) {
            continue;
        }
        const cwd = join(summary.path, entry.worktree);
        if (existsSync(cwd)) {
            worktrees.push({ repo, cwd });
        }
    }
    return worktrees;
}

/** Why a session cannot have changes started or switched, or null. */
function change_blocker(session: Session, worktrees: Worktree[]): string | null {
    if (session.kind === "review") {
        return "a review session has no changes";
    }
    if (worktrees.length === 0) {
        return "the session has no worktree";
    }
    return null;
}

/** Throws with the paths when a worktree has uncommitted or untracked files. */
async function refuse_dirty(git: GitRunner, worktrees: Worktree[], verb: string): Promise<void> {
    for (const worktree of worktrees) {
        const status = await git(worktree.cwd, ["status", "--porcelain"]);
        if (status.trim().length > 0) {
            const paths = dirty_message(worktree.cwd, status).replace(/; commit or stash.*$/, "");
            throw new Error(`${paths}; commit your work, then ${verb} again`);
        }
    }
}

/**
 * Pushes `branch` in every worktree whose remote branch exists and lacks local commits, so a
 * change that is put aside is never left unpushed: the sync pushes only what is checked out.
 * Returns, per repo, whether the branch has commits ahead of its base.
 */
async function push_and_measure(
    summary: SessionSummary,
    worktrees: Worktree[],
    deps: ChangeDeps,
): Promise<Record<string, boolean>> {
    const branch = summary.session.branch;
    const ahead_of_base: Record<string, boolean> = {};
    for (const { repo, cwd } of worktrees) {
        const remote = await remote_ref(deps.git, cwd, branch);
        if (remote !== null) {
            const counts = await ahead_behind(deps.git, cwd, remote);
            if (counts.ahead > 0) {
                await deps.git(cwd, ["push", "origin", branch]);
                deps.log?.(`${repo}: pushed ${counts.ahead} commit(s) of ${branch}`);
            }
        }
        const base = repo_base(summary, repo);
        const base_ref = (await remote_ref(deps.git, cwd, base)) ?? base;
        const out = await deps.git(cwd, ["rev-list", "--count", `${base_ref}..HEAD`]);
        ahead_of_base[repo] = Number.parseInt(out.trim(), 10) > 0;
    }
    return ahead_of_base;
}

/** The session with `changed` true for each repo whose branch has commits, and whether any. */
function with_changed(session: Session, ahead: Record<string, boolean>): [Session, boolean] {
    const next: Session = structuredClone(session);
    let any = false;
    for (const [repo, entry] of Object.entries(next.repos)) {
        entry.changed = entry.changed || ahead[repo] === true || entry.pr != null;
        any = any || entry.changed;
    }
    return [next, any];
}

/** Checks out `branch` in every worktree; on a failure, puts the moved ones back. */
async function move_worktrees(
    git: GitRunner,
    worktrees: Worktree[],
    back_to: string,
    checkout: (worktree: Worktree) => string[],
): Promise<void> {
    const moved: Worktree[] = [];
    try {
        for (const worktree of worktrees) {
            await git(worktree.cwd, checkout(worktree));
            moved.push(worktree);
        }
    } catch (error) {
        for (const worktree of moved) {
            await git(worktree.cwd, ["checkout", back_to]);
        }
        throw error;
    }
}

function log_change(summary: SessionSummary, now: Date, text: string): void {
    const path = join(summary.path, "MISSION.md");
    if (existsSync(path)) {
        const mission = readFileSync(path, "utf8");
        writeFileSync(path, append_log_line(mission, clock(now), "spinner", text));
    }
}

/**
 * Reads the session again, marks what the outgoing change changed and re-derives its stage
 * (a change with commits and no pull request is `building`, which nothing derived before),
 * applies `swap`, re-derives the stage of the change now on top, and writes.
 */
function write_swapped(
    home: SpinnerHome,
    summary: SessionSummary,
    deps: ChangeDeps,
    ahead: Record<string, boolean>,
    swap: (session: Session, keep_current: boolean) => Session,
): SessionSummary {
    const fresh = read_session(home, summary.dir);
    assert.ok(fresh.ok, fresh.ok ? "" : fresh.error);
    const now = (deps.now ?? (() => new Date()))();
    const [measured, keep_current] = with_changed(fresh.summary.session, ahead);
    const outgoing = refresh_session(measured, measured, deps.config, now).session;
    const swapped = swap(outgoing, keep_current);
    const refreshed = refresh_session(swapped, swapped, deps.config, now);
    write_session({ ...fresh.summary, session: refreshed.session });
    const check = read_session(home, summary.dir);
    assert.ok(check.ok, "a session with a new current change must read back");
    return check.summary;
}

export async function start_change_job(
    home: SpinnerHome,
    summary: SessionSummary,
    input: ChangeStartRequest,
    deps: ChangeDeps,
): Promise<SessionSummary> {
    const session = summary.session;
    const worktrees = worktrees_of(summary);
    const blocker = change_blocker(session, worktrees);
    if (blocker !== null) {
        throw new Error(`change start refused: ${blocker}`);
    }
    const title = input.title.trim();
    assert.ok(title.length > 0, "a change needs a title");
    if (input.on !== undefined && !has_change(session, input.on)) {
        throw new Error(`change start refused: no change "${input.on}" to start on`);
    }
    const slug = slugify(title);
    if (slug.length === 0) {
        throw new Error(`change start refused: the title "${title}" yields no branch name`);
    }
    await refuse_dirty(deps.git, worktrees, "start the change");
    const ahead = await push_and_measure(summary, worktrees, deps);
    const id = next_change_id(session);
    const branch = change_branch(session, slug);
    const parent_branch =
        input.on === undefined || input.on === current_change(session).id
            ? session.branch
            : (session.changes ?? []).find((entry) => entry.id === input.on)?.branch;
    assert.ok(parent_branch !== undefined);
    for (const { repo, cwd } of worktrees) {
        if (input.on === undefined) {
            await deps.git(cwd, ["fetch", "origin", repo_base(summary, repo)]);
        }
    }
    await move_worktrees(deps.git, worktrees, session.branch, ({ repo }) =>
        input.on === undefined
            ? ["checkout", "-b", branch, "--no-track", `origin/${repo_base(summary, repo)}`]
            : ["checkout", "-b", branch, parent_branch],
    );
    const now = (deps.now ?? (() => new Date()))();
    const from = input.on === undefined ? "the base" : `change ${input.on}`;
    deps.log?.(`change ${id} "${title}": branch ${branch} from ${from}`);
    const result = write_swapped(home, summary, deps, ahead, (outgoing, keep_current) =>
        start_change(outgoing, {
            id,
            title,
            branch,
            started: now.toISOString(),
            ...(input.on === undefined ? {} : { on: input.on }),
            keep_current,
        }),
    );
    log_change(summary, now, `change ${id} started: ${title} (${branch}, from ${from})`);
    return result;
}

export async function switch_change_job(
    home: SpinnerHome,
    summary: SessionSummary,
    id: string,
    deps: ChangeDeps,
): Promise<SessionSummary> {
    const session = summary.session;
    const worktrees = worktrees_of(summary);
    const blocker = change_blocker(session, worktrees);
    if (blocker !== null) {
        throw new Error(`change switch refused: ${blocker}`);
    }
    if (current_change(session).id === id) {
        deps.log?.(`change ${id} is the current one already`);
        return summary;
    }
    const record = (session.changes ?? []).find((entry) => entry.id === id);
    if (record === undefined) {
        throw new Error(`change switch refused: no change "${id}"`);
    }
    await refuse_dirty(deps.git, worktrees, "switch");
    const ahead = await push_and_measure(summary, worktrees, deps);
    await move_worktrees(deps.git, worktrees, session.branch, () => ["checkout", record.branch]);
    deps.log?.(`change ${id} "${record.title}": worktrees on ${record.branch}`);
    const now = (deps.now ?? (() => new Date()))();
    const result = write_swapped(home, summary, deps, ahead, (outgoing, keep_current) =>
        switch_change(outgoing, id, keep_current),
    );
    log_change(summary, now, `change ${id} is current: ${record.title} (${record.branch})`);
    return result;
}
