// Watches `<home>/sessions/*/session.yaml` and turns file changes into session events. The
// watcher is the reason the daemon can be stateless: whoever writes a session directory, the
// CLI or a person with `mkdir`, the daemon sees it the same way.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { basename, dirname, relative, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { SessionSummary, SessionView, SpinnerEvent } from "@spinner/protocol";
import type { EventBus } from "./event-bus.js";
import type { SpinnerHome } from "./home.js";
import { read_session } from "./store/session-store.js";

/** Builds the view an event carries; the daemon's view context supplies it. */
export type ViewBuilder = (summary: SessionSummary) => SessionView;

export interface SessionWatcher {
    /** Resolves once the initial scan is complete and new files will be reported. */
    ready: Promise<void>;
    close(): Promise<void>;
}

export interface WatcherOptions {
    /** Clock for event timestamps. Defaults to the wall clock. */
    now?: () => Date;
    /** Reporter for files that changed but could not be read. Defaults to console.error. */
    on_error?: (message: string) => void;
}

/**
 * Starts the watcher. Only `session.yaml` one level below the sessions directory counts; the
 * daemon ignores every other file for now (MISSION.md and inbox/ come with M2).
 */
export function watch_sessions(
    home: SpinnerHome,
    bus: EventBus,
    view: ViewBuilder,
    options: WatcherOptions = {},
): SessionWatcher {
    const now = options.now ?? (() => new Date());
    const on_error = options.on_error ?? ((message) => console.error(message));
    mkdirSync(home.sessions, { recursive: true });

    const watcher: FSWatcher = chokidar.watch(home.sessions, {
        // `new` writes session.yaml in one call, but a human editor may write in several.
        // Waiting for the file to go quiet avoids reading a half-written YAML file.
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
        ignoreInitial: true,
        depth: 1,
    });

    const emit = (kind: "add" | "change" | "unlink", file: string): void => {
        const dir = session_dir_of(home, file);
        if (dir === null) {
            return;
        }
        const event = event_for(home, view, kind, dir, now().toISOString());
        if (typeof event === "string") {
            on_error(event);
            return;
        }
        bus.publish(event);
    };

    watcher.on("add", (file) => emit("add", file));
    watcher.on("change", (file) => emit("change", file));
    watcher.on("unlink", (file) => emit("unlink", file));
    watcher.on("error", (error) => on_error(`watcher: ${String(error)}`));

    const ready = new Promise<void>((resolve) => {
        watcher.once("ready", () => resolve());
    });
    return { ready, close: () => watcher.close() };
}

/** The session directory name when `file` is `<sessions>/<dir>/session.yaml`, else null. */
export function session_dir_of(home: SpinnerHome, file: string): string | null {
    if (basename(file) !== "session.yaml") {
        return null;
    }
    const rel = relative(home.sessions, dirname(file));
    if (rel === "" || rel.startsWith("..") || rel.includes(sep)) {
        return null;
    }
    return rel;
}

function event_for(
    home: SpinnerHome,
    view: ViewBuilder,
    kind: "add" | "change" | "unlink",
    dir: string,
    ts: string,
): SpinnerEvent | string {
    assert.ok(dir.length > 0);
    if (kind === "unlink") {
        return { type: "session.closed", ts, session: dir };
    }
    const read = read_session(home, dir);
    if (!read.ok) {
        return `ignored ${kind} of ${dir}/session.yaml: ${read.error}`;
    }
    const type = kind === "add" ? "session.created" : "session.updated";
    return { type, ts, session: dir, data: view(read.summary) };
}
