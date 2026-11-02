// Git worktrees per session and repo (docs/SESSION_PROTOCOL.md, "Session directory layout").
// Each worktree is on the session branch, holds a `.spinner` symlink back to the session, and
// that symlink is listed in the repo's `.git/info/exclude` so it can never be committed.
import assert from "node:assert/strict";
import {
    appendFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    symlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { run, run_ok } from "../stack/shell.js";

export const SESSION_LINK = ".spinner";

export interface WorktreeInput {
    /** Absolute path of the primary checkout. */
    repo_path: string;
    /** Absolute path the worktree should have. */
    worktree_path: string;
    branch: string;
    /** Branch the new session branch starts from, when the branch does not exist yet. */
    base: string;
    /** Absolute path of the session directory, the target of the `.spinner` symlink. */
    session_dir: string;
}

export type WorktreeOutcome = "created" | "exists";

/**
 * Adds a worktree on `branch`, creating the branch from `base` when it does not exist. A
 * worktree that is already registered at that path is left alone, so `new` can be retried.
 */
export async function add_worktree(input: WorktreeInput): Promise<WorktreeOutcome> {
    assert.ok(isAbsolute(input.repo_path), "repo_path must be absolute");
    assert.ok(isAbsolute(input.worktree_path), "worktree_path must be absolute");
    assert.ok(input.branch.length > 0, "branch must not be empty");
    if (!existsSync(join(input.repo_path, ".git"))) {
        throw new Error(`${input.repo_path} is not a git repository`);
    }
    let outcome: WorktreeOutcome = "exists";
    const registered = await list_worktrees(input.repo_path);
    if (!registered.includes(canonical(input.worktree_path))) {
        mkdirSync(dirname(input.worktree_path), { recursive: true });
        await run_ok("git", ["-C", input.repo_path, "worktree", "prune"]);
        const path = input.worktree_path;
        const args = (await branch_exists(input.repo_path, input.branch))
            ? ["add", path, input.branch]
            : ["add", "-b", input.branch, path, await start_point(input)];
        await run_ok("git", ["-C", input.repo_path, "worktree", ...args]);
        outcome = "created";
    }
    link_session(input.worktree_path, input.session_dir);
    await exclude_session_link(input.repo_path);
    assert.ok(existsSync(join(input.worktree_path, ".git")), "worktree must have a .git file");
    return outcome;
}

/** Removes the worktree and keeps the branch. A worktree that is already gone is fine. */
export async function remove_worktree(repo_path: string, worktree_path: string): Promise<void> {
    assert.ok(isAbsolute(worktree_path), "worktree_path must be absolute");
    const registered = await list_worktrees(repo_path);
    if (registered.includes(canonical(worktree_path))) {
        // `--force` because the worktree may hold untracked files from a dev server or an
        // agent, and `close` must succeed after a failed `up`.
        await run_ok("git", ["-C", repo_path, "worktree", "remove", "--force", worktree_path]);
    }
    await run_ok("git", ["-C", repo_path, "worktree", "prune"]);
    assert.ok(!existsSync(worktree_path), `${worktree_path} still exists after removal`);
}

/** Canonical paths of the worktrees registered in a repo, the primary checkout included. */
export async function list_worktrees(repo_path: string): Promise<string[]> {
    const out = await run_ok("git", ["-C", repo_path, "worktree", "list", "--porcelain"]);
    return out
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => canonical(line.slice("worktree ".length)));
}

/**
 * Git prints real paths (`/private/var` on macOS, where `/var` is a symlink), so comparisons
 * use the real path of the nearest existing ancestor plus the rest.
 */
function canonical(path: string): string {
    const absolute = resolve(path);
    const rest: string[] = [];
    let current = absolute;
    for (let level = 0; level < PATH_LEVELS_MAX; level += 1) {
        if (existsSync(current)) {
            return join(realpathSync(current), ...rest);
        }
        const parent = dirname(current);
        if (parent === current) {
            return absolute;
        }
        rest.unshift(basename(current));
        current = parent;
    }
    return absolute;
}

/** Upper bound on directory levels to walk when looking for an existing ancestor. */
const PATH_LEVELS_MAX = 64;

/**
 * Puts an existing worktree on `branch` (s014, `adopt` into an attached session): a worktree
 * already on it is left alone; a clean one is checked out; a dirty one is an error, because
 * switching would carry the changes to the PR's branch.
 */
export async function checkout_branch(worktree_path: string, branch: string): Promise<boolean> {
    assert.ok(branch.length > 0, "branch must not be empty");
    const current = await run_ok("git", ["-C", worktree_path, "rev-parse", "--abbrev-ref", "HEAD"]);
    if (current.trim() === branch) {
        return false;
    }
    const status = await run_ok("git", ["-C", worktree_path, "status", "--porcelain"]);
    if (status.trim().length > 0) {
        throw new Error(`${worktree_path} has uncommitted changes; cannot switch to ${branch}`);
    }
    await run_ok("git", ["-C", worktree_path, "checkout", "--quiet", branch]);
    return true;
}

export interface OriginRepo {
    owner: string;
    name: string;
}

/**
 * The GitHub `owner/name` of a checkout's `origin`, from `git remote get-url origin`, for
 * `https://github.com/owner/name(.git)` and `git@github.com:owner/name(.git)`; null without
 * an origin or for another host. A clone's directory need not carry the repository's name.
 */
