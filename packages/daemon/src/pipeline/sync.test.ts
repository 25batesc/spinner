// The worktree sync against real git repositories in a temp dir: a bare "origin", a clone as
// the session worktree. Method: commit, run a round, check the push and the facts; fail the
// push (a diverged remote) and check the error lands in the facts, never a force.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Session } from "@spinner/protocol";
import { SESSION_VERSION } from "@spinner/protocol";
import { resolve_home } from "../home.js";
import { git_runner } from "./github-write.js";
import { read_session, write_session } from "../store/session-store.js";
import { same_sync, sync_once } from "./sync.js";

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function repo_with_origin(root: string): { origin: string; work: string } {
    const origin = join(root, "origin.git");
    mkdirSync(origin);
    git(origin, "init", "--bare", "--quiet", "--initial-branch=main");
    const seed = join(root, "seed");
    git(root, "clone", "--quiet", origin, seed);
    git(seed, "config", "user.email", "t@example.com");
    git(seed, "config", "user.name", "t");
    writeFileSync(join(seed, "a.txt"), "a\n");
    git(seed, "add", "a.txt");
    git(seed, "commit", "--quiet", "-m", "seed");
    git(seed, "push", "--quiet", "origin", "HEAD:main");
    return { origin, work: seed };
}

function home_in(root: string) {
    return resolve_home({ SPINNER_HOME: join(root, "home"), SPINNER_SESSION_IDS: "home" });
}

function session_with(root: string, worktree_rel: string): Session {
    return {
        version: SESSION_VERSION,
        id: "s9",
        slug: "sync",
        title: "sync",
        created: "2026-11-09T00:00:00Z",
        stage: "building",
        needs_human: null,
        branch: "feat/sync",
        base: "main",
        repos: { app: { path: root, worktree: worktree_rel, changed: true, pr: null } },
        stack: { state: "none" },
        agents: {},
    };
}

