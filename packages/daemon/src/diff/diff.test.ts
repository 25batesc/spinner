// Goal: the diff viewers behave as Spinner-managed host processes. A start records a live
// pid and the port the viewer really took; `stop_viewers` ends it and clears the record;
// `reattach_viewers` keeps a live viewer and drops a dead pid; the manager's view reads
// `running`, `stopped` and `failed` from the file and its memory; the fetch runs the pinned
// clones and `npm install` in order and writes the marker only on success.
// Method: the fake viewer in `fake-diffview.mjs`, a temporary Spinner home, a fake runner.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionSummary } from "@spinner/protocol";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import type { SpinnerHome } from "../home.js";
import { process_alive } from "../stack/host-service.js";
import { write_session } from "../store/session-store.js";
import {
    diff_fetched,
    diff_home,
    fetch_diffview,
    read_fetch_marker,
    type Runner,
} from "./fetch.js";
import { DiffManager } from "./manager.js";
import { DIFF_PINS } from "./pins.js";
import { diff_port, reattach_viewers, start_viewer, stop_viewers } from "./viewer.js";

const log = (): void => {};
const FAKE = resolve(dirname(fileURLToPath(import.meta.url)), "fake-diffview.mjs");

function make_home(): SpinnerHome {
    const root = mkdtempSync(join(tmpdir(), "spinner-diff-"));
    mkdirSync(join(root, "sessions"));
    return {
        root,
        sessions: join(root, "sessions"),
        archive: join(root, "archive"),
        proxy: join(root, "proxy"),
        ids_scope: "home",
    };
}

/** A session with two repos whose worktrees are plain directories. */
function make_session(home: SpinnerHome, id = "s031"): SessionSummary {
    const dir = `${id}-diff`;
    const path = join(home.sessions, dir);
    mkdirSync(join(path, "repos", "app"), { recursive: true });
    mkdirSync(join(path, "repos", "lib"), { recursive: true });
    const summary: SessionSummary = {
        dir,
        path,
        session: {
            version: 1,
            id,
            slug: "diff",
            title: "diff",
            created: "2026-11-01T00:00:00Z",
            stage: "building",
            needs_human: null,
            branch: "feat/diff",
            base: "main",
            repos: {
                app: { path: "/repo/app", worktree: "repos/app" },
                lib: { path: "/repo/lib", worktree: "repos/lib" },
            },
            stack: { state: "none" },
            agents: {},
        },
    };
    write_session(summary);
    return summary;
}

function read_file(summary: SessionSummary): SessionSummary["session"] {
    return parse(readFileSync(join(summary.path, "session.yaml"), "utf8"));
}

/** Viewers a test started, with their home, so the fakes never outlive the run. */
const running: { summary: SessionSummary; home: SpinnerHome }[] = [];
afterEach(async () => {
    for (const { summary, home } of running.splice(0)) {
        const fresh = { ...summary, session: read_file(summary) };
        await stop_viewers(fresh, diff_home(home), () => {}).catch(() => {});
    }
});

describe("diff_port", () => {
    it("counts down from the top of the host half", () => {
        expect(diff_port("s031", 0)).toBe(23_149);
        expect(diff_port("s031", 1)).toBe(23_148);
        expect(() => diff_port("s031", 10)).toThrow(/at most 10/);
    });
});

