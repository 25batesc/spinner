#!/usr/bin/env node
// E2e for the operator agent against the real pi (MISSION.md s013, "Done when", the e2e
// line): a scratch daemon on a scratch SPINNER_HOME and a free port starts the operator agent
// in the home; the script attaches to its pty, sends the request "start a session for the
// sample stack named Refund flow with one agent `backend` that adds a health endpoint"
// through `POST /operator/prompt`, and waits on artifacts: the session directory, the
// project attached (a worktree), a MISSION.md with a Goal and three Plan items, the brief
// `agents/backend/BRIEF.md`, the agent `backend` running. Then it prompts `backend` once
// through the route and waits for its `agent.settled` to reach the operator agent as a
// notice (`GET /operator` `last_notice`, and the text in the operator's terminal). The
// sample stack is a copy of `examples/sample-stack` over a scratch git repo under the scratch
// home's `projects/`, so nothing touches this checkout's worktrees. Never touches the
// operator's daemon on :7777 or ~/.spinner. Needs a built daemon (`pnpm -r build`) and a `pi`
// with a working model (SPINNER_PI or PATH).
//
//     node packages/daemon/e2e/operator.ts
//
// The scratch home is printed and kept, as the session protocol asks.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const checkout = resolve(here, "..", "..", "..");
const daemon_main = resolve(here, "..", "dist", "main.js");

const REQUEST =
    "start a session for the sample stack named Refund flow with one agent `backend` that " +
    "adds a health endpoint";
const BACKEND_PROMPT = "Reply with exactly the word pong and nothing else. Do not edit files.";

/** The last attached terminal, so a failure can dump what pi drew. */
let last_term: Term | null = null;

const scratch = mkdtempSync(join(tmpdir(), "spinner-e2e-operator-"));
const home_root = join(scratch, "home");
mkdirSync(home_root, { recursive: true });
const port = await free_port();
const base = `http://127.0.0.1:${port}`;
console.log(`scratch home: ${home_root}`);
console.log(`scratch daemon: ${base}`);

step("a sample project over a scratch git repo");
const project_dir = join(home_root, "projects", "sample");
const repo_dir = join(scratch, "repo");
make_sample_project(project_dir, repo_dir);
console.log(`  project ${join(project_dir, "spinner.yaml")}, repo ${repo_dir}`);

let daemon: ChildProcess | null = null;
const spinnerd = start_daemon();
daemon = spinnerd;
await wait_for(() => health(), "the daemon's /health", 15_000);

const events: Array<{ type: string; session?: string | null; agent?: string }> = [];
const bus = new WebSocket(`ws://127.0.0.1:${port}/events`);
bus.on("message", (data) => events.push(JSON.parse(String(data)) as { type: string }));
await new Promise<void>((resolve_) => bus.once("open", () => resolve_()));

step("the operator agent is up in the home");
// `/health` answers before the operator agent's start settles; wait on the view.
await wait_for(async () => (await operator_view()).process !== "exited", "GET /operator", 30_000);
console.log(`  ok: GET /operator process ${(await operator_view()).process}`);
check(existsSync(join(home_root, "operator", "BRIEF.md")), "operator/BRIEF.md written");
const projects = (await (await fetch(`${base}/projects`)).json()) as {
    projects: Array<{ name: string }>;
};
check(
    projects.projects.some((project) => project.name === "sample"),
    "GET /projects lists the sample project",
);
const term = await attach("/operator/tty");
await wait_for(() => term.text().length > 0, "the first pty bytes", 20_000);
term.socket.send(JSON.stringify({ resize: { cols: 140, rows: 45 } }));
await dismiss_notices(term);
await wait_for(
    async () => (await operator_view()).ready,
    "the operator extension's hello",
    30_000,
);

