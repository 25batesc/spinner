#!/usr/bin/env node
// E2e for the diff tab against the real viewer (MISSION.md s012, "Done when", the e2e line):
// a scratch daemon on a scratch SPINNER_HOME and a free port, the sample project over a
// scratch git repo, a branch with a diff of at least 5,000 changed lines, `POST diff/start`
// (the first one fetches the viewer from GitHub and runs `npm install`), the page opened in
// headless Chrome over CDP with the time to its load event and to its rendered diff, the
// viewer's RSS, a comment left through the viewer's own HTTP API, the notice in a fake tty
// agent's terminal, the reply through the agent's route, the thread turned to the operator
// and `needs_human` set, then `close` stopping the viewer. Never touches the operator's
// daemon on :7777 or ~/.spinner. Needs a built daemon (`pnpm -r build`), network access to
// GitHub, `npm`, and Chrome at its macOS path or `DIFFVIEW_CHROME`.
//
//     node packages/daemon/e2e/diff.ts
//
// The scratch directory is printed and kept, as the session protocol asks.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { parse } from "yaml";

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}

/** A minimal CDP client over one browser WebSocket, with flattened sessions. */
class Cdp {
    private next = 1;
    private readonly waiting = new Map<number, Pending>();
    private readonly events = new Map<string, (params: unknown) => void>();

    private readonly socket: WebSocket;

    private constructor(socket: WebSocket) {
        this.socket = socket;
        socket.on("message", (raw) => {
            const message = JSON.parse(String(raw)) as {
                id?: number;
                result?: unknown;
                error?: { message: string };
                method?: string;
                params?: unknown;
                sessionId?: string;
            };
            if (message.id !== undefined) {
                const pending = this.waiting.get(message.id);
                this.waiting.delete(message.id);
                if (message.error) {
                    pending?.reject(new Error(message.error.message));
                } else {
                    pending?.resolve(message.result);
                }
            } else if (message.method !== undefined) {
                this.events.get(`${message.method}@${message.sessionId ?? ""}`)?.(message.params);
            }
        });
    }

    static connect(url: string): Promise<Cdp> {
        return new Promise((resolve_, reject) => {
            const socket = new WebSocket(url);
            socket.once("open", () => resolve_(new Cdp(socket)));
            socket.once("error", reject);
        });
    }

    send(method: string, params: unknown, sessionId?: string): Promise<unknown> {
        const id = this.next;
        this.next += 1;
        return new Promise((resolve_, reject) => {
            this.waiting.set(id, { resolve: resolve_, reject });
            const session = sessionId === undefined ? {} : { sessionId };
            this.socket.send(JSON.stringify({ id, method, params, ...session }));
        });
    }

    once(method: string, sessionId: string): Promise<unknown> {
        return new Promise((resolve_) => {
            this.events.set(`${method}@${sessionId}`, (params) => {
                this.events.delete(`${method}@${sessionId}`);
                resolve_(params);
            });
        });
    }

    close(): void {
        this.socket.close();
    }
}

const here = dirname(fileURLToPath(import.meta.url));
const checkout = resolve(here, "..", "..", "..");
const daemon_main = resolve(here, "..", "dist", "main.js");
const FAKE_PI = resolve(here, "..", "test", "fixtures", "fake-pi-tty.ts");
const CHROME_DEFAULT = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROME = process.env["DIFFVIEW_CHROME"] ?? CHROME_DEFAULT;

/** The git identity of the scratch repo's commits. */
const IDENTITY = ["-c", "user.name=spinner-e2e", "-c", "user.email=e2e@example.invalid"];

/** The branch's diff must change at least this many lines. */
const CHANGED_LINES_MIN = 5_000;

const scratch = mkdtempSync(join(tmpdir(), "spinner-e2e-diff-"));
const home_root = join(scratch, "home");
mkdirSync(home_root, { recursive: true });
const port = await free_port();
const base = `http://127.0.0.1:${port}`;
console.log(`scratch: ${scratch}`);
console.log(`scratch home: ${home_root}`);
console.log(`scratch daemon: ${base}`);

