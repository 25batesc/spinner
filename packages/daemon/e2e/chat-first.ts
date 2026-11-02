#!/usr/bin/env node
// E2e for chat first against the real pi (MISSION.md s014, "Done when", the e2e line): a
// scratch daemon on a scratch SPINNER_HOME and a free port, the sandbox repository cloned into
// the scratch as the one repo of a scratch project. The script pastes one sentence and one
// PR URL of that repository through `POST /sessions/extract` (the PR must come back
// adoptable), starts the session with `POST /sessions { text, project, adopt }`, and waits on
// artifacts: the job's worktree on the PR's branch, the agent `lead` running in it, a Goal
// and three Plan items in `GET /sessions/:dir/mission/view` within two minutes of the first
// message, then a tick with its time after one steer, carried by `mission.changed`. Never
// touches the operator's daemon on :7777 or ~/.spinner; nothing is pushed or posted. Needs a
// built daemon (`pnpm -r build`), `git` with read access to the repository, and a `pi` with a
// working model (SPINNER_PI or PATH).
//
//     node packages/daemon/e2e/chat-first.ts
//
// SPINNER_E2E_REPO (`owner/name`, default 25batesc/spinner-sandbox) and SPINNER_E2E_PR (a
// number, default 1) pick the pull request. The scratch home is printed and kept.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const daemon_main = resolve(here, "..", "dist", "main.js");

const REPO = process.env["SPINNER_E2E_REPO"] ?? "25batesc/spinner-sandbox";
const PR_NUMBER = Number(process.env["SPINNER_E2E_PR"] ?? "1");
const PR_URL = `https://github.com/${REPO}/pull/${PR_NUMBER}`;
const SENTENCE =
    "Write a short CHANGELOG entry for the live loop. Plan it in three steps; " +
    "do not edit any file until the operator says so.";
const PASTE = `${SENTENCE}\n${PR_URL}`;
const STEER =
    "Plan item 1 is done. Tick it now with mission_plan (command tick, id 1) and then stop.";

/** The time the lead gets to write Goal and three Plan items after its first message. */
const MISSION_WITHIN_MS = 120_000;

/** The last attached terminal, so a failure can dump what pi drew. */
let last_term: Term | null = null;

const scratch = mkdtempSync(join(tmpdir(), "spinner-e2e-chat-first-"));
const home_root = join(scratch, "home");
mkdirSync(home_root, { recursive: true });
const port = await free_port();
const base = `http://127.0.0.1:${port}`;
console.log(`scratch home: ${home_root}`);
console.log(`scratch daemon: ${base}`);

step(`a scratch project over a clone of ${REPO}`);
const project_dir = join(home_root, "projects", "sandbox-e2e");
const repo_dir = join(scratch, "repo");
make_project(project_dir, repo_dir);
// The spec by its path: `find_spec` looks in the checkout's `local/<name>` before the home's
// `projects/<name>`, and the operator's own `local/sandbox` names the real clone.
const project = join(project_dir, "spinner.yaml");
console.log(`  project ${project}, clone ${repo_dir}`);

let daemon: ChildProcess | null = null;
const spinnerd = start_daemon();
daemon = spinnerd;
await wait_for(() => health(), "the daemon's /health", 15_000);

const events: Array<Record<string, unknown> & { type: string }> = [];
const bus = new WebSocket(`ws://127.0.0.1:${port}/events`);
bus.on("message", (data) => events.push(JSON.parse(String(data)) as { type: string }));
await new Promise<void>((resolve_) => bus.once("open", () => resolve_()));

step("the paste goes through POST /sessions/extract");
const extracted = await post("/sessions/extract", { text: PASTE, project });
check(extracted.status === 200, `POST /sessions/extract → ${extracted.status}`);
const extraction = (await extracted.json()) as {
    prs: Array<{ url: string | null; adoptable: boolean; branch: string | null; reason?: string }>;
    rest: string;
};
const pr = extraction.prs[0];
check(pr !== undefined && pr.url === PR_URL, `one reference, ${PR_URL}`);
check(pr?.adoptable === true, `adoptable (${pr?.reason ?? "no reason"})`);
check(extraction.rest === SENTENCE, "rest is the sentence without the URL");
console.log(`  branch ${pr?.branch}`);

step("POST /sessions with the text starts one job");
const started = await post("/sessions", { text: PASTE, project, adopt: [PR_URL] });
check(started.status === 202, `POST /sessions → ${started.status}`);
const { job } = (await started.json()) as { job: { id: string; session: string | null } };
check(job.session !== null, `the session exists at once: ${job.session}`);
const session_dir = job.session as string;
const session_path = join(home_root, "sessions", session_dir);
const finished = await wait_job(job.id);
for (const line of finished.log) {
    console.log(`  job: ${line}`);
}
check(finished.state === "ok", `job ${job.id} ${finished.state}${finished.error ?? ""}`);
const yaml = session_yaml();
const app = yaml.repos?.["app"];
check(app?.worktree !== undefined && existsSync(join(session_path, app.worktree)), "worktree");
const worktree_path = join(session_path, app?.worktree ?? "");
const branch = execFileSync("git", ["branch", "--show-current"], { cwd: worktree_path })
    .toString()
    .trim();
