// Goal: `tools/stack-proof.sh` says PROOF OK for a clean home and PROOF FAILED, exit 1, when a
// session's worktree still exists in one of the spec's repos. Method: a temporary SPINNER_HOME
// and a temporary git repo as the spec's only repo, with the managed database server (its
// container is absent on a clean machine, which the script treats as "no database open").
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { remove_worktree } from "@spinner/daemon";
import { describe, expect, it } from "vitest";
import { run_cli } from "./cli.js";

const repo_root = resolve(import.meta.dirname, "..", "..", "..");
const script = join(repo_root, "tools", "stack-proof.sh");

function proof(home: string, spec_dir: string): { code: number; out: string } {
    try {
        const out = execFileSync(script, [spec_dir], {
            env: { ...process.env, SPINNER_HOME: home },
            encoding: "utf8",
        });
        return { code: 0, out };
    } catch (error) {
        const failed = error as { status: number; stdout: string };
        return { code: failed.status, out: failed.stdout };
    }
}

describe("tools/stack-proof.sh", () => {
    it("passes on a clean home and fails while a worktree remains", async () => {
        const root = mkdtempSync(join(tmpdir(), "spinner-proof-"));
        const home = join(root, "home");
        const repo = join(root, "repo");
        execFileSync("git", ["init", "--quiet", "--initial-branch", "main", repo]);
        execFileSync("git", ["-C", repo, "commit", "--quiet", "--allow-empty", "-m", "init"]);
        const spec_dir = join(root, "project");
        mkdirSync(spec_dir);
        writeFileSync(
            join(spec_dir, "spinner.yaml"),
            [
                "name: proof",
                "base: main",
                `repos: { app: { path: ${repo} } }`,
                "services: { api: { repo: app, image: x, command: y } }",
                "database: { mode: template, server: spinner-postgres }",
                "",
            ].join("\n"),
        );

        const clean = proof(home, spec_dir);
        expect(clean.out).toContain("PROOF OK");
        expect(clean.code).toBe(0);

        const io = { env: { SPINNER_HOME: home }, out: () => {}, err: () => {} };
        expect(await run_cli(["new", "--project", spec_dir, "Proof"], io)).toBe(0);
        const dirty = proof(home, spec_dir);
        expect(dirty.out).toContain("PROOF FAILED");
        expect(dirty.out).toContain(join(home, "sessions", "s001-proof", "worktrees", "app"));
        expect(dirty.code).toBe(1);

        await remove_worktree(repo, join(home, "sessions", "s001-proof", "worktrees", "app"));
        expect(proof(home, spec_dir).code).toBe(0);
    });
});