let last_term: Term | null = null;
let chrome: ChildProcess | null = null;

step("a sample project over a scratch git repo");
const project_dir = join(home_root, "projects", "sample");
const repo_dir = join(scratch, "repo");
make_sample_project(project_dir, repo_dir);
console.log(`  project ${join(project_dir, "spinner.yaml")}, repo ${repo_dir}`);

const daemon = start_daemon();
await wait_for(() => health(), "the daemon's /health", 15_000);

step("a session with the project attached");
const project = join(project_dir, "spinner.yaml");
const created = await post(`/sessions`, { title: "diff e2e", project });
check(created.status === 202, `POST /sessions → ${created.status}`);
const new_job = ((await created.json()) as { job: { id: string; session: string } }).job;
const session_dir = new_job.session;
const session_path = join(home_root, "sessions", session_dir);
await wait_job(new_job.id, "attach", 120_000);
const worktree = join(session_path, String(session_yaml().repos["app"]?.["worktree"]));
check(existsSync(worktree), `worktree ${worktree}`);
const branch = String(session_yaml().branch);

step(`a commit with at least ${CHANGED_LINES_MIN} changed lines on ${branch}`);
const changed = big_commit(worktree);
check(changed >= CHANGED_LINES_MIN, `${changed} lines changed against main`);

step("a fake tty agent in the worktree");
const added = await post(`/sessions/${session_dir}/agents`, { name: "engine", repo: "app" });
check(added.status === 201, `POST agents → ${added.status} ${await added.text()}`);
const term = await attach(`/sessions/${session_dir}/agents/engine/tty`);
await wait_for(() => term.text().includes("fake pi"), "the fake pi's banner", 20_000);

step("POST diff/start: the first start fetches the viewer, then starts it");
const before = await session_view();
check(before.diff.fetch === "absent", `diff.fetch before the first start: ${before.diff.fetch}`);
const fetch_started = Date.now();
const started = await post(`/sessions/${session_dir}/diff/start`, {});
check(started.status === 202, `POST diff/start → ${started.status}`);
const diff_job = ((await started.json()) as { job: { id: string } }).job;
const job_log = await wait_job(diff_job.id, "diff", 6 * 60_000);
console.log(`  fetch and start took ${((Date.now() - fetch_started) / 1000).toFixed(1)} s`);
for (const line of job_log.filter((l) => /clone|npm install|fetched|diff viewer/.test(l))) {
    console.log(`  job: ${line}`);
}
const running = await session_view();
const app = running.diff.repos["app"];
check(running.diff.fetch === "ready", `diff.fetch: ${running.diff.fetch}`);
check(app?.state === "running", `diff.repos.app.state: ${app?.state} ${app?.error ?? ""}`);
const viewer_url = String(app?.url);
const viewer_pid = Number(app?.pid);
console.log(`  viewer ${viewer_url} pid ${viewer_pid}`);
const marker = JSON.parse(
    readFileSync(join(home_root, "diffview", "src", "fetched.json"), "utf8"),
) as { viewer: string; peanut: string };
console.log(`  fetched viewer ${marker.viewer.slice(0, 12)}, peanut ${marker.peanut.slice(0, 12)}`);

step("the page in headless Chrome: time to load and to the rendered diff");
const page_url = `${viewer_url}view?branch=${encodeURIComponent(branch)}&perf`;
const timing = await measure_page(page_url);
console.log(`  navigate → Page.loadEventFired: ${timing.load_ms} ms`);
console.log(`  navigate → diff rendered (window.diffviewPerf): ${timing.rendered_ms} ms`);
for (const row of timing.rows) {
    console.log(`    ${row.request.padEnd(24)} ${String(row.ms).padStart(6)} ms`);
}
console.log(`  screenshot: ${timing.screenshot}`);
const ps_args = ["-o", "rss=", "-p", String(viewer_pid)];
const rss_kb = Number(execFileSync("ps", ps_args, { encoding: "utf8" }));
console.log(`  viewer RSS after the load: ${(rss_kb / 1024).toFixed(0)} MiB`);
check(rss_kb > 0, "viewer RSS read");