step("the request goes in through POST /operator/prompt");
const prompted = await fetch(`${base}/operator/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: REQUEST }),
});
check(prompted.status === 200, `POST /operator/prompt → ${prompted.status}`);
console.log(`  disposition: ${((await prompted.json()) as { disposition?: string }).disposition}`);

step("the operator agent creates the session and attaches the project");
let session_dir = "";
await wait_for(
    async () => {
        const dirs = await session_dirs();
        const found = dirs.find((dir) => /refund/i.test(dir)) ?? dirs[0];
        if (found === undefined) {
            return false;
        }
        session_dir = found;
        return true;
    },
    "a session directory",
    300_000,
);
console.log(`  session: ${session_dir}`);
const session_path = join(home_root, "sessions", session_dir);
await wait_for(
    () => {
        const yaml = session_yaml();
        const app = yaml.repos?.["app"];
        return app?.worktree !== undefined && existsSync(join(session_path, app.worktree));
    },
    "the app worktree from the sample project",
    300_000,
);
console.log("  the project is attached: a worktree of the scratch repo exists");

step("the mission has a Goal and three Plan items; backend has a brief and runs");
await wait_for(
    () => plan_items(mission()).length >= 3 && goal(mission()).length > 0,
    "Goal and 3 Plan items",
    600_000,
);
console.log(`  Goal: ${goal(mission()).split("\n")[0]}`);
for (const item of plan_items(mission()).slice(0, 3)) {
    console.log(`  Plan: ${item}`);
}
const brief_path = join(session_path, "agents", "backend", "BRIEF.md");
await wait_for(() => existsSync(brief_path), "agents/backend/BRIEF.md", 600_000);
console.log(`  brief: ${readFileSync(brief_path, "utf8").split("\n")[0]}`);
await wait_for(
    async () => {
        const response = await fetch(`${base}/sessions/${session_dir}`);
        const body = (await response.json()) as { session: { agents_running: string[] } };
        return body.session.agents_running.includes("backend");
    },
    "agent backend running",
    600_000,
);
console.log("  backend runs");
// The backend's pi may sit on the same startup notice; the operator would press a key.
const backend_term = await attach(`/sessions/${session_dir}/agents/backend/tty`);
await wait_for(() => backend_term.text().length > 0, "backend's first pty bytes", 20_000);
await dismiss_notices(backend_term);
const backend_prefix = `/sessions/${session_dir}/agents/backend`;
await wait_for(() => hello_seen(backend_prefix), "backend's hello", 60_000);

step("backend settles; the operator agent hears it as a notice");
const notices_before = (await operator_view()).last_notice?.ts ?? "";
const backend_prompt = await fetch(`${base}/sessions/${session_dir}/agents/backend/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: BACKEND_PROMPT }),
});
check(backend_prompt.status === 200, `POST backend/prompt → ${backend_prompt.status}`);
// The operator agent steered backend with its first task; the prompt above queues after
// it, so the settle comes once the real turn ends. A model run takes minutes.
await wait_for(
    () => events.some((event) => event.type === "agent.settled" && event.agent === "backend"),
    "backend's agent.settled on the bus",
    900_000,
);
await wait_for(
    async () => {
        const view = await operator_view();
        const notice = view.last_notice;
        return (
            notice !== null &&
            notice.ts !== notices_before &&
            notice.text.includes(`${session_dir}: agent backend settled`)
        );
    },
    "the notice in GET /operator last_notice",
    30_000,
);
const notice = (await operator_view()).last_notice?.text ?? "";
const first_line = notice.split("\n")[0] ?? "";
check(notice.startsWith(`${session_dir}: `), `notice starts with the session dir: ${first_line}`);
await wait_for(
    () => term.text().includes("backend settled"),
    "the notice in the operator's terminal",
    30_000,
);
console.log("  the operator agent's terminal shows the notice");
const operator_events = events.filter((event) => event.type === "operator.updated").length;
check(operator_events > 0, `${operator_events} operator.updated events on the bus`);

step("stop");
bus.close();
backend_term.socket.close();
term.socket.close();
spinnerd.kill("SIGTERM");
await new Promise<void>((resolve_) => spinnerd.once("exit", () => resolve_()));
console.log(`\nPASS. scratch home kept at ${home_root}`);

// ---------------------------------------------------------------------------------------

/**
 * `examples/sample-stack` copied under `<home>/projects/sample`, with its repo a scratch git
 * repo (one commit on `main`) instead of this checkout, so the worktree the session makes
 * lives in the scratch and never registers in this repository.
 */
function make_sample_project(project: string, repo: string): void {
    mkdirSync(repo, { recursive: true });
    cpSync(join(checkout, "examples", "sample-stack"), join(repo, "examples", "sample-stack"), {
        recursive: true,
    });
    const git = (...args: string[]): void => {
        execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    };
    git("init", "--quiet", "--initial-branch=main");
    git("-c", "user.name=spinner-e2e", "-c", "user.email=e2e@example.invalid", "add", "-A");
    git(
        "-c",
        "user.name=spinner-e2e",
        "-c",
        "user.email=e2e@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "sample stack",
    );
    mkdirSync(project, { recursive: true });
    const spec = readFileSync(join(checkout, "examples", "sample-stack", "spinner.yaml"), "utf8");
    writeFileSync(join(project, "spinner.yaml"), spec.replace("path: ../..", `path: ${repo}`));
    cpSync(join(checkout, "examples", "sample-stack", "seed.sql"), join(project, "seed.sql"));
}