describe("start_viewer and stop_viewers", () => {
    it("starts detached, records the port, stops by pid and clears the file", async () => {
        const home = make_home();
        const summary = make_session(home);
        running.push({ summary, home });
        const port = diff_port("s031", 0);
        const record = await start_viewer({
            bin: FAKE,
            diff_home: diff_home(home),
            repo: "app",
            worktree: join(summary.path, "repos", "app"),
            session_dir: summary.path,
            port,
            timeout_ms: 5_000,
        });
        expect(process_alive(record.pid)).toBe(true);
        expect(record.port).toBe(port);
        expect(record.log).toBe("diff/app.log");
        expect(record.started.length).toBeGreaterThan(0);
        expect(readFileSync(join(summary.path, record.log), "utf8")).toContain("diffview serving");
        const registry = join(diff_home(home), "servers", `${record.pid}.json`);
        expect(existsSync(registry)).toBe(true);

        summary.session.diff = { repos: { app: record } };
        write_session(summary);
        const lines: string[] = [];
        await stop_viewers(summary, diff_home(home), (line) => lines.push(line));
        expect(lines[0]).toMatch(/diff viewer of app \(pid \d+\): stopped/);
        expect(existsSync(registry)).toBe(false);
        expect(read_file(summary).diff).toBeUndefined();
        for (let poll = 0; poll < 50 && process_alive(record.pid); poll += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    });

    it("records the port the viewer moved to when the first one is taken", async () => {
        const home = make_home();
        const summary = make_session(home, "s032");
        running.push({ summary, home });
        const port = diff_port("s032", 0);
        const first = await start_viewer({
            bin: FAKE,
            diff_home: diff_home(home),
            repo: "app",
            worktree: join(summary.path, "repos", "app"),
            session_dir: summary.path,
            port,
            timeout_ms: 5_000,
        });
        const second = await start_viewer({
            bin: FAKE,
            diff_home: diff_home(home),
            repo: "lib",
            worktree: join(summary.path, "repos", "lib"),
            session_dir: summary.path,
            port,
            timeout_ms: 5_000,
        });
        expect(first.port).toBe(port);
        expect(second.port).toBe(port + 1);
        summary.session.diff = { repos: { app: first, lib: second } };
        write_session(summary);
    });

    it("fails with the log's tail when the viewer exits", async () => {
        const home = make_home();
        const summary = make_session(home, "s033");
        process.env["FAKE_DIFFVIEW_EXIT"] = "no such repo";
        try {
            await expect(
                start_viewer({
                    bin: FAKE,
                    diff_home: diff_home(home),
                    repo: "app",
                    worktree: join(summary.path, "repos", "app"),
                    session_dir: summary.path,
                    port: diff_port("s033", 0),
                    timeout_ms: 5_000,
                }),
            ).rejects.toThrow(/viewer of app exited:[\s\S]*no such repo/);
        } finally {
            delete process.env["FAKE_DIFFVIEW_EXIT"];
        }
    });
});

describe("reattach_viewers", () => {
    it("keeps a live viewer and drops a dead pid", async () => {
        const home = make_home();
        const summary = make_session(home, "s034");
        running.push({ summary, home });
        const live = await start_viewer({
            bin: FAKE,
            diff_home: diff_home(home),
            repo: "app",
            worktree: join(summary.path, "repos", "app"),
            session_dir: summary.path,
            port: diff_port("s034", 0),
            timeout_ms: 5_000,
        });
        summary.session.diff = {
            repos: {
                app: live,
                lib: { pid: 2_147_483_000, started: "Thu Jan  1 00:00:00 1970", port: 1, log: "x" },
            },
        };
        write_session(summary);
        const lines: string[] = [];
        expect(await reattach_viewers(summary, (line) => lines.push(line))).toEqual(["app"]);
        expect(lines).toEqual([
            `diff viewer of app: reattached pid ${live.pid} on port ${live.port}`,
            "diff viewer of lib: pid 2147483000 is gone",
        ]);
        expect(Object.keys(read_file(summary).diff?.repos ?? {})).toEqual(["app"]);
    });
});

describe("DiffManager", () => {
    it("views stopped repos as absent until the fetch, then starts and stops them", async () => {
        const home = make_home();
        const summary = make_session(home, "s035");
        running.push({ summary, home });
        const absent = new DiffManager({ home, log: () => {}, runner: refusing_runner });
        expect(absent.view(summary)).toEqual({
            available: false,
            fetch: "absent",
            fetch_error: null,
            repos: { app: IDLE, lib: IDLE },
        });

        const manager = new DiffManager({ home, log, bin: FAKE, start_timeout_ms: 5_000 });
        expect(manager.fetch_state()).toBe("ready");
        const lines: string[] = [];
        await manager.start(summary, "app", (line) => lines.push(line));
        expect(lines[0]).toMatch(/diff viewer of app: pid \d+ on http:\/\/127\.0\.0\.1:23549\//);
        const fresh = { ...summary, session: read_file(summary) };
        const view = manager.view(fresh);
        expect(view.available).toBe(true);
        expect(view.repos["app"]?.state).toBe("running");
        expect(view.repos["app"]?.url).toBe("http://127.0.0.1:23549/");
        expect(view.repos["lib"]?.state).toBe("stopped");

        await manager.start(fresh, "app", (line) => lines.push(line));
        expect(lines[1]).toMatch(/already runs/);

        await expect(manager.start(fresh, "nope", () => {})).rejects.toThrow(/no repo nope/);

        await manager.stop(fresh, undefined, () => {});
        const after = { ...summary, session: read_file(summary) };
        expect(manager.view(after).repos["app"]?.state).toBe("stopped");
        expect(after.session.diff).toBeUndefined();
    });

    it("remembers a failed start as `failed` with its error", async () => {
        const home = make_home();
        const summary = make_session(home, "s036");
        const manager = new DiffManager({ home, log, bin: FAKE, start_timeout_ms: 5_000 });
        process.env["FAKE_DIFFVIEW_EXIT"] = "boom";
        try {
            await expect(manager.start(summary, "lib", () => {})).rejects.toThrow(/boom/);
        } finally {
            delete process.env["FAKE_DIFFVIEW_EXIT"];
        }
        const view = manager.view(summary);
        expect(view.repos["lib"]?.state).toBe("failed");
        expect(view.repos["lib"]?.error).toMatch(/boom/);
    });
});

const IDLE = {
    state: "stopped",
    url: null,
    pid: null,
    error: null,
    waiting: { agent: 0, human: 0 },
};

const refusing_runner: Runner = () => Promise.reject(new Error("the test must not fetch"));

describe("fetch_diffview", () => {
    it("clones both pins, installs, checks, and writes the marker", async () => {
        const home = make_home();
        const calls: string[] = [];
        const runner: Runner = (command, args, options) => {
            calls.push(`${command} ${args.join(" ")} @${options?.cwd?.slice(home.root.length)}`);
            if (command === "git" && args[0] === "checkout") {
                const bin = join(options?.cwd ?? "", "bin");
                mkdirSync(bin, { recursive: true });
                writeFileSync(join(bin, "diffview.mjs"), "");
            }
            return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        };
        expect(diff_fetched(home)).toBe(false);
        const marker = await fetch_diffview(home, () => {}, runner);
        expect(marker.viewer).toBe(DIFF_PINS.viewer.sha);
        expect(calls).toEqual([
            "git init --quiet @/diffview/src/peanut",
            "git remote add origin https://github.com/adamsanghera/peanut.git @/diffview/src/peanut",
            `git fetch --quiet --depth 1 origin ${DIFF_PINS.peanut.sha} @/diffview/src/peanut`,
            "git checkout --quiet FETCH_HEAD @/diffview/src/peanut",
            "git init --quiet @/diffview/src/diff-viewer",
            "git remote add origin https://github.com/adamsanghera/diff-viewer.git @/diffview/src/diff-viewer",
            `git fetch --quiet --depth 1 origin ${DIFF_PINS.viewer.sha} @/diffview/src/diff-viewer`,
            "git checkout --quiet FETCH_HEAD @/diffview/src/diff-viewer",
            "npm install --no-audit --no-fund @/diffview/src/diff-viewer",
            "node bin/diffview.mjs --help @/diffview/src/diff-viewer",
        ]);
        expect(read_fetch_marker(home)?.peanut).toBe(DIFF_PINS.peanut.sha);
        expect(diff_fetched(home)).toBe(true);
    });

    it("fails on a non-zero step and leaves no marker", async () => {
        const home = make_home();
        const runner: Runner = (command) =>
            Promise.resolve(
                command === "npm"
                    ? { code: 1, stdout: "", stderr: "ERESOLVE" }
                    : { code: 0, stdout: "", stderr: "" },
            );
        await expect(fetch_diffview(home, log, runner)).rejects.toThrow(
            /npm install.*exited 1[\s\S]*ERESOLVE/,
        );
        expect(read_fetch_marker(home)).toBeNull();
        const manager = new DiffManager({ home, log: () => {}, runner });
        const summary = make_session(home, "s037");
        await expect(manager.start(summary, undefined, () => {})).rejects.toThrow(/ERESOLVE/);
        expect(manager.fetch_state()).toBe("failed");
        expect(manager.view(summary).fetch_error).toMatch(/ERESOLVE/);
    });
});
