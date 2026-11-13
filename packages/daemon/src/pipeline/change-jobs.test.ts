// `change start` and `change switch` against real git repositories in a temp dir: a bare
// "origin" and a clone as the session's worktree. Method: commit on the first change, start
// a second, and check the branches, what was pushed, and `session.yaml`; then the refusals
// (uncommitted work) and the way back.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Session, SessionSummary } from "@spinner/protocol";
import { SESSION_VERSION } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { read_session, write_session } from "../store/session-store.js";
import { on_change_for_up } from "../actions.js";
import { start_change_job, switch_change_job } from "./change-jobs.js";
import { load_pipeline_config } from "./config.js";
import { git_runner } from "./github-write.js";

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

let root: string;
let home: SpinnerHome;
let origin: string;
let worktree: string;
let summary: SessionSummary;
let deps: Parameters<typeof start_change_job>[3];

function commit(file: string, message: string): void {
    writeFileSync(join(worktree, file), `${file}\n`);
    git(worktree, "add", file);
    git(worktree, "commit", "--quiet", "-m", message);
}

function reread(): SessionSummary {
    const read = read_session(home, summary.dir);
    if (!read.ok) {
        throw new Error(read.error);
    }
    return read.summary;
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "spinner-change-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home"), SPINNER_SESSION_IDS: "home" });
    origin = join(root, "origin.git");
    mkdirSync(origin);
    git(origin, "init", "--bare", "--quiet", "--initial-branch=main");
    const path = join(home.sessions, "s9-exports");
    worktree = join(path, "worktrees", "app");
    mkdirSync(path, { recursive: true });
    git(root, "clone", "--quiet", origin, worktree);
    git(worktree, "config", "user.email", "t@example.com");
    git(worktree, "config", "user.name", "t");
    git(worktree, "checkout", "--quiet", "-b", "main");
    commit("a.txt", "seed");
    git(worktree, "push", "--quiet", "origin", "main");
    git(worktree, "checkout", "--quiet", "-b", "feat/exports", "--no-track", "origin/main");
    writeFileSync(join(path, "MISSION.md"), "# s9\n\n## Log\n- 09:00 operator: started\n");
    const session: Session = {
        version: SESSION_VERSION,
        id: "s9",
        slug: "exports",
        title: "Parallel exports",
        created: "2026-11-12T09:00:00Z",
        stage: "planned",
        needs_human: null,
        branch: "feat/exports",
        base: "main",
        repos: { app: { path: root, worktree: "worktrees/app", changed: false, pr: null } },
        stack: { state: "none" },
        agents: {},
    };
    summary = { dir: "s9-exports", path, session };
    write_session(summary);
    const config = load_pipeline_config(undefined, home, root).config;
    deps = { git: git_runner, config, now: () => new Date("2026-11-12T11:00:00Z") };
});

describe("change start", () => {
    it("puts the first change aside, pushed, and starts the second from the base", async () => {
        commit("b.txt", "exports in parallel");
        git(worktree, "push", "--quiet", "origin", "feat/exports");
        commit("c.txt", "a second commit, not pushed yet");
        const input = { title: "Fix the export button" };
        const next = await start_change_job(home, summary, input, deps);
        expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
            "feat/fix-the-export-button",
        );
        // The new branch starts at the base: the first change's files are not in it.
        expect(git(worktree, "log", "--format=%s").trim()).toBe("seed");
        // The change put aside is whole on the remote.
        expect(git(origin, "log", "--format=%s", "feat/exports").split("\n")[0]).toBe(
            "a second commit, not pushed yet",
        );
        const session = next.session;
        expect(session.branch).toBe("feat/fix-the-export-button");
        expect(session.change).toMatchObject({ id: "c2", title: "Fix the export button" });
        expect(session.changes?.map((entry) => [entry.id, entry.branch, entry.stage])).toEqual([
            ["c1", "feat/exports", "building"],
        ]);
        expect(session.changes?.[0]?.repos["app"]?.changed).toBe(true);
        const mission = readFileSync(join(summary.path, "MISSION.md"), "utf8");
        expect(mission).toMatch(/spinner: change c2 started: Fix the export button/);
    });

    it("refuses on uncommitted work and names the paths", async () => {
        writeFileSync(join(worktree, "draft.txt"), "wip\n");
        await expect(
            start_change_job(home, summary, { title: "Second" }, deps),
        ).rejects.toThrow(/uncommitted changes \(\?\? draft.txt\); commit your work/);
        expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feat/exports");
        expect(reread().session.changes).toBeUndefined();
    });

    it("takes a numbered branch when a repository already has the name", async () => {
        // An older session left `feat/second` behind, locally and on the remote.
        git(worktree, "branch", "feat/second", "main");
        git(worktree, "push", "--quiet", "origin", "main:feat/second-2");
        git(worktree, "fetch", "--quiet", "origin");
        const next = await start_change_job(home, summary, { title: "Second" }, deps);
        expect(next.session.branch).toBe("feat/second-3");
        expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feat/second-3");
    });

    it("does not keep a current change with no commit", async () => {
        const next = await start_change_job(home, summary, { title: "Second" }, deps);
        expect(next.session.changes).toEqual([]);
        expect(next.session.change?.id).toBe("c2");
    });

    it("starts on top of another change when asked, and switches back and forth", async () => {
        commit("b.txt", "exports in parallel");
        const second = await start_change_job(home, summary, { title: "More", on: "c1" }, deps);
        expect(second.session.change).toMatchObject({ id: "c2", on: "c1" });
        expect(git(worktree, "log", "--format=%s").split("\n")[0]).toBe("exports in parallel");
        commit("d.txt", "more");
        const back = await switch_change_job(home, second, "c1", deps);
        expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feat/exports");
        expect(back.session.branch).toBe("feat/exports");
        expect(back.session.changes?.map((entry) => entry.id)).toEqual(["c2"]);
        const again = await switch_change_job(home, back, "c2", deps);
        expect(again.session.branch).toBe("feat/more");
        expect(git(worktree, "log", "--format=%s").split("\n")[0]).toBe("more");
        await expect(switch_change_job(home, again, "c7", deps)).rejects.toThrow(/no change "c7"/);
        await expect(
            start_change_job(home, again, { title: "x", on: "c7" }, deps),
        ).rejects.toThrow(/no change "c7" to start on/);
    });

    it("test locally switches to the change, and refuses while an agent is in a turn", async () => {
        commit("b.txt", "exports in parallel");
        const second = await start_change_job(home, summary, { title: "Second" }, deps);
        const ctx = { home, cwd: root, gh: async () => "" };
        const log = (): void => {};
        // The lead is in a turn: it writes to the worktrees, so they are not switched.
        const working = structuredClone(second);
        working.session.agents = { lead: { harness: "tty", model: "m", process: "running" } };
        await expect(on_change_for_up(ctx, working, "c1", log)).rejects.toThrow(
            /lead is working in the worktrees/,
        );
        expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feat/second");
        // Idle, with the stack down: the worktrees move, and `up` starts on the change.
        const on_first = await on_change_for_up(ctx, second, "c1", log);
        expect(on_first.session.branch).toBe("feat/exports");
        expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feat/exports");
        // The current change, or none named: nothing to do.
        expect(await on_change_for_up(ctx, on_first, "c1", log)).toBe(on_first);
        expect(await on_change_for_up(ctx, on_first, undefined, log)).toBe(on_first);
        await expect(on_change_for_up(ctx, on_first, "c9", log)).rejects.toThrow(/no change c9/);
    });
});
