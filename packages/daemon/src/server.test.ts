// Goal: the daemon serves GET /sessions from disk and emits session.created on the WebSocket
// when a session directory appears, without any state of its own. Method: start a daemon on
// an ephemeral port against a temporary SPINNER_HOME, call it with fetch and a ws client, and
// create a session on disk the way the CLI does.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionResponse, SessionsResponse, SpinnerEvent } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "./home.js";
import { start_daemon, type Daemon } from "./server.js";
import { create_session } from "./store/session-store.js";

let home: SpinnerHome;
let daemon: Daemon;
let base: string;

beforeEach(async () => {
    home = resolve_home({ SPINNER_HOME: mkdtempSync(join(tmpdir(), "spinner-daemon-")) });
    daemon = await start_daemon({ home, port: 0, log: () => undefined });
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
        expect(one.sessions.map((entry) => entry.dir)).toEqual(["s001-alpha"]);
        expect(one.sessions[0]?.session.title).toBe("Alpha");
    });

    it("GET /sessions/:dir and /mission return one session, 404 otherwise", async () => {
        create_session(home, { title: "Alpha" });
        const found = await fetch(`${base}/sessions/s001-alpha`);
        expect(found.status).toBe(200);
        expect(((await found.json()) as SessionResponse).session.session.id).toBe("s001");

        const mission = await fetch(`${base}/sessions/s001-alpha/mission`);
        expect(mission.status).toBe(200);
        expect(mission.headers.get("content-type")).toMatch(/text\/markdown/);
        expect(await mission.text()).toMatch(/^# s001 · Alpha\n/);

        expect((await fetch(`${base}/sessions/nope`)).status).toBe(404);
        expect((await fetch(`${base}/sessions/nope/mission`)).status).toBe(404);
    });

    it("POST /sessions creates a session and rejects a bad body", async () => {
        const created = await fetch(`${base}/sessions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "From the UI" }),
        });
        expect(created.status).toBe(201);
        expect(((await created.json()) as SessionResponse).session.dir).toBe("s001-from-the-ui");

        const bad = await fetch(`${base}/sessions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "" }),
        });
        expect(bad.status).toBe(400);
        const not_json = await fetch(`${base}/sessions`, { method: "POST", body: "nope" });
        expect(not_json.status).toBe(400);
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
            expect(event.data.title).toBe("Watched");
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
