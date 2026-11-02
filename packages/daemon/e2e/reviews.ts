#!/usr/bin/env node
// E2e for reviews against the real pi (MISSION.md s015, "Done when", the e2e line): a scratch
// daemon on a scratch SPINNER_HOME and a free port. The script pastes the sandbox PR through
// `POST /reviews`, waits on artifacts: the review session with its clone under
// `<home>/reviews/`, the detached worktree at the PR head, the view with `kind: review`, the
// CI state and the decision; then starts the swarm with one model through
// `POST /sessions/:dir/review`, watches the reviewer's chip go `reading` then `posted` (the
// reviewer prints its `POSTED` line, with or without an inline comment on the PR), and reads
// the thread count after the poll that follows. Never touches the operator's daemon on :7777
// or ~/.spinner; nothing is pushed; the reviewer may post inline comments on the sandbox PR.
// Needs a built daemon (`pnpm -r build`), `gh` with read access to the repository, and a
// `pi` with a working model (SPINNER_PI or PATH).
//
//     node packages/daemon/e2e/reviews.ts
//
// SPINNER_E2E_REPO (`owner/name`, default 25batesc/spinner-sandbox), SPINNER_E2E_PR (a
// number, default 2) and SPINNER_E2E_MODEL (`provider/model`, default
// anthropic/claude-fable-5-1) pick the pull request and the reviewer. The scratch home is
// printed and kept.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const daemon_main = resolve(here, "..", "dist", "main.js");

const REPO = process.env["SPINNER_E2E_REPO"] ?? "25batesc/spinner-sandbox";
const PR_NUMBER = Number(process.env["SPINNER_E2E_PR"] ?? "2");
const MODEL = process.env["SPINNER_E2E_MODEL"] ?? "anthropic/claude-fable-5-1";
const PR_URL = `https://github.com/${REPO}/pull/${PR_NUMBER}`;
const PASTE = `Please review ${PR_URL} for me.`;

/** The time one reviewer gets to read the PR and print its POSTED line. */
const POSTED_WITHIN_MS = 15 * 60_000;

let last_term: Term | null = null;

const scratch = mkdtempSync(join(tmpdir(), "spinner-e2e-reviews-"));
const home_root = join(scratch, "home");
mkdirSync(home_root, { recursive: true });
const port = await free_port();
const base = `http://127.0.0.1:${port}`;
console.log(`scratch home: ${home_root}`);
console.log(`scratch daemon: ${base}`);
console.log(`PR ${PR_URL}, model ${MODEL}`);

let daemon: ChildProcess | null = null;
const spinnerd = start_daemon();
daemon = spinnerd;
await wait_for(() => health(), "the daemon's /health", 15_000);

const events: Array<Record<string, unknown> & { type: string; session?: string | null }> = [];
const bus = new WebSocket(`ws://127.0.0.1:${port}/events`);
bus.on("message", (data) => events.push(JSON.parse(String(data)) as { type: string }));
await new Promise<void>((resolve_) => bus.once("open", () => resolve_()));

step("settings: one model for the swarm");
const settings = await put("/settings", { theme: "system", review: { models: [MODEL], n: 1 } });
check(settings.status === 200, `PUT /settings → ${settings.status}`);

step("the paste goes through POST /reviews");
const started = await post("/reviews", { text: PASTE });
check(started.status === 202, `POST /reviews → ${started.status}`);
const { job } = (await started.json()) as { job: { id: string } };
const finished = await wait_job(job.id);
for (const line of finished.log) {
    console.log(`  job: ${line}`);
}
check(finished.state === "ok", `job ${job.id} ${finished.state} ${finished.error ?? ""}`);
check(finished.session !== null, `the job names the session: ${finished.session}`);
const session_dir = finished.session as string;
const session_path = join(home_root, "sessions", session_dir);

