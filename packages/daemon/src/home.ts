// Locates the Spinner home directory. Everything the daemon knows lives under it, so tests
// point `SPINNER_HOME` at a temporary directory and never touch the real `~/.spinner`.
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface SpinnerHome {
    /** Absolute path of the home directory, normally `~/.spinner`. */
    root: string;
    /** `<root>/sessions`, where live sessions are. */
    sessions: string;
    /** `<root>/archive`, where `spinner close` moves sessions. */
    archive: string;
    /** `<root>/plans`, the plans library (docs/designs/talk-change-ship.md, 4.1). */
    plans: string;
    /**
     * The proxy's dynamic-configuration directory. Machine-global, not per home: one
     * `spinner-proxy` serves every home, so every home writes its route files to one place.
     * `~/.spinner/proxy` unless `SPINNER_PROXY_DIR` says otherwise.
     */
    proxy: string;
    /**
     * Where `next_session_id` looks: `machine` (this home, the proxy directory's route files
     * and the running `spinner-*` projects, so two homes never share an id) or `home` (this
     * home only; `SPINNER_SESSION_IDS=home`, for tests and offline use).
     */
    ids_scope: "machine" | "home";
}

/** Reads `SPINNER_HOME` from the environment, or falls back to `~/.spinner`. */
export function resolve_home(env: NodeJS.ProcessEnv = process.env): SpinnerHome {
    const override = env["SPINNER_HOME"];
    const has_override = override !== undefined && override !== "";
    const root = has_override ? resolve(override) : join(homedir(), ".spinner");
    const proxy_override = env["SPINNER_PROXY_DIR"];
    const proxy =
        proxy_override !== undefined && proxy_override !== ""
            ? resolve(proxy_override)
            : join(homedir(), ".spinner", "proxy");
    return {
        root,
        sessions: join(root, "sessions"),
        archive: join(root, "archive"),
        plans: join(root, "plans"),
        proxy,
        // The scope is a process-wide switch (tests set it for the whole run), so the
        // process environment is consulted even when a caller passes its own.
        ids_scope: (env["SPINNER_SESSION_IDS"] ?? process.env["SPINNER_SESSION_IDS"]) === "home"
            ? "home"
            : "machine",
    };
}

/** Upper bound on directory levels to walk when looking for a `.git` ancestor. */
const ANCESTOR_LEVELS_MAX = 64;

/**
 * True when `path` or any ancestor contains a `.git` entry. The session protocol forbids a
 * Spinner home inside a git repository, because session state must never reach a work repo.
 */
export function is_inside_git_repo(path: string): boolean {
    let current = resolve(path);
    for (let level = 0; level < ANCESTOR_LEVELS_MAX; level += 1) {
        const candidate = join(current, ".git");
        if (existsSync(candidate) && is_git_entry(candidate)) {
            return true;
        }
        const parent = dirname(current);
        if (parent === current) {
            return false;
        }
        current = parent;
    }
    return false;
}

function is_git_entry(path: string): boolean {
    // A `.git` entry is a directory in a normal clone and a file in a worktree. Both count.
    const stats = statSync(path);
    return stats.isDirectory() || stats.isFile();
}
