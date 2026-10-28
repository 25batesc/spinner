// The one door for every GitHub write Spinner makes: a push, `gh pr create`, a reply or a
// resolve mutation, `gh pr review --approve`, an enqueue, a merge. `github_write` checks the
// repository against `pipeline.github.write_repos` first and refuses anything not on the
// list, so a fresh install and a mis-pointed session can only read (s005 brief, Safety 2).
// The read-only `gh_runner` in `github.ts` refuses writes outright; this module's runner is
// the only one that may make them.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GhRunner } from "./github.js";

const exec_file = promisify(execFile);

/** Runs `git` in `cwd` and resolves with stdout; rejects with stderr on a non-zero exit. */
export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

/** What a write needs: an unguarded `gh` and a `git`. Tests pass fakes. */
export interface GithubWriter {
    gh: GhRunner;
    git: GitRunner;
}

/** A `gh` call, or a `git push` in a worktree. Nothing else writes to GitHub. */
export type GithubWrite =
    | { kind: "gh"; args: string[] }
    | { kind: "git_push"; cwd: string; args: string[] };

/** Upper bound on bytes one write may print; `gh pr create` prints one URL. */
const OUTPUT_BYTES_MAX = 4 * 1024 * 1024;

export const gh_write_runner: GhRunner = async (args) => {
    assert.ok(args.length > 0, "gh needs arguments");
    const { stdout } = await exec_file("gh", args, { maxBuffer: OUTPUT_BYTES_MAX });
    return stdout;
};

export const git_runner: GitRunner = async (cwd, args) => {
    assert.ok(cwd.length > 0, "git needs a working directory");
    try {
        const { stdout } = await exec_file("git", args, { cwd, maxBuffer: OUTPUT_BYTES_MAX });
        return stdout;
    } catch (error) {
        const detail = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`git ${args.join(" ")} failed: ${detail.trim() || message}`);
    }
};

/** True when `repo` (`owner/name`) is on the allow-list. The comparison ignores case. */
export function is_write_allowed(repo: string, write_repos: readonly string[]): boolean {
    assert.ok(/^[^/\s]+\/[^/\s]+$/.test(repo), `repo must be owner/name, got "${repo}"`);
    const wanted = repo.toLowerCase();
    return write_repos.some((entry) => entry.toLowerCase() === wanted);
}

/**
 * Makes one write to `repo`, or throws before touching the network when the repo is not on
 * the allow-list. Every caller that writes to GitHub goes through here; a test covers the
 * refusal.
 */
export async function github_write(
    writer: GithubWriter,
    write_repos: readonly string[],
    repo: string,
    write: GithubWrite,
): Promise<string> {
    if (!is_write_allowed(repo, write_repos)) {
        throw new Error(
            `refusing GitHub write to ${repo}: not in pipeline.github.write_repos ` +
                `(${write_repos.length === 0 ? "empty" : write_repos.join(", ")})`,
        );
    }
    if (write.kind === "git_push") {
        assert.equal(write.args[0], "push", "a git_push write runs git push");
        return writer.git(write.cwd, write.args);
    }
    assert.ok(write.args.length > 0, "a gh write needs arguments");
    return writer.gh(write.args);
}

/**
 * `owner/name` from a remote URL: `https://github.com/o/n(.git)`, `git@github.com:o/n(.git)`
 * or `ssh://git@github.com/o/n`. Null for a remote that is not on github.com.
 */
export function repo_from_remote(url: string): string | null {
    const trimmed = url.trim();
    const scheme = /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?/;
    const rest = trimmed.replace(scheme, "");
    const match = /^github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(rest);
    if (match === null) {
        return null;
    }
    const [, owner, name] = match;
    assert.ok(owner !== undefined && name !== undefined);
    return `${owner}/${name}`;
}

/** The `owner/name` of the `origin` remote of a checkout, through `git`. */
export async function repo_of_checkout(git: GitRunner, cwd: string): Promise<string> {
    const url = await git(cwd, ["remote", "get-url", "origin"]);
    const repo = repo_from_remote(url);
    if (repo === null) {
        throw new Error(`${cwd}: origin "${url.trim()}" is not a github.com remote`);
    }
    return repo;
}