function start_daemon(): ChildProcess {
    return spawn(process.execPath, [daemon_main], {
        env: {
            ...process.env,
            SPINNER_HOME: home_root,
            SPINNER_PORT: String(port),
            SPINNER_NOTIFY: "off",
            SPINNER_POLL_SECONDS: "0",
            SPINNER_SESSION_IDS: "home",
        },
        stdio: ["ignore", "inherit", "inherit"],
    });
}

async function health(): Promise<boolean> {
    try {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) });
        return response.ok;
    } catch {
        return false;
    }
}

interface OperatorView {
    process: string;
    ready: boolean;
    last_notice: { ts: string; text: string } | null;
}

async function operator_view(): Promise<OperatorView> {
    const response = await fetch(`${base}/operator`);
    return ((await response.json()) as { operator: OperatorView }).operator;
}

async function session_dirs(): Promise<string[]> {
    const response = await fetch(`${base}/sessions`);
    const body = (await response.json()) as { sessions: Array<{ summary: { dir: string } }> };
    return body.sessions.map((view) => view.summary.dir);
}

interface Term {
    socket: WebSocket;
    text(): string;
}

function attach(path: string): Promise<Term> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const chunks: Buffer[] = [];
    socket.on("message", (data, is_binary) => {
        if (is_binary) {
            chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        }
    });
    return new Promise((resolve_, reject) => {
        socket.once("open", () => {
            const term: Term = { socket, text: () => Buffer.concat(chunks).toString("utf8") };
            last_term = term;
            resolve_(term);
        });
        socket.once("unexpected-response", (_request, response) =>
            reject(new Error(`attach ${path} refused: ${response.statusCode}`)),
        );
        socket.once("error", reject);
    });
}

/**
 * pi's startup notices ("Press any key to continue...") wait for a person in the tab; the
 * e2e presses Enter for them, as the operator would. Up to 3 notices.
 */
async function dismiss_notices(term_: Term): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
        await sleep(1_500);
        const notices = term_.text().split("Press any key to continue").length - 1;
        if (notices <= i) {
            return;
        }
        console.log("  pi shows a startup notice; pressing Enter as the operator would");
        term_.socket.send(Buffer.from("\r"), { binary: true });
    }
}

/** True once the agent's extension posted `hello`: the commands list is not empty. */
async function hello_seen(prefix: string): Promise<boolean> {
    const response = await fetch(`${base}${prefix}/context`);
    const body = (await response.json()) as { commands: unknown[] };
    return body.commands.length > 0;
}

function session_yaml(): { repos?: Record<string, { worktree?: string }> } {
    const file = join(session_path, "session.yaml");
    if (!existsSync(file)) {
        return {};
    }
    return parse(readFileSync(file, "utf8")) as { repos?: Record<string, { worktree?: string }> };
}

function mission(): string {
    const file = join(session_path, "MISSION.md");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function section(text: string, heading: string): string[] {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
    if (start === -1) {
        return [];
    }
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (line.startsWith("## ")) {
            break;
        }
        body.push(line);
    }
    return body;
}

function goal(text: string): string {
    return section(text, "Goal")
        .filter((line) => line.trim().length > 0 && !line.includes("Operator-owned"))
        .join("\n");
}

function plan_items(text: string): string[] {
    return section(text, "Plan").filter((line) => /^- \[[ x]\] \d+\. \S/.test(line));
}

function free_port(): Promise<number> {
    return new Promise((resolve_, reject) => {
        const server = createServer();
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") {
                reject(new Error("no port"));
                return;
            }
            server.close(() => resolve_(address.port));
        });
    });
}

async function wait_for(
    check_: () => boolean | Promise<boolean>,
    what: string,
    timeout_ms: number,
): Promise<void> {
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline) {
        if (await check_()) {
            return;
        }
        await sleep(500);
    }
    fail(`timed out after ${timeout_ms} ms waiting for ${what}`);
}

function step(name: string): void {
    console.log(`\n== ${name}`);
}

function check(ok: boolean, what: string): void {
    if (!ok) {
        fail(what);
    }
    console.log(`  ok: ${what}`);
}

function fail(what: string): never {
    console.error(`FAIL: ${what}`);
    if (last_term !== null) {
        writeFileSync(join(scratch, "terminal.txt"), last_term.text());
        console.error(`terminal bytes kept at ${join(scratch, "terminal.txt")}`);
    }
    console.error(`scratch home kept at ${home_root}`);
    daemon?.kill("SIGTERM");
    process.exit(1);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve_) => setTimeout(resolve_, ms));
}