check(branch === pr?.branch, `the worktree is on the PR's branch ${branch}`);
const common_dir = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: worktree_path })
    .toString()
    .trim();
check(
    realpathSync(common_dir).startsWith(realpathSync(repo_dir)),
    `the worktree belongs to the scratch clone (${common_dir})`,
);
check(yaml.agents?.["lead"] !== undefined, "the agent lead is recorded");
const first_message_at = Date.now();

step("the lead's terminal");
const term = await attach(`/sessions/${session_dir}/agents/lead/tty`);
await wait_for(() => term.text().length > 0, "the first pty bytes", 20_000);
term.socket.send(JSON.stringify({ resize: { cols: 140, rows: 45 } }));
await dismiss_notices(term);
await wait_for(() => hello_seen(), "the lead extension's hello", 60_000);
console.log("  the extension said hello; the first message is queued or delivered");

step("the lead writes a Goal and three Plan items");
const remaining = MISSION_WITHIN_MS - (Date.now() - first_message_at);
await wait_for(
    async () => {
        const view = await mission_view();
        return view.goal.length > 0 && view.plan.length >= 3;
    },
    "Goal and 3 Plan items within two minutes of the first message",
    Math.max(remaining, 10_000),
);
const written = await mission_view();
console.log(`  after ${((Date.now() - first_message_at) / 1000).toFixed(0)} s`);
console.log(`  title: ${written.title}`);
console.log(`  Goal: ${written.goal.split("\n")[0]}`);
for (const item of written.plan.slice(0, 3)) {
    console.log(`  Plan ${item.id}: ${item.text} (${item.owner ?? "-"}, ${item.state})`);
}
check(written.plan.every((item) => Number.isInteger(item.id)), "every Plan item has an id");

step("a steer; the lead ticks item 1; the view and the event carry the time");
const first = written.plan[0];
check(first !== undefined && first.state !== "done", "item 1 is not done yet");
const seen_before = events.length;
const steered = await post(`/sessions/${session_dir}/agents/lead/steer`, { text: STEER });
check(steered.status === 200, `POST .../lead/steer → ${steered.status}`);
await wait_for(
    async () => (await mission_view()).plan[0]?.state === "done",
    "Plan item 1 ticked",
    180_000,
);
const ticked = (await mission_view()).plan[0];
check(/^\d\d:\d\d$/.test(ticked?.ticked_at ?? ""), `ticked at ${ticked?.ticked_at}`);
const carried = events
    .slice(seen_before)
    .filter((event) => event.type === "mission.changed")
    .map((event) => event["view"] as Pick<MissionView, "plan"> | undefined)
    .find((view) => view?.plan[0]?.state === "done");
check(carried !== undefined, "mission.changed carried the view with the tick");
check(carried?.plan[0]?.ticked_at === ticked?.ticked_at, "the event's time is the file's");
const file = readFileSync(join(session_path, "MISSION.md"), "utf8");
const line = file.split("\n").find((entry) => /^- \[x\] 1\. /.test(entry));
check(line !== undefined, `the file line: ${line}`);
check(/\([^()]*, \d\d:\d\d\)$/.test(line ?? ""), "the line ends with (owner, HH:MM)");

step("stop");
bus.close();
term.socket.close();
spinnerd.kill("SIGTERM");
await new Promise<void>((resolve_) => spinnerd.once("exit", () => resolve_()));
console.log(`\nPASS. scratch home kept at ${home_root}`);

// ---------------------------------------------------------------------------------------

/** The repository cloned into the scratch, as the one repo of a project in the scratch home. */
function make_project(project: string, repo: string): void {
    execFileSync("git", ["clone", "--quiet", `https://github.com/${REPO}.git`, repo], {
        stdio: "ignore",
    });
    mkdirSync(project, { recursive: true });
    const owner = REPO.split("/")[0] ?? "";
    writeFileSync(
        join(project, "spinner.yaml"),
        [
            "name: sandbox-e2e",
            "base: main",
            "repos:",
            `  app: { path: ${repo}, base: main }`,
            "services: {}",
            "pipeline:",
            `  github: { org: ${owner}, write_repos: [] }`,
            "",
        ].join("\n"),
    );
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

interface JobView {
    state: string;
    log: string[];
    error: string | null;
}

async function wait_job(id: string): Promise<JobView> {
    let job: JobView = { state: "running", log: [], error: null };
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

interface PlanItem {
    id: number;
    text: string;
    owner: string | null;
    state: string;
    ticked_at: string | null;
}

interface MissionView {
    title: string;
    goal: string;
    plan: PlanItem[];
}

async function mission_view(): Promise<MissionView> {
    const response = await fetch(`${base}/sessions/${session_dir}/mission/view`);
    return ((await response.json()) as { view: MissionView }).view;
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

/** True once the lead's extension posted `hello`: the commands list is not empty. */
async function hello_seen(): Promise<boolean> {
    const response = await fetch(`${base}/sessions/${session_dir}/agents/lead/context`);
    const body = (await response.json()) as { commands: unknown[] };
    return body.commands.length > 0;
}

interface SessionYaml {
    repos?: Record<string, { worktree?: string }>;
    agents?: Record<string, unknown>;
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