describe("sync_once", () => {
    it("records dirty and ahead, pushes with an upstream, never forces", async () => {
        const root = mkdtempSync(join(tmpdir(), "spinner-sync-"));
        const home = home_in(root);
        const { origin, work } = repo_with_origin(root);
        const session_path = join(home.sessions, "s9-sync");
        mkdirSync(session_path, { recursive: true });
        // The worktree is a clone on the feature branch, pushed once (as `create PR` does).
        const worktree = join(session_path, "worktrees", "app");
        git(root, "clone", "--quiet", origin, worktree);
        git(worktree, "config", "user.email", "t@example.com");
        git(worktree, "config", "user.name", "t");
        git(worktree, "checkout", "--quiet", "-b", "feat/sync");
        writeFileSync(join(worktree, "b.txt"), "b\n");
        git(worktree, "add", "b.txt");
        git(worktree, "commit", "--quiet", "-m", "one");
        git(worktree, "push", "--quiet", "--set-upstream", "origin", "feat/sync");
        const session = session_with(root, "worktrees/app");
        const summary = { dir: "s9-sync", path: session_path, session };
        write_session(summary);

        // In sync: facts written once, nothing pushed.
        const quiet = await sync_once(home, { git: git_runner, push: true });
        expect(quiet.pushed).toEqual([]);
        expect(quiet.changed).toEqual(["s9-sync"]);
        let facts = read_session(home, "s9-sync");
        expect(facts.ok && facts.summary.session.repos["app"]?.sync).toMatchObject({
            dirty: 0, ahead: 0, behind: 0, upstream: true, error: null,
        });

        // A commit and a dirty file: the commit is pushed, the dirty file counted.
        writeFileSync(join(worktree, "b.txt"), "bb\n");
        git(worktree, "commit", "--quiet", "-am", "two");
        writeFileSync(join(worktree, "a.txt"), "aa\n");
        const round = await sync_once(home, { git: git_runner, push: true });
        expect(round.pushed).toEqual([{ dir: "s9-sync", repo: "app", commits: 1 }]);
        const remote_head = git(origin, "rev-parse", "feat/sync").trim();
        expect(remote_head).toBe(git(worktree, "rev-parse", "HEAD").trim());
        facts = read_session(home, "s9-sync");
        expect(facts.ok && facts.summary.session.repos["app"]?.sync).toMatchObject({
            dirty: 1, ahead: 0, upstream: true, error: null,
        });

        // The remote moved on (someone else pushed): the push fails, the error is recorded,
        // the remote keeps its commit.
        git(work, "fetch", "--quiet", "origin");
        git(work, "checkout", "--quiet", "-b", "feat/sync", "origin/feat/sync");
        writeFileSync(join(work, "c.txt"), "c\n");
        git(work, "add", "c.txt");
        git(work, "commit", "--quiet", "-m", "remote");
        git(work, "push", "--quiet", "origin", "feat/sync");
        git(worktree, "commit", "--quiet", "-am", "three");
        const failed = await sync_once(home, { git: git_runner, push: true });
        expect(failed.errors).toHaveLength(1);
        expect(failed.errors[0]?.error).toMatch(/rejected|failed/);
        facts = read_session(home, "s9-sync");
        const sync = facts.ok ? facts.summary.session.repos["app"]?.sync : undefined;
        expect(sync?.ahead).toBe(1);
        expect(sync?.behind).toBe(1);
        expect(sync?.error).toMatch(/rejected|failed/);
        expect(git(origin, "log", "--oneline", "feat/sync").split("\n")[0]).toContain("remote");
    });

    it("compares with the remote branch of the same name, not the upstream", async () => {
        const root = mkdtempSync(join(tmpdir(), "spinner-sync-"));
        const home = home_in(root);
        const { origin } = repo_with_origin(root);
        const session_path = join(home.sessions, "s9-sync");
        mkdirSync(session_path, { recursive: true });
        const worktree = join(session_path, "worktrees", "app");
        git(root, "clone", "--quiet", origin, worktree);
        git(worktree, "config", "user.email", "t@example.com");
        git(worktree, "config", "user.name", "t");
        // A branch made from `origin/main` tracks `origin/main`; it is pushed under its own
        // name. Against its upstream it is one commit ahead for ever.
        git(worktree, "checkout", "--quiet", "-b", "feat/sync", "--track", "origin/main");
        writeFileSync(join(worktree, "b.txt"), "b\n");
        git(worktree, "add", "b.txt");
        git(worktree, "commit", "--quiet", "-m", "one");
        git(worktree, "push", "--quiet", "origin", "HEAD");
        const session = session_with(root, "worktrees/app");
        write_session({ dir: "s9-sync", path: session_path, session });
        const round = await sync_once(home, { git: git_runner, push: true });
        expect(round.pushed).toEqual([]);
        const facts = read_session(home, "s9-sync");
        expect(facts.ok && facts.summary.session.repos["app"]?.sync).toMatchObject({
            ahead: 0,
            behind: 0,
            upstream: true,
        });
    });

    it("without an upstream nothing is pushed and the facts say so", async () => {
        const root = mkdtempSync(join(tmpdir(), "spinner-sync-"));
        const home = home_in(root);
        const { origin } = repo_with_origin(root);
        const session_path = join(home.sessions, "s9-sync");
        mkdirSync(session_path, { recursive: true });
        const worktree = join(session_path, "worktrees", "app");
        git(root, "clone", "--quiet", origin, worktree);
        git(worktree, "checkout", "--quiet", "-b", "feat/sync");
        const session = session_with(root, "worktrees/app");
        write_session({ dir: "s9-sync", path: session_path, session });
        const round = await sync_once(home, { git: git_runner, push: true });
        expect(round.pushed).toEqual([]);
        const facts = read_session(home, "s9-sync");
        expect(facts.ok && facts.summary.session.repos["app"]?.sync).toMatchObject({
            upstream: false, ahead: 0, dirty: 0,
        });
        expect(same_sync({ dirty: 0, ahead: 0, behind: 0, upstream: false, error: null }, {
            dirty: 0, ahead: 0, behind: 0, upstream: false, error: null,
        })).toBe(true);
    });
});
