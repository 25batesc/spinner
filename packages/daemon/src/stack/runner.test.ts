// Goal: `seed_links` links a directory only when the lockfile next to it is the same in the
// primary checkout and the worktree; a changed lockfile means an install of its own.
// Method: two temporary trees with and without a lockfile difference.
import { lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { proxy_mount_differs, shared_busy_reason } from "./docker.js";
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

describe("shared containers are machine-global", () => {
    it("names the projects that still have containers", () => {
        expect(shared_busy_reason([])).toBeNull();
        expect(shared_busy_reason(["spinner-s016", "spinner-s017"])).toMatch(/spinner-s016/);
        expect(shared_busy_reason(["spinner-s016"])).toMatch(/their home/);
    });

    it("treats a different proxy mount as a change and the same mount as none", () => {
        const config = "traefik:v3.6|-v|/tmp/one/proxy:/dynamic:ro|--log.level=WARN";
        expect(proxy_mount_differs(config, "/tmp/two/proxy")).toBe(true);
        expect(proxy_mount_differs(config, "/tmp/one/proxy")).toBe(false);
        // A container from before the label existed is left running, not recreated.
        expect(proxy_mount_differs("", "/tmp/two/proxy")).toBe(false);
        expect(proxy_mount_differs("traefik:v3.6|--log.level=WARN", "/tmp/two/proxy")).toBe(false);
    });
});
