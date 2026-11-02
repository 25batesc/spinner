#!/usr/bin/env node
// E2e for the review lead against the real pi (MISSION.md s016, "Done when", the e2e line): a
// scratch daemon on a scratch SPINNER_HOME and a free port. The script pastes the sandbox PR
// through `POST /reviews` with one real reviewer model, one reviewer on a model that does
// not exist (its chip must read `failed` with the reason), and the same real model for the
// lead; the lead and the reviewers run headless (rpc), so `/tty` refuses them with 409. It
// waits on artifacts: the lead's process and the reviewer's chip, `artifacts/briefing.md`
// (`review.briefing` on the view), the verdict file `artifacts/reviews/<model-slug>.md`
// (the chip reads `done`), the draft `artifacts/review-draft.json` with `needs_human` set,
// then posts it through `POST /sessions/:dir/review/post` and reads the review URL from the
// view and `session.yaml`. One review goes up on the sandbox PR. Never touches the
// operator's daemon on :7777 or ~/.spinner; nothing is pushed. Needs a built daemon
// (`pnpm -r build`), `gh` with write access to the sandbox repository, and a `pi` with a
// working model (SPINNER_PI or PATH).
//
//     node packages/daemon/e2e/review-lead.ts
//
// SPINNER_E2E_REPO (`owner/name`, default 25batesc/spinner-sandbox), SPINNER_E2E_PR (a
// number, default 2) and SPINNER_E2E_MODEL (`provider/model`, default
// anthropic/claude-fable-5-1) pick the pull request and the model. The scratch home is
// printed and kept.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
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
const BAD_MODEL = "nope/no-such-model";
const NEEDS_HUMAN = "post or drop the review draft";

/** The time each step gets: the briefing, the verdict, the draft. */
const STEP_WITHIN_MS = 15 * 60_000;

const scratch = mkdtempSync(join(tmpdir(), "spinner-e2e-review-lead-"));
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

step("settings: one real model and one bad one for the swarm; the real one for the lead");
const settings = await put("/settings", {
    theme: "system",
    default_model: MODEL,
    review: { models: [MODEL, BAD_MODEL], n: 2 },
});
check(settings.status === 200, `PUT /settings → ${settings.status}`);

step("the paste goes through POST /reviews: the session, the lead, the swarm");
const started_at = Date.now();
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
check(
    finished.log.some((line) => line.startsWith("lead started")),
    "the lead started",
);
let view = await session_view();
check(view.kind === "review", "the view's kind is review");
check(view.agents_running.includes("lead"), "the lead's pi runs");
const member = view.review?.swarm.find((m) => m.model === MODEL);
check(member !== undefined, `one reviewer: ${member?.name} (${member?.model})`);
check(member?.state === "reading", `its chip reads ${member?.state}`);
const reviewer = member?.name ?? "";
const bad = view.review?.swarm.find((m) => m.model === BAD_MODEL);
check(bad?.state === "failed", `the bad model's chip reads ${bad?.state}`);
console.log(`  its reason: ${bad?.error}`);
check((bad?.error ?? "").includes("Unknown provider"), "the reason names the unknown provider");
check(view.review?.state === "reviewing", `review.state ${view.review?.state}`);
check(session_yaml().agents?.["lead"]?.harness === "rpc", "the lead is headless (rpc)");
check(session_yaml().agents?.[reviewer]?.harness === "rpc", "the reviewer is headless (rpc)");
check(view.review?.briefing === false, "no briefing yet");
check(view.review?.draft === null, "no draft yet");
const lead_brief = readFileSync(join(session_path, "agents", "lead", "BRIEF.md"), "utf8");
check(lead_brief.includes("Role: lead reviewer of"), "the lead's brief is the review lead's");

step("no terminal: /tty refuses the review session's agents");
for (const name of ["lead", reviewer]) {
    const status = await tty_status(`/sessions/${session_dir}/agents/${name}/tty`);
    check(status === 409, `/tty of ${name} → ${status}`);
}

