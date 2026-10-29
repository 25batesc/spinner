// Goal: the tty harness spawns pi in a pty with the RPC harness's arguments plus
// SPINNER_HARNESS=tty, the pty WebSocket carries bytes both ways and replays the scrollback,
// prompt and steer go through the extension's long-poll and the daemon's fold fires
// agent.settled, the Context tab sees the posted commands, stop ends the attachments with
// an exit frame, and a second daemon on the same home resumes the agent. Method: a real
// daemon on port 0 with a fake interactive pi (test/fixtures/fake-pi-tty.ts) that speaks the
// extension's half of the contract over HTTP, driven with `ws` clients and `fetch`.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session, SpinnerEvent } from "@spinner/protocol";
import { TTY_ATTACHMENTS_MAX, tty_path } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { start_daemon, type Daemon, type DaemonOptions } from "../server.js";
import { create_session } from "../store/session-store.js";
import { ExtensionChannel } from "./extension-channel.js";
import { parse_ack, parse_resize } from "./routes-tty.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(here, "..", "..", "test", "fixtures", "fake-pi-tty.ts");

let root: string;
let home: SpinnerHome;
let daemon: Daemon;
let events: SpinnerEvent[];

function options(): DaemonOptions {
    return {
        home,
        port: 0,
        log: () => undefined,
        poll_seconds: 0,
        notify: async () => undefined,
        ui_dir: null,
        observe_interval_ms: 60_000,
        pi: FAKE_PI,
        cwd: root,
    };
}

beforeEach(async () => {
    chmodSync(FAKE_PI, 0o755);
    root = mkdtempSync(join(tmpdir(), "spinner-tty-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home") });
    mkdirSync(home.root, { recursive: true });
    daemon = await start_daemon(options());
    events = [];
    daemon.bus.subscribe((event) => events.push(event));
});

afterEach(async () => {
    await daemon.close();
    delete process.env["FAKE_PI_ARGS_FILE"];
    rmSync(root, { recursive: true, force: true });
});

function base(): string {
    return `http://127.0.0.1:${daemon.port}`;
}

function call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${base()}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

function until(check: () => boolean, polls_max = 500): Promise<void> {
    return new Promise((resolve_, reject) => {
        let polls = 0;
        const timer = setInterval(() => {
            polls += 1;
            if (check()) {
                clearInterval(timer);
                resolve_();
            } else if (polls > polls_max) {
                clearInterval(timer);
                reject(new Error("condition not met in time"));
            }
        }, 10);
    });
}

/** A client on the pty: collects binary frames as text, text frames as JSON. */
interface Client {
    socket: WebSocket;
    text(): string;
    frames: unknown[];
    closed: Promise<number>;
}

