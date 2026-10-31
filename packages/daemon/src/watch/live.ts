// chokidar's `ready` says the initial scan is done, not that the native watch delivers events
// yet: on macOS, libuv starts the FSEvents stream on another thread, and a directory created
// in the first few hundred milliseconds after `ready` went unseen under load (s012, the
// plumbing test). A watcher is live once it reports a probe file written under its root, so
// both session watchers resolve `ready` on that artifact and not on the scan.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { FSWatcher } from "chokidar";

/** The probe's name starts with this; both watchers ignore files directly under the root. */
export const WATCH_PROBE_PREFIX = ".watch-probe-";

/** A watch that never reports the probe is reported, not waited on forever. */
export const WATCH_PROBE_TIMEOUT_MS = 5_000;

/**
 * Resolves once `watcher` reported the probe file this writes under `root`, or after
 * `WATCH_PROBE_TIMEOUT_MS` with `false`. The probe is removed either way. Call after
 * chokidar's `ready`, so the initial scan does not report the probe as existing.
 */
export function watcher_live(watcher: FSWatcher, root: string): Promise<boolean> {
    const nonce = randomBytes(4).toString("hex");
    const probe = join(root, `${WATCH_PROBE_PREFIX}${process.pid}-${nonce}`);
    assert.ok(basename(probe).startsWith(WATCH_PROBE_PREFIX));
    return new Promise((resolve) => {
        let settled = false;
        const finish = (live: boolean): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            watcher.removeListener("add", on_add);
            rmSync(probe, { force: true });
            resolve(live);
        };
        // By name: chokidar may report the real path (`/private/var` for `/var` on macOS).
        const on_add = (file: string): void => {
            if (basename(file) === basename(probe)) {
                finish(true);
            }
        };
        const timer = setTimeout(() => finish(false), WATCH_PROBE_TIMEOUT_MS);
        watcher.on("add", on_add);
        writeFileSync(probe, "");
    });
}
