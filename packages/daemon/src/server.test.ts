// Goal: the daemon serves GET /sessions as SessionViews from disk, runs every POST as a job
// with job.* events, emits session.created on the WebSocket when a session directory
// appears, and serves the UI build at `/`, all without state of its own. Method: start a
// daemon on an ephemeral port against a temporary SPINNER_HOME with the poller off, call it
// with fetch and a ws client, and create sessions on disk the way the CLI does.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
    JobResponse,
    ProjectsResponse,
    SessionResponse,
    SessionsResponse,
    SpinnerEvent,
} from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "./home.js";
import { start_daemon, type Daemon, type DaemonOptions } from "./server.js";
import { create_session } from "./store/session-store.js";

let home: SpinnerHome;
let daemon: Daemon;
let base: string;

/** No GitHub, no banners, no UI, no docker rounds: the tests exercise the routes alone. */
function test_options(ui_dir: string | null = null): DaemonOptions {
    return {
        home,
        port: 0,
        log: () => undefined,
        poll_seconds: 0,
        gh: () => Promise.reject(new Error("no gh in tests")),
        notify: async () => undefined,
        ui_dir,
        observe_interval_ms: 60_000,
    };
}

beforeEach(async () => {
    home = resolve_home({ SPINNER_HOME: mkdtempSync(join(tmpdir(), "spinner-daemon-")) });
    daemon = await start_daemon(test_options());
    base = `http://127.0.0.1:${daemon.port}`;
});

afterEach(async () => {
    await daemon.close();
    rmSync(home.root, { recursive: true, force: true });
});

/** Opens a WebSocket client and resolves once the connection is open. */
function connect(origin: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const client = new WebSocket(`ws://127.0.0.1:${daemon.port}/events`, {
            headers: { origin },
        });
        client.once("open", () => resolve(client));
        client.once("error", reject);
    });
}

/** Polls `check` until it is true, at most 3 s. */
async function until(check: () => boolean): Promise<void> {
    for (let poll = 0; poll < 150; poll += 1) {
        if (check()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("condition not met in time");
}

/** Resolves with the next event the client receives, or rejects after a bounded wait. */
function next_event(client: WebSocket, timeout_ms = 3000): Promise<SpinnerEvent> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no event in time")), timeout_ms);
        client.once("message", (raw) => {
            clearTimeout(timer);
            resolve(JSON.parse(String(raw)) as SpinnerEvent);
        });
    });
}

