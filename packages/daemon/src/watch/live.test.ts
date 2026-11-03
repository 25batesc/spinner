// Goal: `watcher_live` resolves true once the watcher reports its probe file, removes the
// probe, and leaves no listener behind; a watcher that reports nothing resolves false after
// the timeout. Method: a real chokidar watcher on a temporary directory, and a bare emitter
// standing in for a dead watcher with a shortened timer. The session-files watcher routes a
// file directly in `<session>/design/` to `on_design`, and nothing for a dotfile there or for
// the `egm-runs` tree (EGM, 2.15): a real watcher on a scratch home, waited on its calls.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve_home } from "../home.js";
import { WATCH_PROBE_PREFIX, watcher_live } from "./live.js";
import { watch_session_files } from "./session-files.js";

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

describe("watch_session_files: the design directory (2.14)", () => {
    it("calls on_design for a design file, not for a dotfile or under egm-runs", async () => {
        const home = resolve_home({ SPINNER_HOME: root });
        const session = join(home.sessions, "s1-x");
        mkdirSync(join(session, "design"), { recursive: true });
        mkdirSync(join(session, "egm-runs", "run-1"), { recursive: true });
        const calls: string[] = [];
        const errors: string[] = [];
        const record = (name: string) => (dir: string, file?: string | "add" | "change") =>
            calls.push(`${name} ${dir} ${String(file)}`);
        const files = watch_session_files(home, {
            on_mission: record("mission"),
            on_notes: record("notes"),
            on_inbox: record("inbox"),
            on_design: record("design"),
            // A liveness probe that times out under load is reported here; the routing is
            // what this test checks, so errors are kept apart.
            on_error: (message) => errors.push(message),
        });
        await files.ready;
        writeFileSync(join(session, "design", ".state.json"), "{}");
        writeFileSync(join(session, "egm-runs", "run-1", "status.json"), "{}");
        // Wait on the artifact, 10 s at most, then 500 ms for any late, wrong call. The write
        // repeats every second, in case the native watch starts late under load.
        const deadline = Date.now() + 10_000;
        for (let n = 0; calls.length === 0 && Date.now() < deadline; n += 1) {
            if (n % 50 === 0) {
                writeFileSync(join(session, "design", "concepts_brief.md"), `# Brief ${n}\n`);
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        await files.close();
        expect(errors.every((error) => error.includes("probe file was not reported"))).toBe(true);
        expect(calls[0]).toBe("design s1-x concepts_brief.md");
        expect(calls.every((call) => call === "design s1-x concepts_brief.md")).toBe(true);
    }, 20_000);
});