export async function origin_repo(repo_path: string): Promise<OriginRepo | null> {
    const result = await run("git", ["-C", repo_path, "remote", "get-url", "origin"], {
        timeout_ms: 5_000,
    });
    if (result.code !== 0) {
        return null;
    }
    const url = String(result.stdout).trim();
    const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
    if (match === null || match[1] === undefined || match[2] === undefined) {
        return null;
    }
    return { owner: match[1], name: match[2] };
}

async function branch_exists(repo_path: string, branch: string): Promise<boolean> {
    return ref_exists(repo_path, `refs/heads/${branch}`);
}

/** The local base branch, or its remote-tracking branch when only that exists. */
/**
 * The session branch starts from `origin/<base>` after a fetch, because the local base
 * branch is often behind (the operator's `dev` was 482 commits behind) and stays untouched.
 * Without a remote, or when the fetch fails (offline), the local branch is the start point.
 */
/**
 * Fetches `origin/<base>` once per checkout. `add_worktree` fetches again when it creates a
 * branch; a second fetch of refs that are current is cheap, and two worktrees of one repo
 * must not fetch at the same time, so the caller fetches first and adds worktrees after.
 */
export async function fetch_base(repo_path: string, base: string): Promise<void> {
    await run("git", ["-C", repo_path, "fetch", "--quiet", "origin", base], {
        timeout_ms: FETCH_TIMEOUT_MS,
    });
}

export type BranchFetchOutcome = "created" | "fast-forwarded" | "kept";

/**
 * Makes the local branch of a PR's head ready for `add_worktree`: fetches `origin/<branch>`,
 * creates the local branch tracking it when there is none, and fast-forwards a local branch
 * that is behind. A local branch that diverged, or that a checkout holds, is kept as it is:
 * git refuses to move a checked-out branch, and a diverged branch holds the operator's own
 * commits. The caller logs the outcome.
 */
export async function fetch_branch(
    repo_path: string,
    branch: string,
): Promise<BranchFetchOutcome> {
    assert.ok(isAbsolute(repo_path), "repo_path must be absolute");
    assert.ok(branch.length > 0, "branch must not be empty");
    const remote = `origin/${branch}`;
    const fetched = await run("git", ["-C", repo_path, "fetch", "--quiet", "origin", branch], {
        timeout_ms: FETCH_TIMEOUT_MS,
    });
    if (fetched.code !== 0 || !(await ref_exists(repo_path, remote))) {
        throw new Error(`branch ${branch} does not exist on origin of ${repo_path}`);
    }
    if (!(await branch_exists(repo_path, branch))) {
        await run_ok("git", ["-C", repo_path, "branch", "--quiet", "--track", branch, remote]);
        return "created";
    }
    const ancestor = ["merge-base", "--is-ancestor", branch, remote];
    const behind = await run("git", ["-C", repo_path, ...ancestor]);
    if (behind.code !== 0) {
        return "kept";
    }
    // `branch -f` refuses a branch that a worktree has checked out; that one is kept too.
    const moved = await run("git", ["-C", repo_path, "branch", "--quiet", "-f", branch, remote]);
    return moved.code === 0 ? "fast-forwarded" : "kept";
}

async function start_point(input: WorktreeInput): Promise<string> {
    const remote = `origin/${input.base}`;
    const fetched = await run(
        "git",
        ["-C", input.repo_path, "fetch", "--quiet", "origin", input.base],
        { timeout_ms: FETCH_TIMEOUT_MS },
    );
    if (fetched.code === 0 && (await ref_exists(input.repo_path, remote))) {
        return remote;
    }
    if (await branch_exists(input.repo_path, input.base)) {
        return input.base;
    }
    if (await ref_exists(input.repo_path, remote)) {
        return remote;
    }
    throw new Error(`base branch ${input.base} does not exist in ${input.repo_path}`);
}

/** Upper bound on one fetch of the base branch. */
const FETCH_TIMEOUT_MS = 60_000;

async function ref_exists(repo_path: string, ref: string): Promise<boolean> {
    const result = await run("git", ["-C", repo_path, "rev-parse", "--verify", "--quiet", ref]);
    return result.code === 0;
}

function link_session(worktree_path: string, session_dir: string): void {
    const link = join(worktree_path, SESSION_LINK);
    if (existsSync(link) || is_symlink(link)) {
        return;
    }
    symlinkSync(session_dir, link);
}

function is_symlink(path: string): boolean {
    try {
        return lstatSync(path).isSymbolicLink();
    } catch {
        return false;
    }
}

/** Appends `.spinner` to the repo's `info/exclude` once. The file is per clone, never committed. */
async function exclude_session_link(repo_path: string): Promise<void> {
    const common = await run_ok("git", ["-C", repo_path, "rev-parse", "--git-common-dir"]);
    const exclude = resolve(repo_path, common.trim(), "info", "exclude");
    mkdirSync(dirname(exclude), { recursive: true });
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    const listed = current.split("\n").some((line) => line.trim() === SESSION_LINK);
    if (!listed) {
        const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
        appendFileSync(exclude, `${separator}${SESSION_LINK}\n`);
    }
}