step("the briefing appears");
await wait_for(
    async () => (await session_view()).review?.briefing === true,
    "review.briefing on the view",
    STEP_WITHIN_MS,
);
const briefing_file = join(session_path, "artifacts", "briefing.md");
check(existsSync(briefing_file), `artifacts/briefing.md exists`);
const briefing = await fetch(`${base}/sessions/${session_dir}/review/briefing`);
check(briefing.status === 200, `GET .../review/briefing → ${briefing.status}`);
const briefing_text = await briefing.text();
console.log(`  after ${elapsed()} s: ${briefing_text.split("\n").length} lines`);
console.log(`  first line: ${briefing_text.split("\n")[0] ?? ""}`);
check(/what this pr does/i.test(briefing_text), "the briefing has the first section");

step("the verdict file appears; the chip reads done");
await wait_for(
    async () =>
        (await session_view()).review?.swarm.find((m) => m.model === MODEL)?.state !== "reading",
    "the reviewer to leave reading",
    STEP_WITHIN_MS,
);
view = await session_view();
const final = view.review?.swarm.find((m) => m.model === MODEL);
console.log(`  after ${elapsed()} s: ${final?.state}`);
check(final?.state === "done", `the chip reads done (${final?.state})`);
const slug = MODEL.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
const verdict_file = join(session_path, "artifacts", "reviews", `${slug}.md`);
check(existsSync(verdict_file), `the verdict file ${verdict_file}`);
const verdict = readFileSync(verdict_file, "utf8");
const verdict_line = verdict.split("\n").find((line) => line.includes("VERDICT:")) ?? "";
console.log(`  ${verdict_line.trim()}`);
check(/VERDICT:\s*(BLOCKING|CLEAR)/.test(verdict), "the verdict file carries the VERDICT line");
await wait_for(
    async () => !(await session_view()).agents_running.includes(reviewer),
    "the reviewer's pi to stop",
    30_000,
);

step("the draft appears with needs_human");
await wait_for(
    async () => (await session_view()).review?.draft !== null,
    "review.draft on the view",
    STEP_WITHIN_MS,
);
view = await session_view();
const draft = view.review?.draft;
check(draft !== null && draft !== undefined, "the draft is on the view");
console.log(
    `  after ${elapsed()} s: ${draft?.event} "${draft?.body}", ${draft?.comments.length} comments`,
);
for (const comment of draft?.comments ?? []) {
    console.log(`  ${comment.path}:${comment.line} ${comment.body.split("\n")[0] ?? ""}`);
}
check(existsSync(join(session_path, "artifacts", "review-draft.json")), "the draft file exists");
check(view.board?.needs_human === NEEDS_HUMAN, `needs_human: ${view.board?.needs_human}`);
check(session_yaml().needs_human === NEEDS_HUMAN, "session.yaml needs_human");
check(view.review?.state === "drafted", `review.state ${view.review?.state}`);
check(
    view.review?.comment_count === draft?.comments.length,
    `comment_count ${view.review?.comment_count}`,
);
check(view.review?.event === draft?.event, `event ${view.review?.event}`);
const model_named = JSON.stringify(draft)
    .toLowerCase()
    .includes(MODEL.split("/")[1] ?? MODEL);
check(!model_named, "the draft names no model");
const carried = events.filter(
    (event) => event.type === "review.updated" && event.session === session_dir,
);
const trail = carried.map((event) => {
    const data = event["data"] as {
        swarm: Array<{ model: string; state: string }>;
        briefing: boolean;
        draft: unknown;
    };
    const state = data.swarm.find((m) => m.model === MODEL)?.state ?? "-";
    return `${state}/${data.briefing ? "b" : "-"}/${data.draft === null ? "-" : "d"}`;
});
console.log(`  review.updated: ${[...new Set(trail)].join(" → ")}`);
check(trail.at(-1) === "done/b/d", "review.updated ends with done, briefing, draft");

