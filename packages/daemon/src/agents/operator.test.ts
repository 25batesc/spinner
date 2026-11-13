// Goal: the daemon hosts one operator agent per home (MISSION.md s013): it starts with the
// daemon in `<home>` with `--session-dir <home>/operator/pi --session-id operator` and the
// extension in role `operator`, writes `operator/BRIEF.md` once, answers `GET /operator`,
// takes a prompt through `/operator/prompt`, publishes `operator.updated` as its turn runs,
// serves its pty at `/operator/tty`, stops and resumes through the routes, resumes after a
// daemon restart, and hears about `needs_human`, `agent.settled`, `agent.exited`, a failed
// job and an inbox message as one batched notice per second. `PUT .../agents/:name/brief`
// writes the file the operator's `brief_write` tool sends. Method: a daemon on port 0 over a
// scratch home with the fake interactive pi (test/fixtures/fake-pi-tty.ts) as both the
// operator and a session agent, driven with `fetch` and `ws`.
import {
    chmodSync,
    existsSync,
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
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OperatorResponse, OperatorView, SpinnerEvent } from "@spinner/protocol";
import { OPERATOR_TTY_PATH } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { start_daemon, type Daemon, type DaemonOptions } from "../server.js";
import { create_session, read_session, write_session } from "../store/session-store.js";
import { notice_line, render_notice, NOTICES_MAX } from "./operator.js";

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
        usage_interval_ms: 60_000,
        pi: FAKE_PI,
        cwd: root,
        operator_batch_ms: 200,
    };
}