describe("REST", () => {
    it("GET /health reports the home", async () => {
        const response = await fetch(`${base}/health`);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ ok: true, home: home.root });
    });

    it("GET /sessions reads sessions fresh from disk", async () => {
        const empty = (await (await fetch(`${base}/sessions`)).json()) as SessionsResponse;
        expect(empty.sessions).toEqual([]);

        create_session(home, { title: "Alpha" });
        const one = (await (await fetch(`${base}/sessions`)).json()) as SessionsResponse;
        expect(one.sessions.map((entry) => entry.summary.dir)).toEqual(["s001-alpha"]);
        expect(one.sessions[0]?.summary.session.title).toBe("Alpha");
        expect(one.sessions[0]?.board).toBeNull();
        expect(one.sessions[0]?.stack).toEqual({
            state: "none",
            project: null,
            database: null,
            services: [],
            observed: null,
        });
    });

    it("GET /projects lists the sample stack", async () => {
        const body = (await (await fetch(`${base}/projects`)).json()) as ProjectsResponse;
        const sample = body.projects.find((project) => project.name === "sample");
        expect(sample?.source).toBe("examples");
        expect(sample?.services).toEqual(["api", "web", "temporal"]);
    });

    it("GET /sessions/:dir and /mission return one session, 404 otherwise", async () => {
        create_session(home, { title: "Alpha" });
        const found = await fetch(`${base}/sessions/s001-alpha`);
        expect(found.status).toBe(200);
        const view = ((await found.json()) as SessionResponse).session;
        expect(view.summary.session.id).toBe("s001");

        const mission = await fetch(`${base}/sessions/s001-alpha/mission`);
        expect(mission.status).toBe(200);
        expect(mission.headers.get("content-type")).toMatch(/text\/markdown/);
        expect(await mission.text()).toMatch(/^# s001 · Alpha\n/);

        expect((await fetch(`${base}/sessions/nope`)).status).toBe(404);
        expect((await fetch(`${base}/sessions/nope/mission`)).status).toBe(404);
    });

    it("POST /sessions creates a session as a job and rejects a bad body", async () => {
        const client = await connect("http://localhost:5173");
        const events: SpinnerEvent[] = [];
        client.on("message", (raw) => events.push(JSON.parse(String(raw)) as SpinnerEvent));
        const created = await fetch(`${base}/sessions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "From the UI" }),
        });
        expect(created.status).toBe(202);
        const { job } = (await created.json()) as JobResponse;
        expect(job.action).toBe("new");
        expect(job.session).toBe("s001-from-the-ui");
        await until(() => events.some((event) => event.type === "job.finished"));
        const finished = events.find((event) => event.type === "job.finished");
        expect(finished).toMatchObject({ job: job.id, ok: true, session: "s001-from-the-ui" });
        const log_lines = events.filter((event) => event.type === "job.log");
        expect(log_lines.map((event) => event.type === "job.log" && event.line)).toEqual([
            `created ${join(home.sessions, "s001-from-the-ui")}`,
        ]);
        const fetched = (await (await fetch(`${base}/jobs/${job.id}`)).json()) as JobResponse;
        expect(fetched.job.state).toBe("ok");
        expect(fetched.job.log).toHaveLength(1);
        expect((await fetch(`${base}/jobs/j-999`)).status).toBe(404);
        client.close();

        const bad = await fetch(`${base}/sessions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "" }),
        });
        expect(bad.status).toBe(400);
        const not_json = await fetch(`${base}/sessions`, { method: "POST", body: "nope" });
        expect(not_json.status).toBe(400);
    });

    it("POST /sessions with an unknown project fails before writing anything", async () => {
        const response = await fetch(`${base}/sessions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "Bad project", project: "no-such-project" }),
        });
        expect(response.status).toBe(409);
        const listed = (await (await fetch(`${base}/sessions`)).json()) as SessionsResponse;
        expect(listed.sessions).toEqual([]);
    });

    it("POST /sessions/:dir/verify runs as a job and reports the failure", async () => {
        create_session(home, { title: "Alpha" });
        const client = await connect("http://localhost:5173");
        const events: SpinnerEvent[] = [];
        client.on("message", (raw) => events.push(JSON.parse(String(raw)) as SpinnerEvent));
        const response = await fetch(`${base}/sessions/s001/verify`, { method: "POST" });
        expect(response.status).toBe(202);
        const { job } = (await response.json()) as JobResponse;
        expect(job.session).toBe("s001-alpha");
        await until(() => events.some((event) => event.type === "job.finished"));
        const finished = events.find((event) => event.type === "job.finished");
        expect(finished).toMatchObject({ ok: false, error: "session s001 has no PR to verify" });
        expect((await fetch(`${base}/sessions/nope/verify`, { method: "POST" })).status).toBe(404);
        client.close();
    });

    it("GET / says how to build the UI when there is none, and serves a build", async () => {
        const missing = await fetch(`${base}/`);
        expect(missing.status).toBe(503);
        expect(await missing.text()).toMatch(/pnpm --filter @spinner\/ui build/);

        const ui_dir = mkdtempSync(join(tmpdir(), "spinner-ui-"));
        mkdirSync(join(ui_dir, "assets"));
        writeFileSync(join(ui_dir, "index.html"), "<html><body>spinner ui</body></html>");
        writeFileSync(join(ui_dir, "assets", "app.js"), "console.log(1);");
        const served = await start_daemon(test_options(ui_dir));
        const index = await fetch(`http://127.0.0.1:${served.port}/`);
        expect(index.status).toBe(200);
        expect(await index.text()).toContain("spinner ui");
        const asset = await fetch(`http://127.0.0.1:${served.port}/assets/app.js`);
        expect(asset.status).toBe(200);
        expect(asset.headers.get("content-type")).toMatch(/javascript/);
        const api = await fetch(`http://127.0.0.1:${served.port}/sessions`);
        expect(api.status).toBe(200);
        await served.close();
        rmSync(ui_dir, { recursive: true, force: true });
    });

    it("answers CORS preflight", async () => {
        const response = await fetch(`${base}/sessions`, {
            method: "OPTIONS",
            headers: { origin: "http://localhost:5173", "access-control-request-method": "GET" },
        });
        expect(response.headers.get("access-control-allow-origin")).toBe("*");
    });
});

describe("WebSocket /events", () => {
    it("emits session.created when a session directory appears", async () => {
        const client = await connect("http://localhost:5173");
        const pending = next_event(client);
        create_session(home, { title: "Watched" });
        const event = await pending;
        expect(event.type).toBe("session.created");
        expect(event.session).toBe("s001-watched");
        if (event.type === "session.created") {
            expect(event.data.summary.session.title).toBe("Watched");
        }
        client.close();
    });

    it("emits session.updated and session.closed as the file changes", async () => {
        const client = await connect("http://example.com");
        const created = next_event(client);
        const summary = create_session(home, { title: "Edited" });
        expect((await created).type).toBe("session.created");

        const updated = next_event(client);
        const file = join(summary.path, "session.yaml");
        const edited = "version: 1\nid: s001\nslug: edited\ntitle: Edited 2\nstage: building\n";
        writeFileSync(file, edited);
        expect((await updated).type).toBe("session.updated");

        const closed = next_event(client);
        rmSync(file);
        expect((await closed).type).toBe("session.closed");
        client.close();
    });

    it("rejects an upgrade on any other path", async () => {
        const client = new WebSocket(`ws://127.0.0.1:${daemon.port}/other`);
        const failure = await new Promise<Error>((resolve) => client.once("error", resolve));
        expect(failure.message).toMatch(/404/);
    });
});