function attach(dir: string, name: string): Promise<Client> {
    const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}${tty_path(dir, name)}`);
    const chunks: Buffer[] = [];
    const frames: unknown[] = [];
    const closed = new Promise<number>((resolve_) => socket.on("close", (code) => resolve_(code)));
    socket.on("message", (data, is_binary) => {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (is_binary) {
            chunks.push(buffer);
        } else {
            frames.push(JSON.parse(buffer.toString("utf8")));
        }
    });
    return new Promise((resolve_, reject) => {
        socket.once("open", () =>
            resolve_({
                socket,
                frames,
                closed,
                text: () => Buffer.concat(chunks).toString("utf8"),
            }),
        );
        socket.once("unexpected-response", (_request, response) => {
            reject(new Error(`upgrade refused: ${response.statusCode}`));
        });
        socket.once("error", reject);
    });
}

function session_yaml(path: string): Session {
    return parse(readFileSync(join(path, "session.yaml"), "utf8")) as Session;
}

describe("the tty harness through the daemon", () => {
    it("spawns pi in a pty, attaches, prompts through the extension, stops, resumes", async () => {
        const summary = create_session(home, { title: "Terminals" });
        mkdirSync(join(summary.path, "agents", "backend"), { recursive: true });
        writeFileSync(join(summary.path, "agents", "backend", "BRIEF.md"), "# backend\n");
        const args_file = join(root, "args.json");
        process.env["FAKE_PI_ARGS_FILE"] = args_file;

        const added = await call("POST", `/sessions/${summary.dir}/agents`, { name: "backend" });
        expect(added.status).toBe(201);
        const spawned = JSON.parse(readFileSync(args_file, "utf8")) as {
            argv: string[];
            env: Record<string, string>;
        };
        expect(spawned.argv.slice(0, 4)).toEqual([
            "--session-dir",
            join(summary.path, "agents", "backend", "pi"),
            "--session-id",
            "backend",
        ]);
        expect(spawned.argv).not.toContain("--mode");
        expect(spawned.argv).toContain("--extension");
        expect(spawned.env).toMatchObject({ SPINNER_HARNESS: "tty", TERM: "xterm-256color" });
        const recorded = session_yaml(summary.path).agents["backend"];
        expect(recorded).toMatchObject({ harness: "tty", process: "idle" });
        expect(recorded?.pid).toBeGreaterThan(0);
        expect(typeof recorded?.started).toBe("string");

        // Attach: the scrollback carries the banner; keystrokes echo; a resize is accepted.
        const first = await attach(summary.dir, "backend");
        await until(() => first.text().includes("fake pi tty ready"));
        first.socket.send(Buffer.from("hi"), { binary: true });
        await until(() => first.text().endsWith("hi"));
        first.socket.send(JSON.stringify({ resize: { cols: 100, rows: 30 } }));
        const agent = daemon.agents.get(summary.dir, "backend");
        expect(agent).not.toBeNull();
        await until(() => {
            const size = daemon.tty.lookup(summary.dir, "backend")?.current_size();
            return size?.cols === 100 && size.rows === 30 && size.from_client;
        });

        // A prompt goes through the long-poll; the fold fires agent.settled; the pty shows it.
        const prompted = await call("POST", `/sessions/${summary.dir}/agents/backend/prompt`, {
            text: "hello",
        });
        expect(prompted.status).toBe(200);
        expect(await prompted.json()).toEqual({ ok: true, disposition: "started" });
        await until(() => events.some((event) => event.type === "agent.settled"));
        const folded = events
            .filter((event) => event.type === "agent.event")
            .map((event) => (event as { event: { type: string } }).event.type);
        expect(folded).toEqual(["agent_start", "turn_end", "agent_end", "agent_settled"]);
        await until(() => first.text().includes("echo: hello"));
        const steered = await call("POST", `/sessions/${summary.dir}/agents/backend/steer`, {
            text: "more",
        });
        expect(await steered.json()).toEqual({ ok: true, disposition: "started" });
        await until(() => first.text().includes("steer: more"));

        // A second client replays the scrollback and sees live output afterwards.
        const second = await attach(summary.dir, "backend");
        await until(() => second.text().includes("echo: hello"));
        expect(second.text()).toContain("fake pi tty ready");
        first.socket.send(Buffer.from("z"), { binary: true });
        await until(() => second.text().endsWith("z"));

        // The Context tab lists the commands the extension posted with hello.
        const context = await call("GET", `/sessions/${summary.dir}/agents/backend/context`);
        const body = (await context.json()) as { commands: Array<{ name: string }> };
        expect(body.commands.map((command) => command.name)).toContain("help");

        // A text frame that is not a resize closes with 1008; the others stay attached.
        const bad = await attach(summary.dir, "backend");
        bad.socket.send("not json");
        expect(await bad.closed).toBe(1008);

        // Stop: every client gets the exit frame and a 1000 close; session.yaml says exited.
        const stopped = await call("POST", `/sessions/${summary.dir}/agents/backend/stop`);
        expect(stopped.status).toBe(200);
        expect(await first.closed).toBe(1000);
        expect(await second.closed).toBe(1000);
        expect(first.frames).toEqual([{ exit: { code: expect.anything() as unknown } }]);
        await until(() => events.some((event) => event.type === "agent.exited"));
        expect(session_yaml(summary.path).agents["backend"]).toEqual({
            harness: "tty",
            model: "default",
            process: "exited",
        });
        const gone = attach(summary.dir, "backend");
        await expect(gone).rejects.toThrow(/upgrade refused: 404/);

        // Resume is `add` again: same session id, a fresh pty.
        const resumed = await call("POST", `/sessions/${summary.dir}/agents`, { name: "backend" });
        expect(resumed.status).toBe(201);
        const again = await attach(summary.dir, "backend");
        await until(() => again.text().includes("fake pi tty ready"));
        again.socket.close();
    }, 30_000);

    it("a daemon restart resumes the tty agent the previous daemon hosted", async () => {
        const summary = create_session(home, { title: "Restart" });
        mkdirSync(join(summary.path, "agents", "ui"), { recursive: true });
        writeFileSync(join(summary.path, "agents", "ui", "BRIEF.md"), "# ui\n");
        const added = await call("POST", `/sessions/${summary.dir}/agents`, { name: "ui" });
        expect(added.status).toBe(201);
        const before = session_yaml(summary.path).agents["ui"];
        expect(before?.process).toBe("idle");
        const old_pid = before?.pid ?? 0;

        // The first daemon stops its agents on close; make the file look like a crash instead,
        // so adopt_all sees a listed agent whose pid is gone.
        await daemon.close();
        writeFileSync(
            join(summary.path, "session.yaml"),
            readFileSync(join(summary.path, "session.yaml"), "utf8").replace(
                "process: exited",
                `process: idle\n    pid: ${old_pid}\n    started: "gone"`,
            ),
        );
        expect(session_yaml(summary.path).agents["ui"]?.process).toBe("idle");

        daemon = await start_daemon(options());
        events = [];
        daemon.bus.subscribe((event) => events.push(event));
        await until(() => daemon.agents.running(summary.dir).includes("ui"));
        const after = session_yaml(summary.path).agents["ui"];
        expect(after?.process).toBe("idle");
        expect(after?.pid).not.toBe(old_pid);
        const client = await attach(summary.dir, "ui");
        await until(() => client.text().includes("fake pi tty ready"));
        client.socket.close();
    }, 30_000);

    it("a failed stack job is recorded in session.yaml and pushed to the tty agent", async () => {
        const summary = create_session(home, { title: "Broken stack" });
        mkdirSync(join(summary.path, "agents", "engine"), { recursive: true });
        writeFileSync(join(summary.path, "agents", "engine", "BRIEF.md"), "# engine\n");
        const added = await call("POST", `/sessions/${summary.dir}/agents`, { name: "engine" });
        expect(added.status).toBe(201);
        const term = await attach(summary.dir, "engine");
        await until(() => term.text().includes("fake pi tty ready"));

        // `up` on a session without a spec copy fails before docker is touched.
        const up = await call("POST", `/sessions/${summary.dir}/up`, {});
        expect(up.status).toBe(202);
        await until(() => events.some((event) => event.type === "job.finished"));
        await until(() => session_yaml(summary.path).stack.last_job !== undefined);
        const last_job = session_yaml(summary.path).stack.last_job;
        expect(last_job).toMatchObject({ action: "up", state: "failed" });
        expect(last_job?.error).toMatch(/has no stack/);
        expect(typeof last_job?.finished).toBe("string");
        expect(Array.isArray(last_job?.tail)).toBe(true);
        const view = await call("GET", `/sessions/${summary.dir}`);
        const body = (await view.json()) as { session: { stack: { last_job: unknown } } };
        expect(body.session.stack.last_job).toEqual(last_job);

        // The agent hears about it once, through the extension channel.
        await until(() => term.text().includes("notice: Spinner: the stack job `up` failed"));
        await new Promise((resolve_) => setTimeout(resolve_, 200));
        expect(term.text().split("notice: Spinner").length - 1).toBe(1);
        term.socket.close();
    }, 30_000);

    it("GET /stack/logs/:service tails a host service's log file", async () => {
        const summary = create_session(home, { title: "Logs" });
        mkdirSync(join(summary.path, "log"), { recursive: true });
        writeFileSync(join(summary.path, "log", "web.log"), "one\ntwo\nthree\n");
        const two = await call("GET", `/sessions/${summary.dir}/stack/logs/web?lines=2`);
        expect(two.status).toBe(200);
        expect(await two.json()).toEqual({
            service: "web",
            where: "host",
            lines: ["two", "three"],
        });
        const all = await call("GET", `/sessions/${summary.dir}/stack/logs/web`);
        expect(((await all.json()) as { lines: string[] }).lines).toEqual(["one", "two", "three"]);
        const many = await call("GET", `/sessions/${summary.dir}/stack/logs/web?lines=3000`);
        expect(many.status).toBe(400);
        const none = await call("GET", `/sessions/${summary.dir}/stack/logs/api`);
        expect(none.status).toBe(404);
        const bad = await call("GET", `/sessions/${summary.dir}/stack/logs/..%2Fsession`);
        expect(bad.status).toBe(400);
    });

    it("refuses the ninth attachment with 409 before the upgrade", async () => {
        const summary = create_session(home, { title: "Many" });
        mkdirSync(join(summary.path, "agents", "a"), { recursive: true });
        writeFileSync(join(summary.path, "agents", "a", "BRIEF.md"), "# a\n");
        const added = await call("POST", `/sessions/${summary.dir}/agents`, { name: "a" });
        expect(added.status).toBe(201);
        const clients: Client[] = [];
        for (let i = 0; i < TTY_ATTACHMENTS_MAX; i += 1) {
            clients.push(await attach(summary.dir, "a"));
        }
        await expect(attach(summary.dir, "a")).rejects.toThrow(/upgrade refused: 409/);
        for (const client of clients) {
            client.socket.close();
        }
    }, 30_000);
});

describe("ExtensionChannel", () => {
    it("hands a command to the next poll, resolves on ack, times out without one", async () => {
        const channel = new ExtensionChannel(50);
        const prompt = channel.enqueue("prompt", "hi");
        const polled = await channel.poll(null, 1_000);
        expect(polled).toEqual({ id: "c-1", type: "prompt", text: "hi" });
        const idle = channel.poll({ id: "c-1", disposition: "started" }, 20);
        expect(await prompt).toBe("started");
        expect(await idle).toBeNull();
        await expect(channel.enqueue("steer", "x")).rejects.toThrow(/did not acknowledge/);
        channel.close("gone");
        await expect(channel.enqueue("prompt", "y")).rejects.toThrow(/gone/);
    });

    it("a waiting poll gets a command at once; a newer poll replaces an older one", async () => {
        const channel = new ExtensionChannel(1_000);
        const first = channel.poll(null, 1_000);
        const second = channel.poll(null, 1_000);
        expect(await first).toBeNull();
        const abort = channel.enqueue("abort");
        expect(await second).toEqual({ id: "c-1", type: "abort" });
        await channel.poll({ id: "c-1", disposition: "aborted" }, 1);
        expect(await abort).toBe("aborted");
    });
});

describe("tty route parsers", () => {
    it("parse_resize accepts 1..1000 and nothing else", () => {
        expect(parse_resize('{"resize":{"cols":80,"rows":24}}')).toEqual({ cols: 80, rows: 24 });
        expect(parse_resize('{"resize":{"cols":0,"rows":24}}')).toBeNull();
        expect(parse_resize('{"resize":{"cols":1001,"rows":24}}')).toBeNull();
        expect(parse_resize('{"resize":{"cols":"80","rows":24}}')).toBeNull();
        expect(parse_resize('{"other":1}')).toBeNull();
        expect(parse_resize("nope")).toBeNull();
    });

    it("parse_ack needs both halves or neither", () => {
        expect(parse_ack(undefined, undefined)).toBeNull();
        expect(parse_ack("c-1", "started")).toEqual({ id: "c-1", disposition: "started" });
        expect(typeof parse_ack("c-1", undefined)).toBe("string");
        expect(typeof parse_ack(undefined, "started")).toBe("string");
    });
});
