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
import { add_worktree, list_worktrees, remove_worktree } from "./worktree.js";

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
