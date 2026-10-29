// Goal: `add_worktree` makes a worktree on the session branch from the base, links the
// session with an excluded `.spinner` symlink, is safe to repeat, and `remove_worktree`
// removes it while keeping the branch. Method: a real git repository in a temporary directory.
import {
    existsSync,
    lstatSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run_ok } from "../stack/shell.js";
import { add_worktree, fetch_branch, list_worktrees, remove_worktree } from "./worktree.js";

async function make_repo(root: string): Promise<string> {
    const repo = join(root, "repo");
    await run_ok("git", ["init", "--quiet", "--initial-branch", "develop", repo]);
    await run_ok("git", ["-C", repo, "config", "user.email", "t@example.com"]);
    await run_ok("git", ["-C", repo, "config", "user.name", "t"]);
    writeFileSync(join(repo, "README.md"), "hi\n");
    await run_ok("git", ["-C", repo, "add", "README.md"]);
    await run_ok("git", ["-C", repo, "commit", "--quiet", "-m", "init"]);
    return repo;
}

describe("worktrees", () => {
    it("creates, links, repeats and removes", async () => {
        const root = mkdtempSync(join(tmpdir(), "spinner-wt-"));
        const repo = await make_repo(root);
        const session_dir = join(root, "session");
        const worktree_path = join(session_dir, "worktrees", "app");
        const input = {
            repo_path: repo,
            worktree_path,
            branch: "feat/try-it",
            base: "develop",
            session_dir,
        };

        expect(await add_worktree(input)).toBe("created");
        expect(existsSync(join(worktree_path, "README.md"))).toBe(true);
        expect(lstatSync(join(worktree_path, ".spinner")).isSymbolicLink()).toBe(true);
        const branch = await run_ok("git", ["-C", worktree_path, "branch", "--show-current"]);
        expect(branch.trim()).toBe("feat/try-it");
        const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
        expect(exclude).toMatch(/^\.spinner$/m);
        const status = await run_ok("git", ["-C", worktree_path, "status", "--porcelain"]);
        expect(status).toBe("");

        expect(await add_worktree(input)).toBe("exists");
        expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8").match(/\.spinner/g))
            .toHaveLength(1);

        await remove_worktree(repo, worktree_path);
        expect(existsSync(worktree_path)).toBe(false);
        expect(await list_worktrees(repo)).toEqual([realpathSync(repo)]);
        const branches = await run_ok("git", ["-C", repo, "branch", "--list", "feat/try-it"]);
        expect(branches).toContain("feat/try-it");

        // A second session on the same branch reuses it instead of failing on `-b`.
        expect(await add_worktree({ ...input, base: "nope" })).toBe("created");
        await remove_worktree(repo, worktree_path);
    });

    it("fails for a base that does not exist", async () => {
        const root = mkdtempSync(join(tmpdir(), "spinner-wt-"));
        const repo = await make_repo(root);
        await expect(
            add_worktree({
                repo_path: repo,
                worktree_path: join(root, "wt"),
                branch: "feat/x",
                base: "missing",
                session_dir: root,
            }),
        ).rejects.toThrow(/base branch missing/);
    });
});

describe("start point", () => {
    it("branches from origin/<base> after a fetch, leaving the local base behind", async () => {
        const root = mkdtempSync(join(tmpdir(), "spinner-wt-"));
        const origin = await make_repo(root);
        const clone = join(root, "clone");
        await run_ok("git", ["clone", "--quiet", origin, clone]);
        // The origin moves on; the clone's local `develop` stays one commit behind.
        writeFileSync(join(origin, "new.txt"), "new\n");
        await run_ok("git", ["-C", origin, "add", "new.txt"]);
        await run_ok("git", ["-C", origin, "commit", "--quiet", "-m", "ahead"]);
        const ahead = (await run_ok("git", ["-C", origin, "rev-parse", "HEAD"])).trim();
        const local = (await run_ok("git", ["-C", clone, "rev-parse", "develop"])).trim();
        expect(local).not.toBe(ahead);

        const worktree_path = join(root, "session", "worktrees", "app");
        await add_worktree({
            repo_path: clone,
            worktree_path,
            branch: "feat/from-origin",
            base: "develop",
            session_dir: join(root, "session"),
        });
        const head = (await run_ok("git", ["-C", worktree_path, "rev-parse", "HEAD"])).trim();
        expect(head).toBe(ahead);
        const after = (await run_ok("git", ["-C", clone, "rev-parse", "develop"])).trim();
        expect(after).toBe(local);
    });
});

describe("fetch_branch", () => {
    async function commit(repo: string, file: string): Promise<string> {
        writeFileSync(join(repo, file), `${file}\n`);
        await run_ok("git", ["-C", repo, "add", file]);
        await run_ok("git", ["-C", repo, "commit", "--quiet", "-m", file]);
        return (await run_ok("git", ["-C", repo, "rev-parse", "HEAD"])).trim();
    }

    it("creates, fast-forwards, keeps a diverged branch, rejects a missing one", async () => {
        const root = mkdtempSync(join(tmpdir(), "spinner-wt-"));
        const origin = await make_repo(root);
        const clone = join(root, "clone");
        await run_ok("git", ["clone", "--quiet", origin, clone]);
        await run_ok("git", ["-C", clone, "config", "user.email", "t@example.com"]);
        await run_ok("git", ["-C", clone, "config", "user.name", "t"]);
        // The PR branch exists on origin only, one commit ahead of develop.
        await run_ok("git", ["-C", origin, "checkout", "--quiet", "-b", "devin/pr-1"]);
        const first = await commit(origin, "pr.txt");

        expect(await fetch_branch(clone, "devin/pr-1")).toBe("created");
        const local = (await run_ok("git", ["-C", clone, "rev-parse", "devin/pr-1"])).trim();
        expect(local).toBe(first);
        const upstream = ["rev-parse", "--abbrev-ref", "devin/pr-1@{upstream}"];
        expect((await run_ok("git", ["-C", clone, ...upstream])).trim()).toBe("origin/devin/pr-1");

        // A push on the PR moves origin; the local branch follows.
        const second = await commit(origin, "pr2.txt");
        expect(await fetch_branch(clone, "devin/pr-1")).toBe("fast-forwarded");
        expect((await run_ok("git", ["-C", clone, "rev-parse", "devin/pr-1"])).trim()).toBe(second);

        // A local commit that origin lacks is kept.
        await run_ok("git", ["-C", clone, "checkout", "--quiet", "devin/pr-1"]);
        const mine = await commit(clone, "local.txt");
        await commit(origin, "pr3.txt");
        expect(await fetch_branch(clone, "devin/pr-1")).toBe("kept");
        expect((await run_ok("git", ["-C", clone, "rev-parse", "devin/pr-1"])).trim()).toBe(mine);

        await expect(fetch_branch(clone, "devin/nope")).rejects.toThrow(/does not exist on origin/);

        // `add_worktree` then checks the fetched branch out as it is, without `-b`.
        await run_ok("git", ["-C", clone, "checkout", "--quiet", "develop"]);
        const worktree_path = join(root, "session", "worktrees", "app");
        await add_worktree({
            repo_path: clone,
            worktree_path,
            branch: "devin/pr-1",
            base: "develop",
            session_dir: join(root, "session"),
        });
        expect((await run_ok("git", ["-C", worktree_path, "rev-parse", "HEAD"])).trim()).toBe(mine);
    });
});