step("a comment through the viewer's own HTTP API");
const branch_query = `branch=${encodeURIComponent(branch)}`;
const diff = (await (await fetch(`${viewer_url}api/diff?${branch_query}`)).json()) as {
    sha: string;
    files: Array<{ path: string; firstLine: number }>;
};
const file =
    diff.files.find((f) => f.path.startsWith("examples/sample-stack/bulk/")) ?? diff.files[0];
check(file !== undefined, `a file in the diff (${diff.files.length} files)`);
const comment = await fetch(`${viewer_url}api/comments`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: viewer_url.replace(/\/$/, "") },
    body: JSON.stringify({
        branch,
        sha: diff.sha,
        kind: "lines",
        path: file?.path,
        side: "new",
        startLine: file?.firstLine,
        endLine: file?.firstLine,
        body: "Why is this line here?",
    }),
});
const comment_text = await comment.clone().text();
check(comment.status === 201, `POST api/comments → ${comment.status} ${comment_text}`);
const thread_id = ((await comment.json()) as { id: number }).id;
console.log(`  thread #${thread_id} on ${file?.path}:${file?.firstLine}`);

step("the notice reaches the fake tty agent");
const where = `app ${file?.path}:${file?.firstLine}`;
await wait_for(
    () => term.text().includes(`notice: diff comment #${thread_id} on ${where} waits on you.`),
    "the notice in the agent's terminal",
    90_000,
);
check(true, "the terminal shows the notice");
await wait_for(
    async () => (await session_view()).diff.repos["app"]?.waiting.agent === 1,
    "waiting.agent = 1 in the view",
    60_000,
);
const during = (await session_view()).summary.session.needs_human;
check(during === null, "needs_human is null while it is the agent's turn");

step("the agent replies through its route (the diff_reply tool)");
const replied = await post(`/sessions/${session_dir}/agents/engine/diff/comments`, {
    command: "reply",
    threads: [thread_id],
    text: "It pads the fixture to five thousand lines.",
});
check(replied.status === 200, `POST agents/engine/diff/comments → ${replied.status}`);
const reply = (await replied.json()) as { code: number; stdout: string; stderr: string };
check(reply.code === 0, `reply exit ${reply.code}: ${reply.stderr}`);
console.log(`  ${reply.stdout.trim().split("\n")[0]}`);
const comments_route = `/sessions/${session_dir}/agents/engine/diff/comments`;
const listed = await post(comments_route, { command: "list" });
const list = (await listed.json()) as { code: number; stdout: string };
check(list.code === 0 && list.stdout.includes("waiting on human"), "list: waiting on human");

step("the thread waits on the operator: needs_human");
await wait_for(
    async () => (await session_view()).summary.session.needs_human !== null,
    "needs_human set",
    60_000,
);
const needs = String((await session_view()).summary.session.needs_human);
check(needs === `answer diff comment #${thread_id} on ${where}`, `needs_human: ${needs}`);
const turned = (await (await fetch(`${viewer_url}api/comments?${branch_query}`)).json()) as {
    threads: Array<{ id: number; waitingOn: string; messages: Array<{ author: string }> }>;
};
const thread = turned.threads.find((t) => t.id === thread_id);
const waiting_on = thread?.waitingOn;
check(waiting_on === "human", `the viewer shows #${thread_id} waiting on ${waiting_on}`);
const signed = thread?.messages.at(-1)?.author;
check(signed === "engine", `the reply is signed ${signed}`);

