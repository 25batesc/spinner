// The UI the daemon serves is a snapshot of `packages/ui/dist`, copied to
// `<home>/ui/<commit>/` at start. A rebuild of `dist` by a ui agent then changes nothing in a
// running daemon's window: the operator sees the UI the daemon started with, which matches
// the routes it has. Snapshots of other commits are removed at start, so the directory holds
// one build.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SpinnerHome } from "./home.js";

export interface UiSnapshot {
    /** The directory the daemon serves. */
    dir: string;
    /** The snapshot's name under `<home>/ui`: the checkout's commit, or `unversioned`. */
    commit: string;
}

/** The snapshot name when the daemon runs outside a git checkout. */
export const UI_COMMIT_UNVERSIONED = "unversioned";

/**
 * Copies `source` to `<home>/ui/<commit>/` when that snapshot is absent, removes the other
 * snapshots, and names the directory to serve. Null when `source` holds no build.
 */
export function snapshot_ui(
    home: SpinnerHome,
    source: string,
    commit: string | null,
    log: (line: string) => void,
): UiSnapshot | null {
    if (!existsSync(join(source, "index.html"))) {
        return null;
    }
    const name = commit ?? UI_COMMIT_UNVERSIONED;
    assert.ok(name.length > 0, "a snapshot needs a name");
    assert.ok(!name.includes("/"), `snapshot name "${name}" must be one path segment`);
    const root = join(home.root, "ui");
    mkdirSync(root, { recursive: true });
    const target = join(root, name);
    if (!existsSync(target)) {
        // Copy beside the target, then rename, so a crash mid-copy never leaves a half
        // snapshot under the final name.
        const staging = join(root, `.${name}.${process.pid}`);
        rmSync(staging, { recursive: true, force: true });
        cpSync(source, staging, { recursive: true });
        renameSync(staging, target);
        log(`ui: snapshot of ${source} at ${target}`);
    }
    for (const entry of readdirSync(root)) {
        if (entry !== name) {
            rmSync(join(root, entry), { recursive: true, force: true });
        }
    }
    assert.ok(existsSync(join(target, "index.html")), "the snapshot must hold index.html");
    return { dir: target, commit: name };
}