step("the review session: clone, detached worktree, facts, view");
const yaml = session_yaml();
check(yaml.kind === "review", "session.yaml kind is review");
const repo_name = REPO.split("/")[1] ?? "";
const owner = REPO.split("/")[0] ?? "";
const repo = yaml.repos?.[repo_name];
check(repo !== undefined, `repos.${repo_name} exists`);
const clone = join(home_root, "reviews", `${owner}-${repo_name}`);
check(existsSync(join(clone, ".git")), `the clone at ${clone}`);
const worktree_path = join(session_path, repo?.worktree ?? "");
check(existsSync(join(worktree_path, ".git")), `the worktree ${repo?.worktree}`);
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree_path }).toString().trim();
check(head === repo?.pr?.head, `the worktree is at the PR head ${head.slice(0, 7)}`);
const current = execFileSync("git", ["branch", "--show-current"], { cwd: worktree_path })
    .toString()
    .trim();
check(current === "", "the worktree is detached (no branch)");
let view = await session_view();
check(view.kind === "review", "the view's kind is review");
check(view.review !== undefined, "the view carries review");
console.log(
    `  checks ${view.review?.checks} (failing: ${view.review?.failing.join(", ") || "none"}), ` +
        `decision ${view.review?.review_decision}, threads ${view.review?.threads}`,
);
check(view.review?.swarm.length === 0, "no reviewer yet");
console.log(`  title: ${yaml.title}; ${yaml.branch} → ${yaml.base}`);

step("POST /sessions/:dir/review starts the swarm with one model");
const swarm_started = await post(`/sessions/${session_dir}/review`, {});
check(swarm_started.status === 202, `POST .../review → ${swarm_started.status}`);
const swarm_job = (await swarm_started.json()) as { job: { id: string } };
const swarm_done = await wait_job(swarm_job.job.id);
for (const line of swarm_done.log) {
    console.log(`  job: ${line}`);
}
check(swarm_done.state === "ok", `job ${swarm_job.job.id} ${swarm_done.state}`);
view = await session_view();
const member = view.review?.swarm[0];
check(member !== undefined, `one reviewer: ${member?.name} (${member?.model})`);
check(member?.state === "reading", `its chip reads ${member?.state}`);
const reviewer = member?.name ?? "";
check(view.agents_running.includes(reviewer), "the reviewer's pi runs");
const swarm_started_at = Date.now();

step("the reviewer's terminal");
const term = await attach(`/sessions/${session_dir}/agents/${reviewer}/tty`);
await wait_for(() => term.text().length > 0, "the first pty bytes", 20_000);
term.socket.send(JSON.stringify({ resize: { cols: 140, rows: 45 } }));
await dismiss_notices(term);

step("the reviewer posts; its chip reads posted; the thread count follows");
await wait_for(
    async () => (await session_view()).review?.swarm[0]?.state !== "reading",
    "the reviewer to leave reading",
    POSTED_WITHIN_MS,
);
view = await session_view();
const final = view.review?.swarm[0];
console.log(`  after ${((Date.now() - swarm_started_at) / 1000).toFixed(0)} s: ${final?.state}`);
const posted_line = await last_posted_line(reviewer);
console.log(`  last line: ${posted_line ?? "(none)"}`);
check(final?.state === "posted", `the chip reads posted (${final?.state})`);
check(posted_line !== null && posted_line.includes(`model=${MODEL}`), "POSTED names the model");
const carried = events.filter(
    (event) => event.type === "review.updated" && event.session === session_dir,
);
const states = carried.map((event) => {
    const data = event["data"] as { swarm: Array<{ state: string }> };
    return data.swarm[0]?.state ?? "-";
});
const trail = states.join(" → ");
check(states.includes("reading") && states.at(-1) === "posted", `review.updated: ${trail}`);
check(final !== undefined && final.usd >= 0, `cost on the chip: $${final?.usd.toFixed(4)}`);
await wait_for(() => refresh_running(), "the reviewer's pi to stop", 30_000);
// The POSTED line says how many findings went up; the poll after the post makes the
// count follow. A reviewer with nothing to post leaves the count where it was.
// The POSTED line counts findings, not comments: a finding another reviewer already
// posted is not posted again. The poll after the post renders `threads/` from GitHub and
// the view's count follows it; that is what the chip and the card read.
const findings = posted_count(posted_line ?? "");
console.log(`  findings in the POSTED line: ${findings}; threads before: ${view.review?.threads}`);
let threads_view = await threads_now();
await wait_for(
    async () => {
        threads_view = await threads_now();
        return threads_view.rendered !== null;
    },
    "the poll after the post to render threads/",
    90_000,
);
view = await session_view();
const counted = threads_view.prs[0]?.threads.length ?? 0;
console.log(`  threads on the PR after the poll: ${counted} (view says ${view.review?.threads})`);
check(view.review?.threads === counted, "the view's thread count follows the render");

