#!/usr/bin/env node
// E2e for the tty harness against the real pi (MISSION.md s009, "Done when", the e2e line):
// a scratch daemon on a scratch SPINNER_HOME and a free port, one tty agent, a WebSocket
// attach, `/help` typed into pi, a `prompt` through the route with `agent.settled` on the
// bus and the answer in the terminal, a daemon kill and restart, a second attach that shows
// the transcript again. Never touches the operator's daemon on :7777 or ~/.spinner. Needs a
// built daemon (`pnpm -r build`) and a `pi` with a working model (SPINNER_PI or PATH).
//
//     node packages/daemon/e2e/tty.ts
//
// The scratch home is printed and kept, as the session protocol asks.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const daemon_main = resolve(here, "..", "dist", "main.js");
const store = await import(resolve(here, "..", "dist", "store", "session-store.js"));
const home_module = await import(resolve(here, "..", "dist", "home.js"));

const PROMPT = "Reply with exactly the word pong and nothing else.";

/** The last attached terminal, so a failure can dump what pi drew. */
let last_term: Term | null = null;

const scratch = mkdtempSync(join(tmpdir(), "spinner-e2e-tty-"));
const home_root = join(scratch, "home");
mkdirSync(home_root, { recursive: true });
const port = await free_port();
const base = `http://127.0.0.1:${port}`;
console.log(`scratch home: ${home_root}`);
console.log(`scratch daemon: ${base}`);

let daemon = start_daemon();
await wait_for(() => health(), "the daemon's /health", 15_000);

const home = home_module.resolve_home({ SPINNER_HOME: home_root }) as { root: string };
const summary = store.create_session(home, { title: "tty e2e" }) as { dir: string; path: string };
mkdirSync(join(summary.path, "agents", "engine"), { recursive: true });
writeFileSync(
    join(summary.path, "agents", "engine", "BRIEF.md"),
    "# engine\n\nYou are a test agent. Answer in one word when asked.\n",
);
console.log(`session: ${summary.dir}`);

const events: Array<{ type: string; agent?: string }> = [];
const bus = new WebSocket(`ws://127.0.0.1:${port}/events`);
bus.on("message", (data) => events.push(JSON.parse(String(data)) as { type: string }));
await new Promise<void>((resolve_) => bus.once("open", () => resolve_()));

step("spawn a tty agent");
const added = await fetch(`${base}/sessions/${summary.dir}/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "engine" }),
});
check(added.status === 201, `POST agents → ${added.status} ${await added.text()}`);
const recorded = session_yaml().agents["engine"];
check(recorded?.harness === "tty", `session.yaml harness ${recorded?.harness}`);
check(typeof recorded?.pid === "number", `session.yaml pid ${recorded?.pid}`);
check(typeof recorded?.started === "string", `session.yaml started ${recorded?.started}`);
const pi_pid = recorded?.pid ?? 0;

step("attach and open the command list with /");
let term = await attach();
await wait_for(() => term.text().length > 0, "the first pty bytes", 20_000);
term.socket.send(JSON.stringify({ resize: { cols: 140, rows: 45 } }));
await dismiss_notices(term);
await wait_for(
    () => hello_seen(),
    "the extension's hello (the Context tab lists commands)",
    30_000,
);
// pi has no `/help`; typing `/` opens its command list, which the extension's
// `/spinner-reload` must be in. The keystrokes go one at a time, as a person types.
for (const key of ["/", "s", "p"]) {
    term.socket.send(Buffer.from(key), { binary: true });
    await sleep(150);
}
await wait_for(() => term.text().includes("spinner-reload"), "pi's command list", 15_000);
console.log("  pi listed its commands on `/` (spinner-reload is in the list)");
for (let i = 0; i < 3; i += 1) {
    term.socket.send(Buffer.from("\x7f"), { binary: true });
    await sleep(100);
}
term.socket.send(Buffer.from("\x1b"), { binary: true });
await sleep(300);

step("prompt through the route");
const prompted = await fetch(`${base}/sessions/${summary.dir}/agents/engine/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: PROMPT }),
});
const disposition = (await prompted.json()) as { disposition?: string };
check(prompted.status === 200, `POST prompt → ${prompted.status}`);
console.log(`  disposition: ${disposition.disposition ?? "?"}`);
await wait_for(
    () => events.some((event) => event.type === "agent.settled" && event.agent === "engine"),
    "agent.settled on the bus",
    120_000,
);
await wait_for(() => /pong/i.test(term.text()), "pong in the terminal", 10_000);
console.log("  the turn ran and the terminal shows the answer");
const folded = events
    .filter((event) => event.type === "agent.event")
    .map((event) => (event as { event: { type: string } }).event.type);