beforeEach(async () => {
    chmodSync(FAKE_PI, 0o755);
    root = mkdtempSync(join(tmpdir(), "spinner-operator-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home") });
    mkdirSync(home.root, { recursive: true });
    // Off by default since s014; these tests are about the agent, so they switch it on.
    writeFileSync(join(home.root, "settings.yaml"), "theme: system\noperator:\n  enabled: true\n");
    process.env["FAKE_PI_ARGS_FILE"] = join(root, "args.json");
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

async function operator_view(): Promise<OperatorView> {
    const response = await call("GET", "/operator");
    expect(response.status).toBe(200);
    return ((await response.json()) as OperatorResponse).operator;
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

interface Client {
    socket: WebSocket;
    text(): string;
    closed: Promise<number>;
}

function attach(): Promise<Client> {
    const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}${OPERATOR_TTY_PATH}`);
    const chunks: Buffer[] = [];
    const closed = new Promise<number>((resolve_) => socket.on("close", (code) => resolve_(code)));
    socket.on("message", (data, is_binary) => {
        if (is_binary) {
            chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        }
    });
    return new Promise((resolve_, reject) => {
        socket.once("open", () =>
            resolve_({ socket, closed, text: () => Buffer.concat(chunks).toString("utf8") }),
        );
        socket.once("unexpected-response", (_request, response) => {
            reject(new Error(`upgrade refused: ${response.statusCode}`));
        });
        socket.once("error", reject);
    });
}

function last_text(): string {
    return daemon.operator.view().last_notice?.text ?? "";
}

function operator_events(): OperatorView[] {
    return events
        .filter((event) => event.type === "operator.updated")
        .map((event) => (event as { data: OperatorView }).data);
}

describe("the operator agent through the daemon", () => {
    it("starts with the daemon in the home, in role operator, with its brief written", async () => {
        const view = await operator_view();
        expect(view).toMatchObject({
            enabled: true,
            process: "idle",
            waiting_on: "operator",
            dir: join(home.root, "operator"),
            notices_pending: 0,
            last_notice: null,
        });
        expect(view.pid).toBeGreaterThan(0);
        const brief = join(home.root, "operator", "BRIEF.md");
        expect(existsSync(brief)).toBe(true);
        expect(readFileSync(brief, "utf8")).toContain("never push, post, approve, land");
        expect(readFileSync(brief, "utf8").split("\n").length).toBeLessThan(120);
        const spawned = JSON.parse(readFileSync(join(root, "args.json"), "utf8")) as {
            argv: string[];
            cwd: string;
            env: Record<string, string>;
        };
        expect(realpathSync(spawned.cwd)).toBe(realpathSync(home.root));
        expect(spawned.argv.slice(0, 5)).toEqual([
            "--approve",
            "--session-dir",
            join(home.root, "operator", "pi"),
            "--session-id",
            "operator",
        ]);
        expect(spawned.env).toMatchObject({
            SPINNER_ROLE: "operator",
            SPINNER_AGENT: "operator",
            SPINNER_SESSION_DIR: join(home.root, "operator"),
            SPINNER_HARNESS: "tty",
        });
    });

    it("prompts, shows the pty, stops and resumes, restarts with the daemon", async () => {
        const term = await attach();
        await until(() => term.text().includes("fake pi tty ready"));

        const prompted = await call("POST", "/operator/prompt", { text: "hello" });
        expect(prompted.status).toBe(200);
        expect(await prompted.json()).toEqual({ ok: true, disposition: "started" });
        await until(() => term.text().includes("echo: hello"));
        await until(() => operator_events().some((view) => view.process === "running"));
        await until(() => {
            const last = operator_events().at(-1);
            return last !== undefined && last.process === "idle";
        });
        const running = operator_events().find((view) => view.process === "running");
        expect(running?.waiting_on).toBe("model");

        const stopped = await call("POST", "/operator/stop");
        expect(stopped.status).toBe(200);
        expect(((await stopped.json()) as OperatorResponse).operator).toMatchObject({
            process: "exited",
            pid: null,
            waiting_on: "start",
        });
        expect(await term.closed).toBe(1000);
        await expect(attach()).rejects.toThrow(/upgrade refused: 404/);
        const again = await call("POST", "/operator/stop");
        expect(again.status).toBe(409);
        const refused = await call("POST", "/operator/prompt", { text: "x" });
        expect(refused.status).toBe(409);

        const started = await call("POST", "/operator/start");
        expect(started.status).toBe(200);
        expect(((await started.json()) as OperatorResponse).operator.process).toBe("idle");
        const twice = await call("POST", "/operator/start");
        expect(twice.status).toBe(409);
        const resumed = await attach();
        await until(() => resumed.text().includes("fake pi tty ready"));
        resumed.socket.close();

        // A new daemon on the same home resumes the operator agent on its transcript.
        const old_pid = (await operator_view()).pid;
        await daemon.close();
        daemon = await start_daemon(options());
        events = [];
        daemon.bus.subscribe((event) => events.push(event));
        const after = await operator_view();
        expect(after.process).toBe("idle");
        expect(after.pid).not.toBe(old_pid);
        const spawned = JSON.parse(readFileSync(join(root, "args.json"), "utf8")) as {
            argv: string[];
        };
        expect(spawned.argv.slice(3, 5)).toEqual(["--session-id", "operator"]);
    }, 30_000);

    it("hears needs_human, settled, exited, a failed job and a message as notices", async () => {
        const term = await attach();
        await until(() => term.text().includes("fake pi tty ready"));
        const summary = create_session(home, { title: "Refund flow" });
        const brief = await call("PUT", `/sessions/${summary.dir}/agents/backend/brief`, {
            brief: "# backend\n\nAdd a health endpoint.",
        });
        expect(brief.status).toBe(200);
        expect(readFileSync(join(summary.path, "agents", "backend", "BRIEF.md"), "utf8")).toBe(
            "# backend\n\nAdd a health endpoint.\n",
        );
        const bad = await call("PUT", `/sessions/${summary.dir}/agents/Backend/brief`, {
            brief: "x",
        });
        expect(bad.status).toBe(400);

        // The session starts with needs_human set; that first sight is a baseline. Clear it,
        // then set it again: the change is the notice.
        await until(() =>
            events.some(
                (e) =>
                    (e.type === "session.created" || e.type === "session.updated") &&
                    e.session === summary.dir,
            ),
        );
        const clear = read_session(home, summary.dir);
        expect(clear.ok).toBe(true);
        if (clear.ok) {
            clear.summary.session.needs_human = null;
            write_session(clear.summary);
        }
        await until(() =>
            events.some(
                (e) =>
                    e.type === "session.updated" &&
                    e.session === summary.dir &&
                    e.data.summary.session.needs_human === null,
            ),
        );
        const set = read_session(home, summary.dir);
        if (set.ok) {
            set.summary.session.needs_human = "approve the PR";
            write_session(set.summary);
        }
        const needs = `notice: ${summary.dir}: needs a human: approve the PR`;
        await until(() => term.text().includes(needs));

        // A session agent that settles and exits, and a message to the operator, in one
        // batch when they fall in the same window.
        const added = await call("POST", `/sessions/${summary.dir}/agents`, { name: "backend" });
        expect(added.status).toBe(201);
        const prompted = await call("POST", `/sessions/${summary.dir}/agents/backend/prompt`, {
            text: "go",
        });
        expect(prompted.status).toBe(200);
        await until(() => events.some((e) => e.type === "agent.settled" && e.agent === "backend"));
        const sent = await call("POST", `/sessions/${summary.dir}/inbox`, {
            from: "backend",
            to: "operator",
            subject: "health endpoint is up",
            text: "GET /health answers 200.",
        });
        expect(sent.status).toBe(201);
        await until(() => last_text().includes("settled"));
        await until(() => last_text().includes("health endpoint is up"));
        const text = term.text();
        expect(text).toContain(`notice: ${summary.dir}: agent backend settled`);
        const last = daemon.operator.view().last_notice;
        const lines = last?.text.split("\n") ?? [];
        expect(lines.every((line) => line.startsWith(`${summary.dir}: `))).toBe(true);
        expect(last?.text).toContain("message from backend");

        const stopped = await call("POST", `/sessions/${summary.dir}/agents/backend/stop`);
        expect(stopped.status).toBe(200);
        await until(() => last_text().includes("exited"));
        expect(last_text()).toContain(`${summary.dir}: agent backend exited`);

        // `up` on a session without a stack fails: the job failure is a notice too.
        const up = await call("POST", `/sessions/${summary.dir}/up`, {});
        expect(up.status).toBe(202);
        await until(() => last_text().includes("job up failed"));
        expect(operator_events().at(-1)?.last_notice?.text).toContain("job up failed");
        term.socket.close();
    }, 30_000);

    it("holds notices while stopped and delivers them on start", async () => {
        const stopped = await call("POST", "/operator/stop");
        expect(stopped.status).toBe(200);
        for (let i = 0; i < NOTICES_MAX + 5; i += 1) {
            daemon.operator.notice(`s1-x: line ${i}`);
        }
        expect((await operator_view()).notices_pending).toBe(NOTICES_MAX);
        const started = await call("POST", "/operator/start");
        expect(started.status).toBe(200);
        const term = await attach();
        await until(() => daemon.operator.view().notices_pending === 0 && last_text().length > 0);
        const last = daemon.operator.view().last_notice;
        expect(last?.text.startsWith("s1-x: line 5\n")).toBe(true);
        expect(last?.text.endsWith("(5 older notices dropped)")).toBe(true);
        await until(() => term.text().includes("notice: s1-x: line 5"));
        term.socket.close();
    }, 20_000);

    it("the agent is off at boot unless settings.operator.enabled is true", async () => {
        await daemon.close();
        rmSync(join(home.root, "settings.yaml"));
        daemon = await start_daemon(options());
        events = [];
        const view = await operator_view();
        expect(view).toMatchObject({ enabled: false, process: "exited", waiting_on: "start" });
        const started = await call("POST", "/operator/start");
        expect(started.status).toBe(200);
        expect((await operator_view()).process).toBe("idle");
        const bad = await call("PUT", "/settings", {
            theme: "system",
            operator: { enabled: "no" },
        });
        expect(bad.status).toBe(400);
        const ok = await call("PUT", "/settings", {
            theme: "system",
            operator: { enabled: true, model: "anthropic/claude-x" },
        });
        expect(ok.status).toBe(200);
    });
});

describe("notice_line", () => {
    it("names the session first and reports only the events the operator must hear", () => {
        const seen = new Map<string, string | null>();
        const ts = "2026-10-30T22:00:00.000Z";
        const message = { file: "f.md", from: "ui", subject: "x" };
        expect(
            notice_line({ type: "agent.settled", ts, session: "s2-a", agent: "ui" }, seen),
        ).toBe("s2-a: agent ui settled");
        // A failed job's error with several lines (git's) is one notice line: its first.
        const failed = {
            type: "job.finished", ts, session: "s2-a", job: "j-1", ok: false,
            error: "git worktree add failed (128): Preparing worktree\nfatal: already used",
            data: { action: "plan" },
        } as unknown as Parameters<typeof notice_line>[0];
        expect(notice_line(failed, seen)).toBe(
            "s2-a: job plan failed: git worktree add failed (128): Preparing worktree",
        );
        expect(
            notice_line(
                {
                    type: "agent.exited",
                    ts,
                    session: "s2-a",
                    agent: "ui",
                    process: "exited",
                    code: 1,
                },
                seen,
            ),
        ).toBe("s2-a: agent ui exited (code 1)");
        expect(
            notice_line(
                { type: "inbox.message", ts, session: "s2-a", ...message, to: "engine" },
                seen,
            ),
        ).toBeNull();
        expect(
            notice_line(
                { type: "inbox.message", ts, session: "s2-a", ...message, to: "operator" },
                seen,
            ),
        ).toBe("s2-a: message from ui (inbox/f.md): x");
        expect(
            notice_line({ type: "agent.spawned", ts, session: "s2-a", agent: "ui", pid: 1 }, seen),
        ).toBeNull();
    });

    it("render_notice says how many older lines were dropped", () => {
        expect(render_notice(["a", "b"], 0)).toBe("a\nb");
        expect(render_notice(["a"], 1)).toBe("a\n(1 older notice dropped)");
        expect(render_notice(["a"], 3)).toBe("a\n(3 older notices dropped)");
    });
});
