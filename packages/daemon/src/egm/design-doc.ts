// The check behind the lead's `design_doc` tool (docs/designs/egm-adoption.md, T7, entry
// 2.11, review B2). The daemon tracks only a file that is a new design doc of this session:
// a `.md` file directly in the designs directory of the designs repo's worktree, with the
// two headings of EGM's design doc template, that the base branch does not already hold.
// The heading check refuses a concepts brief that `egm-brainstorm` published as an RFC to the
// same directory; the base-branch check refuses a doc that the checkout brought with it.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative } from "node:path";
import type { Runner } from "../git/pinned-clone.js";

/** A design doc larger than this is refused. */
export const DESIGN_DOC_BYTES_MAX = 1_048_576;
/** The bound on the `git cat-file` call. */
export const DESIGN_DOC_GIT_TIMEOUT_MS = 10_000;

/** The headings every EGM design doc has. */
const REQUIRED_HEADINGS = ["## Overview", "## Detailed Implementation Plan"] as const;
const NOT_DESIGN_DOCS = new Set(["SITEMAP.md", "README.md"]);

export interface DesignDocInput {
    /** The path the lead named. */
    path: string;
    /** The designs repo's worktree, absolute. */
    worktree: string;
    /** The designs directory, absolute, inside `worktree`. */
    designs_dir: string;
    /** The designs repo's base branch. */
    base: string;
    /** The session's current `design.doc`, repo-relative, or null. */
    current: string | null;
    runner: Runner;
}

/** Returns the refusal text, or null when the path is a design doc of this session. */
export async function check_design_doc(input: DesignDocInput): Promise<string | null> {
    const { path } = input;
    if (!isAbsolute(path)) {
        return "the path must be absolute";
    }
    if (dirname(path) !== input.designs_dir || !path.endsWith(".md")) {
        return `the design doc must be a .md file directly in ${input.designs_dir}`;
    }
    if (NOT_DESIGN_DOCS.has(basename(path))) {
        return "SITEMAP.md and README.md are not design docs";
    }
    if (!existsSync(path)) {
        return `no file at ${path}`;
    }
    if (statSync(path).size > DESIGN_DOC_BYTES_MAX) {
        return "the file is larger than 1 MB";
    }
    const missing = missing_headings(readFileSync(path, "utf8"));
    if (missing.length > 0) {
        return (
            "a design doc has ## Overview and ## Detailed Implementation Plan headings; " +
            `this file lacks ${missing.join(", ")}`
        );
    }
    const repo_path = relative(input.worktree, path);
    if (repo_path === input.current) {
        return null;
    }
    return on_base(input, repo_path);
}

function missing_headings(text: string): string[] {
    const lines = new Set(text.split(/\r?\n/).map((line) => line.trimEnd()));
    return REQUIRED_HEADINGS.filter((heading) => !lines.has(heading));
}

/** Refuses a doc that `origin/<base>` already holds; a later round names the current doc. */
async function on_base(input: DesignDocInput, repo_path: string): Promise<string | null> {
    const args = ["-C", input.worktree, "cat-file", "-e", `origin/${input.base}:${repo_path}`];
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), DESIGN_DOC_GIT_TIMEOUT_MS);
    });
    try {
        // The process bound is a second later than the race, so a hung git is a refusal and
        // never a non-zero exit that would read as "not on the base".
        const run = input.runner("git", args, { timeout_ms: DESIGN_DOC_GIT_TIMEOUT_MS + 1000 });
        const result = await Promise.race([run, timeout]);
        if (result === "timeout") {
            return `git did not answer in ${DESIGN_DOC_GIT_TIMEOUT_MS / 1000} seconds`;
        }
        if (result.code === 0) {
            return `${repo_path} already exists on origin/${input.base}; a session names a new doc`;
        }
        return null;
    } finally {
        clearTimeout(timer);
    }
}