step("stop");
bus.close();
term.socket.close();
spinnerd.kill("SIGTERM");
await new Promise<void>((resolve_) => spinnerd.once("exit", () => resolve_()));
console.log(`\nPASS. scratch home kept at ${home_root}`);

// ---------------------------------------------------------------------------------------

function start_daemon(): ChildProcess {
    return spawn(process.execPath, [daemon_main], {
        env: {
            ...process.env,
            SPINNER_HOME: home_root,
            SPINNER_PORT: String(port),
            SPINNER_NOTIFY: "off",
            SPINNER_POLL_SECONDS: "0",
            SPINNER_SESSION_IDS: "home",
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

function put(path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

interface JobView {
    state: string;
    session: string | null;
    log: string[];
    error: string | null;
}

async function wait_job(id: string): Promise<JobView> {
    let job: JobView = { state: "running", session: null, log: [], error: null };
    await wait_for(
        async () => {
            const response = await fetch(`${base}/jobs/${id}`);
            job = ((await response.json()) as { job: JobView }).job;
            return job.state !== "running";
        },
        `job ${id}`,
        300_000,
    );
    return job;
}

interface ReviewFields {
    checks: string;
    failing: string[];
    review_decision: string;
    threads: number;
    swarm: Array<{ name: string; model: string; state: string; usd: number }>;
}

interface View {
    kind?: string;
    agents_running: string[];
    review?: ReviewFields;
}

async function session_view(): Promise<View> {
    const response = await fetch(`${base}/sessions/${session_dir}`);
    return ((await response.json()) as { session: View }).session;
}

async function refresh_running(): Promise<boolean> {
    view = await session_view();
    return !view.agents_running.includes(reviewer);
}

/** The reviewer's last assistant line that carries `POSTED`, from its transcript. */
async function last_posted_line(name: string): Promise<string | null> {
    const response = await fetch(`${base}/sessions/${session_dir}/agents/${name}/events`);
    const body = (await response.json()) as {
        events: Array<{ message: { role: string; content: unknown } }>;
    };
    for (const event of [...body.events].reverse()) {
        if (event.message.role !== "assistant") {
            continue;
        }
        const text = text_of(event.message.content);
        const line = text.split("\n").find((entry) => entry.includes("POSTED model="));
        if (line !== undefined) {
            return line.trim();
        }
    }
    return null;
}

interface ThreadsView {
    prs: Array<{ threads: unknown[] }>;
    rendered: string | null;
}

async function threads_now(): Promise<ThreadsView> {
    const response = await fetch(`${base}/sessions/${session_dir}/threads`);
    return ((await response.json()) as { threads: ThreadsView }).threads;
}

/** `blockers=N should-fix=M` of the POSTED line, summed; 0 when the line has no numbers. */
function posted_count(line: string): number {
    const blockers = /blockers=(\d+)/.exec(line);
    const fixes = /should-fix=(\d+)/.exec(line);
    return Number(blockers?.[1] ?? "0") + Number(fixes?.[1] ?? "0");
}

function text_of(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }
    return content
        .filter((part) => typeof part === "object" && part !== null && part.type === "text")
        .map((part) => String((part as { text: string }).text))
        .join("\n");
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
            const term_: Term = { socket, text: () => Buffer.concat(chunks).toString("utf8") };
            last_term = term_;
            resolve_(term_);
        });
        socket.once("unexpected-response", (_request, response) =>
            reject(new Error(`attach ${path} refused: ${response.statusCode}`)),
        );
        socket.once("error", reject);
    });
}

/** pi's startup notices wait for a key; the e2e presses Enter for them. Up to 3 notices. */
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

interface SessionYaml {
    kind?: string;
    title?: string;
    branch?: string;
    base?: string;
    repos?: Record<string, { worktree?: string; pr?: { head?: string } | null }>;
}

function session_yaml(): SessionYaml {
    const file = join(session_path, "session.yaml");
    if (!existsSync(file)) {
        return {};
    }
    return parse(readFileSync(file, "utf8")) as SessionYaml;
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
