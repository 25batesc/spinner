// Goal: the diff routes drive the viewers through the daemon as the UI will: `start` is a
// `diff` job whose finish leaves the repo `running` in the session view, `stop` answers the
// fresh view synchronously, an unknown repo is a 404, and `down` ends the viewer with the
// stack. Method: a daemon on a temporary home with the fake viewer as `diffview_bin`.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JobResponse, SessionResponse } from "@spinner/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolve_home, type SpinnerHome } from "../home.js";
import { start_daemon, type Daemon } from "../server.js";
import { process_alive } from "../stack/host-service.js";
import { create_session, write_session } from "../store/session-store.js";

const FAKE = resolve(dirname(fileURLToPath(import.meta.url)), "fake-diffview.mjs");

let home: SpinnerHome;
let daemon: Daemon;
let base: string;

beforeEach(async () => {
    home = resolve_home({ SPINNER_HOME: mkdtempSync(join(tmpdir(), "spinner-diff-routes-")) });
    daemon = await start_daemon({
        home,
        port: 0,
        operator: false,
        log: () => undefined,
        poll_seconds: 0,
        gh: () => Promise.reject(new Error("no gh in tests")),
        notify: async () => undefined,
        ui_dir: null,
        observe_interval_ms: 60_000,
        agents_harness: "rpc",
        diffview_bin: FAKE,
    });
    base = `http://127.0.0.1:${daemon.port}`;
});

afterEach(async () => {
    await daemon.close();
    rmSync(home.root, { recursive: true, force: true });
});

async function session_view(dir: string): Promise<SessionResponse["session"]> {
    const response = await fetch(`${base}/sessions/${dir}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as SessionResponse).session;
}

async function post(path: string, body?: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? "" : JSON.stringify(body),
    });
}

async function until(check: () => Promise<boolean>): Promise<void> {
    for (let poll = 0; poll < 150; poll += 1) {
        if (await check()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("condition not met in time");
}

/** A session whose one repo has a worktree directory. */
function session_with_repo(): string {
    const summary = create_session(home, { title: "Diff routes" });
    mkdirSync(join(summary.path, "repos", "app"), { recursive: true });
    summary.session.repos = { app: { path: "/repo/app", worktree: "repos/app" } };
    write_session(summary);
    return summary.dir;
}

describe("diff routes", () => {
    it("starts as a job, shows the viewer running, stops synchronously", async () => {
        const dir = session_with_repo();
        const before = await session_view(dir);
        expect(before.diff).toMatchObject({ available: true, fetch: "ready" });
        expect(before.diff?.repos["app"]?.state).toBe("stopped");

        const started = await post(`/sessions/${dir}/diff/start`, { repo: "app" });
        expect(started.status).toBe(202);
        const { job } = (await started.json()) as JobResponse;
        expect(job.action).toBe("diff");
        await until(async () => {
            const current = ((await (await fetch(`${base}/jobs/${job.id}`)).json()) as JobResponse)
                .job;
            return current.state !== "running";
        });
        const finished = ((await (await fetch(`${base}/jobs/${job.id}`)).json()) as JobResponse)
            .job;
        expect(finished.state).toBe("ok");
        expect(finished.log.join("\n")).toMatch(/diff viewer of app: pid \d+ on http/);

        const running = await session_view(dir);
        const app = running.diff?.repos["app"];
        expect(app?.state).toBe("running");
        expect(app?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
        expect(app?.pid).not.toBeNull();
        const pid = app?.pid ?? 0;
        expect(process_alive(pid)).toBe(true);
        expect(running.summary.session.diff?.repos["app"]?.pid).toBe(pid);

        const stopped = await post(`/sessions/${dir}/diff/stop`);
        expect(stopped.status).toBe(200);
        const after = ((await stopped.json()) as SessionResponse).session;
        expect(after.diff?.repos["app"]?.state).toBe("stopped");
        expect(after.summary.session.diff).toBeUndefined();
        await until(async () => !process_alive(pid));
    });

    it("answers 404 for an unknown repo and 400 for a bad body", async () => {
        const dir = session_with_repo();
        expect((await post(`/sessions/${dir}/diff/start`, { repo: "nope" })).status).toBe(404);
        expect((await post(`/sessions/${dir}/diff/stop`, { repo: "nope" })).status).toBe(404);
        expect((await post(`/sessions/${dir}/diff/start`, { repo: 7 })).status).toBe(400);
        expect((await post(`/sessions/nope/diff/start`)).status).toBe(404);
    });

    it("`down` stops the viewer with the stack", async () => {
        const dir = session_with_repo();
        const started = await post(`/sessions/${dir}/diff/start`);
        expect(started.status).toBe(202);
        await until(async () => (await session_view(dir)).diff?.repos["app"]?.state === "running");
        const pid = (await session_view(dir)).diff?.repos["app"]?.pid ?? 0;
        expect(process_alive(pid)).toBe(true);

        const down = await post(`/sessions/${dir}/down`);
        expect(down.status).toBe(202);
        const { job } = (await down.json()) as JobResponse;
        await until(async () => {
            const current = ((await (await fetch(`${base}/jobs/${job.id}`)).json()) as JobResponse)
                .job;
            return current.state !== "running";
        });
        const finished = ((await (await fetch(`${base}/jobs/${job.id}`)).json()) as JobResponse)
            .job;
        expect(finished.log.join("\n")).toMatch(/diff viewer of app \(pid \d+\): stopped/);
        await until(async () => !process_alive(pid));
        expect((await session_view(dir)).diff?.repos["app"]?.state).toBe("stopped");
    });
});
