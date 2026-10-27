// Goal: `seed_links` links a directory only when the lockfile next to it is the same in the
// primary checkout and the worktree; a changed lockfile means an install of its own.
// Method: two temporary trees with and without a lockfile difference.
import { lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { link_seed_dirs } from "./runner.js";

describe("link_seed_dirs", () => {
    it("links when the lockfile matches and skips when it differs", () => {
        const root = mkdtempSync(join(tmpdir(), "spinner-links-"));
        const primary = join(root, "primary");
        const worktree = join(root, "worktree");
        for (const base of [primary, worktree]) {
            mkdirSync(join(base, "KnitUI"), { recursive: true });
            mkdirSync(join(base, "apps", "ai"), { recursive: true });
            writeFileSync(join(base, "apps", "ai", "requirements-ci.txt"), "litellm==1\n");
        }
        mkdirSync(join(primary, "KnitUI", "node_modules"));
        mkdirSync(join(primary, "apps", "ai", ".venv"));
        writeFileSync(join(primary, "KnitUI", "package-lock.json"), '{"a":1}');
        writeFileSync(join(worktree, "KnitUI", "package-lock.json"), '{"a":1,"b":1}');

        const outcome = link_seed_dirs(primary, worktree, ["KnitUI/node_modules", "apps/ai/.venv"]);
        expect(outcome.linked).toEqual(["apps/ai/.venv"]);
        expect(outcome.skipped).toEqual([
            {
                dir: "KnitUI/node_modules",
                lockfile: "package-lock.json",
                cwd: join(worktree, "KnitUI"),
            },
        ]);
        expect(lstatSync(join(worktree, "apps", "ai", ".venv")).isSymbolicLink()).toBe(true);
    });
});
