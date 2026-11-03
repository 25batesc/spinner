// Watches the files agents write inside each session: `MISSION.md`, `agents/<name>/NOTES.md`
// and new files in `inbox/`. The daemon's session watcher (`watcher.ts`) stops at
// `session.yaml`; this one goes three levels down and skips the heavy directories
// (worktrees, transcripts, logs), so a session with a checked-out monorepo costs nothing to
// watch. The handlers decide what a change means; this module only names the file.
import { mkdirSync } from "node:fs";
import { basename, relative, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { SpinnerHome } from "../home.js";
import { watcher_live } from "./live.js";

export interface SessionFileHandlers {
    /** `MISSION.md` was written. `kind` is `add` when the file appeared (a new session). */
    on_mission(dir: string, kind: "add" | "change"): void;
    on_notes(dir: string, agent: string): void;
    on_inbox(dir: string, file: string): void;
    /** A file directly in `<session>/design/` was written; dotfiles are not reported (2.14). */
    on_design(dir: string, file: string): void;
    on_error(message: string): void;
}

export interface SessionFilesWatcher {
    ready: Promise<void>;
    close(): Promise<void>;
}

/** Directory names under a session the watcher never descends into. */
const SKIPPED = new Set([
    "worktrees",
    "log",
    "artifacts",
    "stack",
    "skills",
    "threads",
    "pi",
    // The Goldfish watcher polls this tree on purpose (EGM, 4.4); here it would only stat
    // pi-subagents' temp files.
    "egm-runs",
    ".git",
    "node_modules",
]);

export function watch_session_files(
    home: SpinnerHome,
    handlers: SessionFileHandlers,
): SessionFilesWatcher {
    mkdirSync(home.sessions, { recursive: true });
    const watcher: FSWatcher = chokidar.watch(home.sessions, {
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
        ignoreInitial: true,
        depth: 3,
        ignored: (path, stats) => {
            if (stats !== undefined && !stats.isDirectory()) {
                return false;
            }
            return SKIPPED.has(basename(path)) && path !== home.sessions;
        },
    });

    const route = (kind: "add" | "change", file: string): void => {
        const parts = relative(home.sessions, file).split(sep);
        const dir = parts[0];
        if (dir === undefined || dir.length === 0 || dir.startsWith("..")) {
            return;
        }
        if (parts.length === 2 && parts[1] === "MISSION.md") {
            handlers.on_mission(dir, kind);
            return;
        }
        if (parts.length === 4 && parts[1] === "agents" && parts[3] === "NOTES.md") {
            handlers.on_notes(dir, parts[2] ?? "");
            return;
        }
        if (kind === "add" && parts.length === 3 && parts[1] === "inbox") {
            handlers.on_inbox(dir, parts[2] ?? "");
            return;
        }
        const name = parts[2] ?? "";
        if (parts.length === 3 && parts[1] === "design" && !name.startsWith(".")) {
            handlers.on_design(dir, name);
        }
    };

    watcher.on("add", (file) => route("add", file));
    watcher.on("change", (file) => route("change", file));
    watcher.on("error", (error) => handlers.on_error(`session files watcher: ${String(error)}`));
    const ready = new Promise<void>((resolve) => {
        watcher.once("ready", () => resolve());
    }).then(async () => {
        if (!(await watcher_live(watcher, home.sessions))) {
            handlers.on_error("session files watcher: the probe file was not reported");
        }
    });
    return { ready, close: () => watcher.close() };
}