step("close stops the viewer");
const closed = await post(`/sessions/${session_dir}/close`, {});
check(closed.status === 202, `POST close → ${closed.status}`);
await wait_job(((await closed.json()) as { job: { id: string } }).job.id, "close", 120_000);
await wait_for(() => !alive(viewer_pid), "the viewer process to exit", 15_000);
check(!alive(viewer_pid), `viewer pid ${viewer_pid} is gone`);

term.socket.close();
chrome?.kill("SIGTERM");
daemon.kill("SIGTERM");
console.log(`\nPASS. scratch kept at ${scratch}`);
process.exit(0);

// ---------------------------------------------------------------------------------------

/** `examples/sample-stack` over a scratch git repo with one commit on `main`. */
function make_sample_project(project: string, repo: string): void {
    mkdirSync(repo, { recursive: true });
    cpSync(join(checkout, "examples", "sample-stack"), join(repo, "examples", "sample-stack"), {
        recursive: true,
    });
    git(repo, "init", "--quiet", "--initial-branch=main");
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", "sample stack");
    mkdirSync(project, { recursive: true });
    const spec = readFileSync(join(checkout, "examples", "sample-stack", "spinner.yaml"), "utf8");
    writeFileSync(join(project, "spinner.yaml"), spec.replace("path: ../..", `path: ${repo}`));
    cpSync(join(checkout, "examples", "sample-stack", "seed.sql"), join(project, "seed.sql"));
}

function git(repo: string, ...args: string[]): string {
    return execFileSync(
        "git",
        ["-C", repo, ...IDENTITY, ...args],
        { encoding: "utf8" },
    );
}

/** Ten generated files of 520 lines each plus a README edit, committed. Returns lines changed. */
function big_commit(worktree: string): number {
    const bulk = join(worktree, "examples", "sample-stack", "bulk");
    mkdirSync(bulk, { recursive: true });
    for (let file = 0; file < 10; file += 1) {
        const lines: string[] = [`// Generated fixture ${file} for the diff e2e.`];
        for (let line = 1; line < 520; line += 1) {
            lines.push(`export function fixture_${file}_${line}(v) { return v + ${line}; }`);
        }
        writeFileSync(join(bulk, `fixture-${file}.js`), `${lines.join("\n")}\n`);
    }
    const readme = join(worktree, "examples", "sample-stack", "README.md");
    const note = "\nThe `bulk/` files are the diff e2e's fixture.\n";
    writeFileSync(readme, `${readFileSync(readme, "utf8")}${note}`);
    git(worktree, "add", "-A");
    git(worktree, "commit", "--quiet", "-m", "e2e: a large diff for the viewer");
    const stat = git(worktree, "diff", "--shortstat", "main...HEAD");
    const match = /(\d+) insertions?.*?(?:(\d+) deletions?)?/.exec(stat);
    return Number(match?.[1] ?? 0) + Number(match?.[2] ?? 0);
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
            SPINNER_PI: FAKE_PI,
            SPINNER_OPERATOR: "off",
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

function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

interface Job {
    id: string;
    state: string;
    error?: string | null;
    log: string[];
}

/** Waits for the job to finish and fails on a failed one. Returns its log. */
async function wait_job(id: string, what: string, timeout_ms: number): Promise<string[]> {
    let job: Job | null = null;
    await wait_for(
        async () => {
            job = ((await (await fetch(`${base}/jobs/${id}`)).json()) as { job: Job }).job;
            return job.state !== "running";
        },
        `the ${what} job`,
        timeout_ms,
    );
    const finished = job as Job | null;
    if (finished === null || finished.state !== "ok") {
        console.error(finished?.log.join("\n") ?? "");
        fail(`${what} job ${id} ended ${finished?.state ?? "?"}: ${finished?.error ?? ""}`);
    }
    return finished.log;
}

interface View {
    summary: { session: { needs_human: string | null } };
    diff: { fetch: string; repos: Record<string, RepoView> };
}

interface RepoView {
    state: string;
    url: string | null;
    pid: number | null;
    error: string | null;
    waiting: { agent: number; human: number };
}

async function session_view(): Promise<View> {
    const response = await fetch(`${base}/sessions/${session_dir}`);
    return ((await response.json()) as { session: View }).session;
}

function session_yaml(): { branch: string; repos: Record<string, Record<string, unknown>> } {
    return parse(readFileSync(join(session_path, "session.yaml"), "utf8"));
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
            reject(new Error(`attach refused: ${response.statusCode}`)),
        );
        socket.once("error", reject);
    });
}

