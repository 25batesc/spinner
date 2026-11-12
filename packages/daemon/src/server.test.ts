// Goal: the daemon serves GET /sessions as SessionViews from disk, runs every POST as a job
// with job.* events, emits session.created on the WebSocket when a session directory
// appears, and serves the UI build at `/`, all without state of its own. Method: start a
// daemon on an ephemeral port against a temporary SPINNER_HOME with the poller off, call it
// with fetch and a ws client, and create sessions on disk the way the CLI does.
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
    AgentCommandResponse,
    AgentEventsResponse,
    AgentResponse,
    JobResponse,
    JobsResponse,
    ModelsResponse,
    ProjectsResponse,
    SessionResponse,
    SessionsResponse,
    SpinnerEvent,
} from "@spinner/protocol";
import { resolve_project } from "./actions.js";
import { resolve_home, type SpinnerHome } from "./home.js";
import { start_daemon, type Daemon, type DaemonOptions } from "./server.js";
import { create_session, read_session } from "./store/session-store.js";

let home: SpinnerHome;
let daemon: Daemon;
let base: string;
/** The fallback banners the daemon ran: title, message and session of each. */
let banners: [string, string, string | null][];

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(here, "..", "test", "fixtures", "fake-pi.ts");

/** No GitHub, no banners, no UI, no docker rounds: the tests exercise the routes alone. */
function test_options(ui_dir: string | null = null): DaemonOptions {
    return {
        home,
        port: 0,
        operator: false,
        log: () => undefined,
        poll_seconds: 0,
        gh: () => Promise.reject(new Error("no gh in tests")),
        notify: async (title, message, session) => {
            banners.push([title, message, session]);
        },
        ui_dir,
        observe_interval_ms: 60_000,
        pi: FAKE_PI,
        agents_harness: "rpc",
    };
}

beforeEach(async () => {
    chmodSync(FAKE_PI, 0o755);
    banners = [];
    home = resolve_home({ SPINNER_HOME: mkdtempSync(join(tmpdir(), "spinner-daemon-")) });
    daemon = await start_daemon(test_options());
    base = `http://127.0.0.1:${daemon.port}`;
});

afterEach(async () => {
    await daemon.close();
    rmSync(home.root, { recursive: true, force: true });
});