console.log(`  agent.event types: ${[...new Set(folded)].join(", ")}`);

step("kill the daemon, restart it, attach again");
daemon.kill("SIGKILL");
await sleep(1_000);
console.log(`  pi ${pi_pid} after the daemon died: ${alive(pi_pid) ? "alive" : "gone"}`);
daemon = start_daemon();
await wait_for(() => health(), "the daemon's /health after restart", 15_000);
await wait_for(
    async () => {
        const response = await fetch(`${base}/sessions/${summary.dir}`);
        const body = (await response.json()) as { session: { agents_running: string[] } };
        return body.session.agents_running.includes("engine");
    },
    "the agent resumed by adopt_all",
    90_000,
);
const after = session_yaml().agents["engine"];
check(after?.pid !== pi_pid, `a new pi pid (${after?.pid}) replaced ${pi_pid}`);
term = await attach();
await wait_for(() => term.text().length > 0, "the first pty bytes after resume", 20_000);
await dismiss_notices(term);
await wait_for(() => /pong/i.test(term.text()), "the transcript redrawn after resume", 30_000);
console.log("  the resumed pi shows the earlier turn");

step("stop");
const stopped = await fetch(`${base}/sessions/${summary.dir}/agents/engine/stop`, {
    method: "POST",
});
check(stopped.status === 200, `POST stop → ${stopped.status}`);
await wait_for(() => session_yaml().agents["engine"]?.process === "exited", "exited", 15_000);
bus.close();
daemon.kill("SIGTERM");
await new Promise<void>((resolve_) => daemon.once("exit", () => resolve_()));
console.log(`\nPASS. scratch home kept at ${home_root}`);

// ---------------------------------------------------------------------------------------

function start_daemon(): ChildProcess {
    const child = spawn(process.execPath, [daemon_main], {
        env: {
            ...process.env,
            SPINNER_HOME: home_root,
            SPINNER_PORT: String(port),
            SPINNER_NOTIFY: "off",
            SPINNER_POLL_SECONDS: "0",
        },
        stdio: ["ignore", "inherit", "inherit"],
    });
    return child;
}

async function health(): Promise<boolean> {
    try {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) });
        return response.ok;
    } catch {
        return false;
    }
}

interface Term {
    socket: WebSocket;
    text(): string;
}

function attach(): Promise<Term> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/sessions/${summary.dir}/agents/engine/tty`);
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
            reject(new Error(`attach refused: ${response.statusCode}`)),
        );
        socket.once("error", reject);
    });
}

/**
 * pi's startup notices ("Press any key to continue...") wait for the operator in the tab;
 * the e2e presses Enter for them, as the operator would. Up to 3 notices.
 */
async function dismiss_notices(term: Term): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
        await sleep(1_500);
        const text = term.text();
        const notices = text.split("Press any key to continue").length - 1;
        if (notices <= i) {
            return;
        }
        console.log("  pi shows a startup notice; pressing Enter as the operator would");
        term.socket.send(Buffer.from("\r"), { binary: true });
    }
}

async function hello_seen(): Promise<boolean> {
    const response = await fetch(`${base}/sessions/${summary.dir}/agents/engine/context`);
    const body = (await response.json()) as { commands: unknown[] };
    return body.commands.length > 0;
}

function session_yaml(): { agents: Record<string, Record<string, unknown>> } {
    return parse(readFileSync(join(summary.path, "session.yaml"), "utf8")) as {
        agents: Record<string, Record<string, unknown>>;
    };
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
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
        await sleep(200);
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
    daemon.kill("SIGTERM");
    process.exit(1);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve_) => setTimeout(resolve_, ms));
}