/** `window.diffviewPerf`, as `public/js/perf.js` fills it with `?perf`. */
interface Perf {
    loads: Array<{ totalMs: number; rows: Array<{ request: string; ms: number }> }>;
}

interface PageTiming {
    load_ms: number;
    rendered_ms: number;
    rows: Array<{ request: string; ms: number }>;
    screenshot: string;
}

/**
 * Headless Chrome over CDP: one target, `Page.navigate`, the load event, then
 * `window.diffviewPerf` once the page reported its load (`?perf`), and a screenshot.
 */
async function measure_page(url: string): Promise<PageTiming> {
    if (!existsSync(CHROME)) {
        fail(`no Chrome at ${CHROME}; set DIFFVIEW_CHROME`);
    }
    const debug_port = await free_port();
    chrome = spawn(
        CHROME,
        [
            "--headless=new",
            `--remote-debugging-port=${debug_port}`,
            `--user-data-dir=${join(scratch, "chrome")}`,
            "--no-first-run",
            "--window-size=1400,1000",
            "about:blank",
        ],
        { stdio: "ignore" },
    );
    let version: { webSocketDebuggerUrl: string } | null = null;
    await wait_for(
        async () => {
            try {
                const response = await fetch(`http://127.0.0.1:${debug_port}/json/version`);
                version = (await response.json()) as { webSocketDebuggerUrl: string };
                return true;
            } catch {
                return false;
            }
        },
        "Chrome's debugging endpoint",
        20_000,
    );
    const found = version as { webSocketDebuggerUrl: string } | null;
    const cdp = await Cdp.connect(found?.webSocketDebuggerUrl ?? "");
    const target = (await cdp.send("Target.createTarget", { url: "about:blank" })) as {
        targetId: string;
    };
    const { targetId } = target;
    const attach_params = { targetId, flatten: true };
    const { sessionId } = (await cdp.send("Target.attachToTarget", attach_params)) as {
        sessionId: string;
    };
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    const loaded = cdp.once("Page.loadEventFired", sessionId);
    const started = Date.now();
    await cdp.send("Page.navigate", { url }, sessionId);
    await loaded;
    const load_ms = Date.now() - started;
    let perf: Perf | null = null;
    let rendered_ms = 0;
    await wait_for(
        async () => {
            const result = (await cdp.send(
                "Runtime.evaluate",
                { expression: "JSON.stringify(window.diffviewPerf ?? null)", returnByValue: true },
                sessionId,
            )) as { result: { value: string } };
            const parsed = JSON.parse(result.result.value) as Perf | null;
            if (parsed !== null && parsed.loads.length > 0) {
                perf = parsed;
                rendered_ms = Date.now() - started;
                return true;
            }
            return false;
        },
        "window.diffviewPerf to report the load",
        60_000,
    );
    const shot = (await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId)) as {
        data: string;
    };
    const screenshot = join(scratch, "diff-tab.png");
    writeFileSync(screenshot, Buffer.from(shot.data, "base64"));
    const first = (perf as Perf | null)?.loads[0];
    cdp.close();
    return { load_ms, rendered_ms, rows: first?.rows ?? [], screenshot };
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
    console.error(`scratch kept at ${scratch}`);
    chrome?.kill("SIGTERM");
    daemon.kill("SIGTERM");
    process.exit(1);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve_) => setTimeout(resolve_, ms));
}