/** Opens a WebSocket client and resolves once the connection is open. */
function connect(origin: string, query = ""): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const client = new WebSocket(`ws://127.0.0.1:${daemon.port}/events${query}`, {
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
        // A temporary home is not `~/.spinner`: the UI's note about a foreign home reads this.
        expect(await response.json()).toMatchObject({
            ok: true,
            home: home.root,
            home_default: false,
        });
    });

    it("GET /sessions reads sessions fresh from disk", async () => {
        const empty = (await (await fetch(`${base}/sessions`)).json()) as SessionsResponse;
        expect(empty.sessions).toEqual([]);

        create_session(home, { title: "Alpha" });
        const one = (await (await fetch(`${base}/sessions`)).json()) as SessionsResponse;
        expect(one.sessions.map((entry) => entry.summary.dir)).toEqual(["s001-alpha"]);
        expect(one.sessions[0]?.summary.session.title).toBe("Alpha");
        expect(one.sessions[0]?.board).toBeNull();
        expect(one.sessions[0]?.can_verify).toBe(false);
        expect(one.sessions[0]?.stack).toEqual({
            state: "none",
            project: null,
            database: null,
            services: [],
            observed: null,
            last_job: null,
            usage: null,
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
        const listed = (await (await fetch(`${base}/jobs`)).json()) as JobsResponse;
        expect(listed.jobs.map((entry) => entry.id)).toEqual([job.id]);
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

    it("a project name from GET /projects resolves to its spec path", async () => {
        const body = (await (await fetch(`${base}/projects`)).json()) as ProjectsResponse;
        const sample = body.projects.find((project) => project.name === "sample");
        const ctx = { home, cwd: home.root, gh: () => Promise.reject(new Error("no gh")) };
        expect(resolve_project(ctx, "sample")).toBe(sample?.path);
        expect(resolve_project(ctx, sample?.path ?? "")).toBe(sample?.path);
        expect(() => resolve_project(ctx, "no-such-project")).toThrow(/not found/);
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

    it("POST /sessions/:dir/verify runs as a job and ticks a session without a PR", async () => {
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
        expect(finished).toMatchObject({ ok: true });
        const view = (await (await fetch(`${base}/sessions/s001-alpha`)).json()) as SessionResponse;
        expect(view.session.summary.session.pipeline).toMatchObject({
            verified_locally: true,
            verified_heads: {},
        });
        expect((await fetch(`${base}/sessions/nope/verify`, { method: "POST" })).status).toBe(404);
        client.close();
    });

    it("DELETE /sessions/:dir/verify clears the tick and answers the new view", async () => {
        create_session(home, { title: "Alpha" });
        const ticked = await fetch(`${base}/sessions/s001/verify`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ by: "cullen" }),
        });
        expect(ticked.status).toBe(202);
        await until(() => {
            const read = read_session(home, "s001-alpha");
            return read.ok && read.summary.session.pipeline?.verified_locally === true;
        });
        const response = await fetch(`${base}/sessions/s001/verify`, { method: "DELETE" });
        expect(response.status).toBe(200);
        const { session } = (await response.json()) as SessionResponse;
        expect(session.summary.session.pipeline).toEqual({
            verified_locally: false,
            slack_post: null,
        });
        const read = read_session(home, "s001-alpha");
        expect(read.ok && read.summary.session.pipeline?.verified_by).toBeUndefined();
        expect((await fetch(`${base}/sessions/nope/verify`, { method: "DELETE" })).status).toBe(
            404,
        );
    });

    it("GET / says how to build the UI when there is none, and serves a build", async () => {
        const missing = await fetch(`${base}/`);
        expect(missing.status).toBe(503);
        expect(await missing.text()).toMatch(/pnpm --filter @spinner\/ui build/);

        const ui_dir = mkdtempSync(join(tmpdir(), "spinner-ui-"));
        mkdirSync(join(ui_dir, "assets"));
        writeFileSync(join(ui_dir, "index.html"), "<html><body>spinner ui</body></html>");
        writeFileSync(join(ui_dir, "assets", "app.js"), "console.log(1);");
        // A stale snapshot of another commit is removed at start.
        mkdirSync(join(home.root, "ui", "0ld0ld0"), { recursive: true });
        const served = await start_daemon({
            ...test_options(ui_dir),
            build: { version: "0.0.0", commit: "abc1234", built: null },
        });
        const index = await fetch(`http://127.0.0.1:${served.port}/`);
        expect(index.status).toBe(200);
        expect(await index.text()).toContain("spinner ui");
        const asset = await fetch(`http://127.0.0.1:${served.port}/assets/app.js`);
        expect(asset.status).toBe(200);
        expect(asset.headers.get("content-type")).toMatch(/javascript/);
        const api = await fetch(`http://127.0.0.1:${served.port}/sessions`);
        expect(api.status).toBe(200);

        // The daemon serves a snapshot under `<home>/ui/<commit>`, so a rebuild of the
        // source dist does not change what a running daemon serves.
        const snapshot = join(home.root, "ui", "abc1234");
        expect(existsSync(join(snapshot, "assets", "app.js"))).toBe(true);
        expect(existsSync(join(home.root, "ui", "0ld0ld0"))).toBe(false);
        writeFileSync(join(ui_dir, "index.html"), "<html><body>rebuilt</body></html>");
        expect(await (await fetch(`http://127.0.0.1:${served.port}/`)).text()).toContain(
            "spinner ui",
        );
        const health = (await (await fetch(`http://127.0.0.1:${served.port}/health`)).json()) as {
            ui_commit: string | null;
        };
        expect(health.ui_commit).toBe("abc1234");
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

describe("agents", () => {
    it("adds, prompts, steers, aborts and stops an agent; GET /models lists models", async () => {
        const summary = create_session(home, { title: "Alpha" });
        const post = (path: string, body?: unknown): Promise<Response> =>
            fetch(`${base}${path}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        expect((await post("/sessions/s001/agents", { name: "Bad Name" })).status).toBe(400);
        expect((await post("/sessions/nope/agents", { name: "backend" })).status).toBe(404);
        const no_worktree = await post("/sessions/s001/agents", { name: "backend", repo: "zz" });
        expect(no_worktree.status).toBe(409);
        expect(await no_worktree.json()).toMatchObject({
            error: expect.stringMatching(/no worktree/),
        });

        mkdirSync(join(summary.path, "agents", "backend"), { recursive: true });
        writeFileSync(join(summary.path, "agents", "backend", "BRIEF.md"), "# backend\n");
        const client = await connect("http://localhost:5173");
        const events: SpinnerEvent[] = [];
        client.on("message", (raw) => events.push(JSON.parse(String(raw)) as SpinnerEvent));
        const added = await post("/sessions/s001/agents", { name: "backend" });
        expect(added.status).toBe(201);
        expect((await added.json()) as AgentResponse).toEqual({
            name: "backend",
            pi_session_id: "backend",
            // r3.1 (#37): a new agent gets its first turn from the daemon.
            first_turn: "started",
        });
        const view = (await (await fetch(`${base}/sessions/s001-alpha`)).json()) as SessionResponse;
        expect(view.session.agents_running).toEqual(["backend"]);

        const prompted = await post("/sessions/s001-alpha/agents/backend/prompt", { text: "hi" });
        expect(prompted.status).toBe(200);
        expect((await prompted.json()) as AgentCommandResponse).toEqual({
            ok: true,
            disposition: "started",
        });
        await until(() => events.some((event) => event.type === "agent.settled"));
        expect(events.some((event) => event.type === "agent.event")).toBe(true);
        expect((await post("/sessions/s001-alpha/agents/backend/steer", {})).status).toBe(400);
        const steered = await post("/sessions/s001-alpha/agents/backend/steer", { text: "go" });
        expect((await steered.json()) as AgentCommandResponse).toEqual({
            ok: true,
            disposition: "queued",
        });
        // Dogfood #45: compact reaches pi (the fake records it with the steers), answers at
        // once, and logs the figure; the fake transcript has no usage, so it reads `?`.
        const compacted = await post("/sessions/s001-alpha/agents/backend/compact");
        expect(compacted.status).toBe(200);
        expect((await compacted.json()) as AgentCommandResponse).toEqual({
            ok: true,
            disposition: "started",
        });
        expect((await post("/sessions/s001-alpha/agents/nobody/compact")).status).toBe(404);
        expect(readFileSync(join(summary.path, "MISSION.md"), "utf8")).toMatch(
            /\n- \d\d:\d\d spinner: compacted backend at \? %\n/,
        );
        await until(() => !daemon.agents.is_busy(summary.dir, "backend"));
        await post("/sessions/s001-alpha/agents/backend/prompt", { text: "steers?" });
        await until(() => echoes(events).some((text) => text.startsWith("echo: steers:")));
        expect(echoes(events).find((text) => text.startsWith("echo: steers:"))).toContain(
            "(compact)",
        );
        expect((await post("/sessions/s001-alpha/agents/backend/abort")).status).toBe(200);
        expect((await post("/sessions/s001-alpha/agents/nobody/abort")).status).toBe(404);
        expect((await post("/sessions/s001-alpha/agents/backend/stop")).status).toBe(200);
        await until(() => events.some((event) => event.type === "agent.exited"));
        const gone = await post("/sessions/s001-alpha/agents/backend/prompt", { text: "x" });
        expect(gone.status).toBe(409);
        const stopped = await post("/sessions/s001-alpha/agents/backend/compact");
        expect(stopped.status).toBe(409);
        expect(await stopped.json()).toMatchObject({ process: "exited" });
        expect(await gone.json()).toMatchObject({ process: "exited" });
        const never = await post("/sessions/s001-alpha/agents/nobody/prompt", { text: "x" });
        expect(never.status).toBe(404);

        const transcript = join(summary.path, "agents", "backend", "pi", "t.jsonl");
        writeFileSync(
            transcript,
            [
                JSON.stringify({ type: "session", version: 3, id: "backend" }),
                JSON.stringify({ type: "message", message: { role: "system", content: "" } }),
                JSON.stringify({
                    type: "message",
                    id: "b",
                    message: { role: "user", content: "hi", timestamp: 1 },
                }),
                "",
            ].join("\n"),
        );
        const history = await fetch(`${base}/sessions/s001/agents/backend/events`);
        expect(((await history.json()) as AgentEventsResponse).events).toEqual([
            { type: "message_end", message: { role: "user", content: "hi", timestamp: 1 } },
        ]);
        const none = await fetch(`${base}/sessions/s001/agents/nobody/events`);
        expect(((await none.json()) as AgentEventsResponse).events).toEqual([]);

        const models = (await (await fetch(`${base}/models`)).json()) as ModelsResponse;
        expect(models.models.map((model) => model.id)).toEqual(["claude-x", "gpt-y"]);
        client.close();
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

    it("sends notify to every client; the banner runs only without a desktop app", async () => {
        const page = await connect("http://localhost:5173");
        const app = await connect("http://localhost", "?client=desktop");
        const to_page = next_event(page);
        const to_app = next_event(app);
        await daemon.notify("Spinner", "s7: merged", "s007-pay");
        const expected = { type: "notify", session: "s007-pay", message: "s7: merged" };
        expect(await to_page).toMatchObject(expected);
        expect(await to_app).toMatchObject(expected);
        // The UI's socket is not a desktop app: with the app connected, no banner ran.
        expect(banners).toEqual([]);

        app.close();
        // The daemon counts the close when its socket sees it; notify until the banner runs.
        await until(() => {
            void daemon.notify("Spinner", "s7: merged", "s007-pay");
            return banners.length > 0;
        });
        expect(banners[0]).toEqual(["Spinner", "s7: merged", "s007-pay"]);
        page.close();
    });

    it("rejects an upgrade on any other path", async () => {
        const client = new WebSocket(`ws://127.0.0.1:${daemon.port}/other`);
        const failure = await new Promise<Error>((resolve) => client.once("error", resolve));
        expect(failure.message).toMatch(/404/);
    });
});

/** The texts of the agents' finished messages, in order: the fake pi's `echo: …` lines. */
function echoes(events: readonly SpinnerEvent[]): string[] {
    const texts: string[] = [];
    for (const event of events) {
        if (event.type !== "agent.event" || event.event.type !== "message_end") {
            continue;
        }
        const content = event.event.message.content;
        const first = Array.isArray(content) ? content[0] : undefined;
        if (first !== undefined && first.type === "text") {
            texts.push(first.text);
        }
    }
    return texts;
}
