// Goal: `watcher_live` resolves true once the watcher reports its probe file, removes the
// probe, and leaves no listener behind; a watcher that reports nothing resolves false after
// the timeout. Method: a real chokidar watcher on a temporary directory, and a bare emitter
// standing in for a dead watcher with a shortened timer.
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WATCH_PROBE_PREFIX, watcher_live } from "./live.js";

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "spinner-live-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("watcher_live", () => {
    it("resolves true on the probe's add event and removes the probe", async () => {
        const watcher = chokidar.watch(root, {
            awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
            ignoreInitial: true,
            depth: 1,
        });
        await new Promise<void>((resolve) => watcher.once("ready", () => resolve()));
        expect(await watcher_live(watcher, root)).toBe(true);
        expect(readdirSync(root).filter((name) => name.startsWith(WATCH_PROBE_PREFIX))).toEqual(
            [],
        );
        expect(watcher.listenerCount("add")).toBe(0);
        await watcher.close();
    });

    it("resolves false when the watcher never reports the probe", async () => {
        vi.useFakeTimers();
        const dead = new EventEmitter() as unknown as FSWatcher;
        const live = watcher_live(dead, root);
        const probe = readdirSync(root).find((name) => name.startsWith(WATCH_PROBE_PREFIX));
        expect(probe).toBeDefined();
        await vi.runAllTimersAsync();
        expect(await live).toBe(false);
        expect(existsSync(join(root, probe ?? ""))).toBe(false);
        vi.useRealTimers();
    });
});