step("post posts one review; the URL shows");
const reviews_before = await reviews_count();
const posted = await post(`/sessions/${session_dir}/review/post`, {});
const posted_text = await posted.text();
check(posted.status === 200, `POST .../review/post → ${posted.status} ${posted_text}`);
const result = JSON.parse(posted_text) as { url: string; event: string; fell_back: boolean };
console.log(
    `  ${result.event}${result.fell_back ? " (fell back from APPROVE)" : ""}: ${result.url}`,
);
check(result.url.startsWith(`${PR_URL}#pullrequestreview-`), "the URL is a review on the PR");
view = await session_view();
check(view.review?.posted_url === result.url, "the view carries posted_url");
check(view.review?.draft === null, "the draft is gone from the view");
check(session_yaml().review?.posted_url === result.url, "session.yaml carries posted_url");
check(session_yaml().needs_human !== NEEDS_HUMAN, "needs_human cleared");
await wait_for(
    async () => (await session_view()).review?.state === "posted",
    "review.state posted (the lead's turn ends)",
    60_000,
);
check((await session_view()).review?.state === "posted", "review.state posted");
const mission = readFileSync(join(session_path, "MISSION.md"), "utf8");
check(mission.includes(result.url), "the Log carries the URL");
const reviews_after = await reviews_count();
check(
    reviews_after === reviews_before + 1,
    `one review more on the PR (${reviews_before} → ${reviews_after})`,
);
const again = await post(`/sessions/${session_dir}/review/post`, {});
check(again.status === 409, `a second post → ${again.status}`);

step("stop");
bus.close();
spinnerd.kill("SIGTERM");
await new Promise<void>((resolve_) => spinnerd.once("exit", () => resolve_()));
console.log(`\nPASS in ${elapsed()} s. scratch home kept at ${home_root}`);

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

function elapsed(): string {
    return ((Date.now() - started_at) / 1000).toFixed(0);
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

interface Draft {
    event: string;
    body: string;
    comments: Array<{ path: string; line: number; body: string }>;
}

interface ReviewFields {
    briefing: boolean;
    draft: Draft | null;
    posted_url: string | null;
    state: string;
    comment_count: number;
    event: string | null;
    swarm: Array<{ name: string; model: string; state: string; usd: number; error: string | null }>;
}

interface View {
    kind?: string;
    agents_running: string[];
    board: { needs_human: string | null } | null;
    review?: ReviewFields;
}

async function session_view(): Promise<View> {
    const response = await fetch(`${base}/sessions/${session_dir}`);
    return ((await response.json()) as { session: View }).session;
}

/** The PR's reviews, through the operator's `gh`, read-only. */
async function reviews_count(): Promise<number> {
    const { execFile } = await import("node:child_process");
    return new Promise((resolve_, reject) => {
        execFile(
            "gh",
            ["api", `repos/${REPO}/pulls/${PR_NUMBER}/reviews`, "--paginate", "--jq", "length"],
            (error, stdout) => {
                if (error !== null) {
                    reject(error);
                    return;
                }
                resolve_(
                    stdout
                        .trim()
                        .split("\n")
                        .map((line) => Number(line))
                        .reduce((sum, n) => sum + n, 0),
                );
            },
        );
    });
}

/** The status of the `/tty` upgrade: 101 when a pty answers, else the refusal's status. */
function tty_status(path: string): Promise<number> {
    return new Promise((resolve_) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
        socket.once("open", () => {
            socket.close();
            resolve_(101);
        });
        socket.once("unexpected-response", (_request, response) => {
            resolve_(response.statusCode ?? 0);
        });
        socket.once("error", () => resolve_(0));
    });
}

interface SessionYaml {
    needs_human?: string | null;
    review?: { posted_url?: string | null };
    agents?: Record<string, { harness?: string }>;
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
    console.error(`scratch home kept at ${home_root}`);
    daemon?.kill("SIGTERM");
    process.exit(1);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve_) => setTimeout(resolve_, ms));
}
