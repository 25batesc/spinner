// Goal: a session agent is one `pi --mode rpc` child whatever `session.yaml` said before. A
// daemon restart resumes the agents the previous daemon hosted on the same transcript id,
// rewrites a record that still names the `tty` harness, and leaves an exited agent alone; a
// resume that names no repo runs in the worktree the agent ran in before; and the stack log
// route tails a host service's file. Method: a real daemon on port 0 with the fake rpc pi
// (test/fixtures/fake-pi.ts), a second daemon on the same home, and `fetch`.
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session, SpinnerEvent } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { start_daemon, type Daemon, type DaemonOptions } from "../server.js";
import { create_session, type SessionSummary } from "../store/session-store.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(here, "..", "..", "test", "fixtures", "fake-pi.ts");

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
        extension: null,
        cwd: root,
    };
}

async function restart(): Promise<void> {
    // A daemon stops its agents on close and leaves their records as they were (`stop_all`),
    // so the next one sees a listed agent whose pid is gone, as after a crash.
    await daemon.close();
    daemon = await start_daemon(options());
    events = [];
    daemon.bus.subscribe((event) => events.push(event));
}

beforeEach(async () => {
    chmodSync(FAKE_PI, 0o755);
    root = mkdtempSync(join(tmpdir(), "spinner-lifecycle-"));
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

function call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${daemon.port}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

async function until(check: () => boolean): Promise<void> {
    for (let poll = 0; poll < 500; poll += 1) {
        if (check()) {
            return;
        }
        await new Promise((resolve_) => setTimeout(resolve_, 10));
    }
    throw new Error("condition not met in time");
}

function session_yaml(path: string): Session {
    return parse(readFileSync(join(path, "session.yaml"), "utf8")) as Session;
}

function with_brief(title: string, name: string): SessionSummary {
    const summary = create_session(home, { title });
    mkdirSync(join(summary.path, "agents", name), { recursive: true });
    writeFileSync(join(summary.path, "agents", name, "BRIEF.md"), `# ${name}\n`);
    return summary;
}

describe("a daemon restart", () => {
    it("resumes the rpc agent the previous daemon hosted, on the same transcript", async () => {
        const summary = with_brief("Restart", "ui");
        const args_file = join(root, "args.json");
        process.env["FAKE_PI_ARGS_FILE"] = args_file;
        const added = await call("POST", `/sessions/${summary.dir}/agents`, { name: "ui" });
        expect(added.status).toBe(201);
        const before = session_yaml(summary.path).agents["ui"];
        expect(before).toMatchObject({ harness: "rpc", process: "idle" });
        const old_pid = before?.pid ?? 0;

        await restart();
        await until(() => daemon.agents.running(summary.dir).includes("ui"));
        const after = session_yaml(summary.path).agents["ui"];
        expect(after).toMatchObject({ harness: "rpc", process: "idle" });
        expect(after?.pid).not.toBe(old_pid);
        const spawned = JSON.parse(readFileSync(args_file, "utf8")) as { argv: string[] };
        expect(spawned.argv.slice(0, 2)).toEqual(["--mode", "rpc"]);
        expect(spawned.argv).toContain("--session-id");
        expect(spawned.argv[spawned.argv.indexOf("--session-id") + 1]).toBe("ui");

        // The resumed agent takes a prompt.
        const prompted = await call("POST", `/sessions/${summary.dir}/agents/ui/prompt`, {
            text: "hello",
        });
        expect(prompted.status).toBe(200);
        await until(() => events.some((event) => event.type === "agent.settled"));
    }, 30_000);

    it("moves an agent recorded on the tty harness to rpc and leaves an exited one", async () => {
        const summary = with_brief("Migrate", "lead");
        // What a daemon before this change left: a hosted tty lead and a stopped tty worker.
        const file = join(summary.path, "session.yaml");
        const session = session_yaml(summary.path);
        session.agents = {
            lead: { harness: "tty", model: "default", process: "running", thinking: "high" },
            worker: { harness: "tty", model: "default", process: "exited" },
        };
        writeFileSync(file, stringify(session));

        await restart();
        await until(() => daemon.agents.running(summary.dir).includes("lead"));
        const agents = session_yaml(summary.path).agents;
        // The record names the new harness and the thinking level pi reported at its start.
        expect(agents["lead"]).toMatchObject({ harness: "rpc", process: "idle", thinking: "off" });
        expect(agents["worker"]).toEqual({ harness: "tty", model: "default", process: "exited" });
        expect(daemon.agents.running(summary.dir)).toEqual(["lead"]);
    }, 30_000);
});

describe("a resume", () => {
    it("that names no repo runs in the worktree the agent ran in before", async () => {
        const summary = with_brief("Resume in place", "ui");
        const worktree = join(summary.path, "worktrees", "app");
        mkdirSync(worktree, { recursive: true });
        const yaml = join(summary.path, "session.yaml");
        writeFileSync(
            yaml,
            readFileSync(yaml, "utf8").replace(
                "repos: {}",
                [
                    "repos:",
                    "  app:",
                    "    path: /nowhere",
                    "    worktree: worktrees/app",
                    "    changed: false",
                ].join("\n"),
            ),
        );
        const args_file = join(home.root, "resume-args.json");
        process.env["FAKE_PI_ARGS_FILE"] = args_file;
        const body = { name: "ui", repo: "app" };
        expect((await call("POST", `/sessions/${summary.dir}/agents`, body)).status).toBe(201);
        const stop = await call("POST", `/sessions/${summary.dir}/agents/ui/stop`, {});
        expect(stop.status).toBe(200);
        await until(() => session_yaml(summary.path).agents["ui"]?.process === "exited");
        // The tab's `resume` sends the name only.
        const resumed = await call("POST", `/sessions/${summary.dir}/agents`, { name: "ui" });
        expect(resumed.status).toBe(201);
        const spawned = JSON.parse(readFileSync(args_file, "utf8")) as { cwd: string };
        expect(realpathSync(spawned.cwd)).toBe(realpathSync(worktree));
        expect(session_yaml(summary.path).agents["ui"]?.repo).toBe("app");
    });
});

describe("a failed stack job", () => {
    it("is recorded in session.yaml and told to the session's agent once", async () => {
        const summary = with_brief("Broken stack", "engine");
        const added = await call("POST", `/sessions/${summary.dir}/agents`, { name: "engine" });
        expect(added.status).toBe(201);
        await until(() => events.some((event) => event.type === "agent.settled"));
        events.length = 0;

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

        // The agent hears about it once, as a turn of its own (the fake echoes its prompt).
        const heard = (): number =>
            events.filter(
                (event) =>
                    event.type === "agent.event" &&
                    event.event.type === "message_end" &&
                    JSON.stringify(event.event.message.content).includes(
                        "echo: Spinner: the stack job `up` failed",
                    ),
            ).length;
        await until(() => heard() === 1);
        await new Promise((resolve_) => setTimeout(resolve_, 200));
        expect(heard()).toBe(1);
    }, 30_000);
});

describe("GET /stack/logs/:service", () => {
    it("tails a host service's log file", async () => {
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
});
