// Goal: the `review` step as the swarm (MISSION.md s015, Plan item 3). `POST
// /sessions/:dir/review` starts one tty agent per model of `settings.review` in the PR
// repo's worktree, each with the review brief and the skill through `--skill`; a reviewer
// whose settled turn carries `POSTED model=` is `posted` and its pi stops; one that exits
// without it is `failed`; past the running-agents cap the rest wait as `queued` and start on
// an exit; the same swarm runs on an ordinary session (s016) so its chips show; the view and
// `review.updated` carry the swarm; the route refuses a session without an open PR, a PR
// without a worktree, a reviewer still reading, and a bad body; `PUT /settings` validates
// `review`. Method: a daemon on a temporary home with a fake `gh`, a local origin repository
// the review session clones, and the fake interactive pi (`test/fixtures/fake-pi-tty.ts`),
// which echoes each prompt as its assistant text, so a prompt of `POSTED model=...` is the
// reviewer's last line and a prompt of `exit` is an exit without one.
import { execFileSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type {
    Job,
    ReviewUpdatedEvent,
    Session,
    SessionSummary,
    SessionView,
    Settings,
    SpinnerEvent,
} from "@spinner/protocol";
import { REVIEW_POSTED_PREFIX } from "@spinner/protocol";
import { has_posted_line, reviewer_name } from "../agents/swarm.js";
import { resolve_home, type SpinnerHome } from "../home.js";
import { start_daemon, type Daemon } from "../server.js";
import { create_session, read_session, write_session } from "../store/session-store.js";
import { adopt_prs } from "./adopt.js";
import { pipeline_config_from_spec } from "./config.js";
import { pr_facts_from_response, type GhRunner, type PrResponse } from "./github.js";
import { review_targets } from "./review.js";
import { create_reviews } from "./reviews.js";
import { apply_pr_facts } from "./tracker.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(here, "..", "..", "test", "fixtures", "fake-pi-tty.ts");
const FIXTURE = resolve(here, "..", "..", "test", "fixtures", "github", "pr-approving.json");
const FIXTURE_HEAD = "c46867ff747b5d774b3073ead5ebc54c939bdfb4";
const PR_URL = "https://github.com/acme/backend/pull/4812";
const MODEL_A = "x-ai/grok-4.6";
const MODEL_B = "openai/gpt-6-luna";
const NAME_A = reviewer_name(MODEL_A, "backend", false);
const NAME_B = reviewer_name(MODEL_B, "backend", false);

let root: string;
let home: SpinnerHome;
let daemon: Daemon | undefined;
let base: string;
let events: SpinnerEvent[];
let origin: string;
let head: string;
let skill_dir: string;
let args_file: string;
let gh_calls: string[][];

const gh: GhRunner = async (args) => {
    gh_calls.push(args);
    if (args[0] === "api" && args[1] === "user") {
        return "owner-1\n";
    }
    if (args.some((arg) => arg === "number=4812")) {
        return readFileSync(FIXTURE, "utf8").replaceAll(FIXTURE_HEAD, head);
    }
    throw new Error(`fake gh: ${args.join(" ")}`);
};

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function make_origin(path: string): string {
    mkdirSync(path, { recursive: true });
    git(path, "init", "--quiet", "--initial-branch=main");
    git(path, "config", "user.email", "spinner@example.test");
    git(path, "config", "user.name", "spinner");
    writeFileSync(join(path, "README.md"), "# origin\n");
    git(path, "add", "README.md");
    git(path, "commit", "--quiet", "-m", "init");
    const sha = git(path, "rev-parse", "HEAD");
    git(path, "update-ref", "refs/pull/4812/head", sha);
    return sha;
}

/** A daemon on a fresh home; `cap` is the running-agents cap. */
async function boot(cap: number): Promise<void> {
    chmodSync(FAKE_PI, 0o755);
    root = mkdtempSync(join(tmpdir(), "spinner-swarm-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home") });
    mkdirSync(home.root, { recursive: true });
    origin = join(root, "origin");
    head = make_origin(origin);
    skill_dir = join(root, "review-pr");
    mkdirSync(skill_dir);
    writeFileSync(join(skill_dir, "SKILL.md"), "# review-pr\n");
    args_file = join(root, "pi-args.json");
    process.env["FAKE_PI_ARGS_FILE"] = args_file;
    gh_calls = [];
    const started = await start_daemon({
        home,
        port: 0,
        operator: false,
        log: () => undefined,
        poll_seconds: 0,
        gh,
        notify: async () => undefined,
        ui_dir: null,
        observe_interval_ms: 60_000,
        pi: FAKE_PI,
        cwd: root,
        clone_url: () => origin,
        agents_running_max: cap,
        review_skill_default: skill_dir,
    });
    daemon = started;
    base = `http://127.0.0.1:${started.port}`;
    events = [];
    started.bus.subscribe((event) => events.push(event));
}

afterEach(async () => {
    delete process.env["FAKE_PI_ARGS_FILE"];
    if (daemon === undefined) {
        return;
    }
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
});

function call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

async function until(check: () => boolean, what = "condition"): Promise<void> {
    for (let poll = 0; poll < 500; poll += 1) {
        if (check()) {
            return;
        }
        await new Promise((resolve_) => setTimeout(resolve_, 20));
    }
    throw new Error(`${what} not met in time`);
}

async function wait_job(id: string): Promise<Job> {
    let job: Job | null = null;
    await until(() => {
        const found = events.find(
            (event) => event.type === "job.finished" && event.job === id,
        ) as { data: Job } | undefined;
        job = found?.data ?? null;
        return job !== null;
    }, `job ${id}`);
    return job as unknown as Job;
}

function session_yaml(dir: string): Session {
    return parse(readFileSync(join(home.sessions, dir, "session.yaml"), "utf8")) as Session;
}

function swarm_state(dir: string, name: string): string | undefined {
    return session_yaml(dir).review?.swarm[name]?.state;
}

async function view_of(dir: string): Promise<SessionView> {
    return ((await (await call("GET", `/sessions/${dir}`)).json()) as { session: SessionView })
        .session;
}

/** A review session of PR 4812 over the local origin. */
async function review_session(): Promise<SessionSummary> {
    const result = await create_reviews(home, { text: PR_URL, gh, clone_url: () => origin });
    const first = result.sessions[0];
    expect(first).toBeDefined();
    return first as SessionSummary;
}

/** An ordinary session (s016) that tracks PR 4812 with a worktree for `backend`. */
function ordinary_session(): SessionSummary {
    const created = create_session(home, { title: "Ordinary" });
    const worktree = "worktrees/backend";
    mkdirSync(join(created.path, worktree), { recursive: true });
    const response = JSON.parse(readFileSync(FIXTURE, "utf8")) as PrResponse;
    const config = pipeline_config_from_spec({});
    const facts = pr_facts_from_response(response, { config: config.github, owner_login: "o" });
    const session: Session = {
        ...created.session,
        repos: { backend: { path: origin, worktree, changed: true, pr: null } },
    };
    write_session({ ...created, session: apply_pr_facts(session, "backend", facts) });
    const read = read_session(home, created.dir);
    expect(read.ok).toBe(true);
    return read.ok ? read.summary : created;
}

async function start_review(dir: string, body?: unknown): Promise<Job> {
    const started = await call("POST", `/sessions/${dir}/review`, body);
    expect(started.status, await started.clone().text()).toBe(202);
    const { job } = (await started.json()) as { job: Job };
    expect(job.action).toBe("review");
    const done = await wait_job(job.id);
    expect(done.state, done.log.join("\n")).toBe("ok");
    return done;
}

function prompt(dir: string, name: string, text: string): Promise<Response> {
    return call("POST", `/sessions/${dir}/agents/${name}/prompt`, { text });
}

describe("review helpers", () => {
    it("names reviewers and reads the POSTED line", () => {
        daemon = undefined;
        expect(NAME_A).toBe("review-x-ai-grok-4-6");
        expect(reviewer_name("anthropic/claude-opus-5-5", "web", true)).toBe(
            "review-web-anthropic-claude-opus-5-5",
        );
        expect(has_posted_line(`done.\n${REVIEW_POSTED_PREFIX}a/b blockers=0 should-fix=1`)).toBe(
            true,
        );
        expect(has_posted_line("I posted nothing")).toBe(false);
    });

    it("targets every open PR, or the one named, and refuses the rest", async () => {
        await boot(24);
        const summary = await review_session();
        expect(review_targets(summary, {})).toEqual([
            { key: "backend", number: 4812, url: PR_URL },
        ]);
        expect(review_targets(summary, { pr: "backend" })).toHaveLength(1);
        expect(() => review_targets(summary, { pr: "web" })).toThrow(/no open PR for repo "web"/);
        const plain = create_session(home, { title: "Plain" });
        expect(() => review_targets(plain, {})).toThrow(/no open PR to review/);
    });
});

describe("POST /sessions/:dir/review", () => {
    it("one reviewer per model, brief and skill; POSTED posts, an exit fails", async () => {
        await boot(24);
        const summary = await review_session();
        const settings = { theme: "system", review: { models: [MODEL_A, MODEL_B], n: 2 } };
        expect((await call("PUT", "/settings", settings)).status).toBe(200);
        const job = await start_review(summary.dir);
        expect(job.log.join("\n")).toContain(`${NAME_A} started with ${skill_dir}`);
        expect(job.log.join("\n")).toContain("2 started, 0 queued");
        expect(swarm_state(summary.dir, NAME_A)).toBe("reading");
        expect(swarm_state(summary.dir, NAME_B)).toBe("reading");
        expect(daemon?.agents.running(summary.dir).sort()).toEqual([NAME_A, NAME_B].sort());

        const brief = readFileSync(join(summary.path, "agents", NAME_A, "BRIEF.md"), "utf8");
        expect(brief).toContain(`Target: ${PR_URL}`);
        expect(brief).toContain(`Identify every comment as: **review-blast** · ${MODEL_A}`);
        expect(brief).toContain("Never approve, never request-changes.");
        expect(brief).toContain("Do not checkout, switch, or edit the branch. Do not push.");
        expect(brief).toContain(`POSTED model=${MODEL_A} blockers=N should-fix=M`);
        const spawned = JSON.parse(readFileSync(args_file, "utf8")) as {
            argv: string[];
            cwd: string;
        };
        expect(spawned.argv).toContain("--skill");
        expect(spawned.argv[spawned.argv.indexOf("--skill") + 1]).toBe(skill_dir);
        expect(spawned.argv.join(" ")).toContain("--provider openai --model gpt-6-luna");
        expect(spawned.cwd).toContain(join("worktrees", "backend"));
        expect(session_yaml(summary.dir).agents[NAME_A]?.skills).toEqual([skill_dir]);

        // The kickoff echoed back is not a POSTED line: still reading.
        await until(() => events.some((e) => e.type === "agent.settled" && e.agent === NAME_A));
        expect(swarm_state(summary.dir, NAME_A)).toBe("reading");

        const calls_before = gh_calls.length;
        const line = `${REVIEW_POSTED_PREFIX}${MODEL_A} blockers=0 should-fix=1`;
        const posted = await prompt(summary.dir, NAME_A, line);
        expect(posted.status).toBe(200);
        await until(() => swarm_state(summary.dir, NAME_A) === "posted", "posted");
        await until(() => daemon?.agents.get(summary.dir, NAME_A) === null, "the reviewer's exit");
        expect(swarm_state(summary.dir, NAME_A)).toBe("posted");
        await until(() => gh_calls.length > calls_before, "the poll after the post");

        expect((await prompt(summary.dir, NAME_B, "exit")).status).toBe(200);
        await until(() => swarm_state(summary.dir, NAME_B) === "failed", "failed");

        const view = await view_of(summary.dir);
        expect(view.kind).toBe("review");
        expect(view.review?.swarm).toEqual([
            { name: NAME_A, model: MODEL_A, state: "posted", usd: 0, pr: "backend" },
            { name: NAME_B, model: MODEL_B, state: "failed", usd: 0, pr: "backend" },
        ]);
        const carried = events.filter(
            (event): event is ReviewUpdatedEvent =>
                event.type === "review.updated" && event.session === summary.dir,
        );
        const states = carried.map((event) =>
            event.data.swarm.map((member) => `${member.name}:${member.state}`).join(","),
        );
        expect(states).toContain(`${NAME_A}:reading,${NAME_B}:reading`);
        expect(states.at(-1)).toBe(`${NAME_A}:posted,${NAME_B}:failed`);
        expect(existsSync(join(summary.path, "agents", NAME_A, "pi"))).toBe(true);
    });

    it("queues past the running-agents cap and starts the next on an exit", async () => {
        await boot(1);
        const summary = await review_session();
        const settings = { theme: "system", review: { models: [MODEL_A, MODEL_B], n: 2 } };
        expect((await call("PUT", "/settings", settings)).status).toBe(200);
        const job = await start_review(summary.dir);
        expect(job.log.join("\n")).toContain(`${NAME_B} (${MODEL_B}) queued behind the cap`);
        expect(swarm_state(summary.dir, NAME_A)).toBe("reading");
        expect(swarm_state(summary.dir, NAME_B)).toBe("queued");
        expect((await view_of(summary.dir)).review?.swarm.map((m) => m.state)).toEqual([
            "reading",
            "queued",
        ]);
        await prompt(summary.dir, NAME_A, `${REVIEW_POSTED_PREFIX}${MODEL_A} blockers=0`);
        await until(() => swarm_state(summary.dir, NAME_B) === "reading", "the next reviewer");
        expect(swarm_state(summary.dir, NAME_A)).toBe("posted");
        expect(daemon?.agents.running(summary.dir)).toEqual([NAME_B]);
    });

    it("runs the swarm on an ordinary session too, so its chips show (s016)", async () => {
        await boot(24);
        const summary = ordinary_session();
        const one = { theme: "system", review: { models: [MODEL_A] } };
        expect((await call("PUT", "/settings", one)).status).toBe(200);
        await start_review(summary.dir, { pr: "backend" });
        expect(swarm_state(summary.dir, NAME_A)).toBe("reading");
        const view = await view_of(summary.dir);
        expect(view.kind).toBe("session");
        expect(view.review?.swarm).toEqual([
            { name: NAME_A, model: MODEL_A, state: "reading", usd: 0, pr: "backend" },
        ]);
        expect(view.review?.failing).toEqual(["Independent approval"]);
    });

    it("refuses no open PR, no worktree, a reviewer still reading, and a bad body", async () => {
        await boot(24);
        const plain = create_session(home, { title: "Plain" });
        const none = await call("POST", `/sessions/${plain.dir}/review`);
        expect(none.status).toBe(409);
        expect(await none.text()).toContain("no open PR");
        expect((await call("POST", "/sessions/nope/review")).status).toBe(404);

        const nowhere = join(root, "nowhere");
        const board_only = await adopt_prs(home, { urls: [PR_URL], cwd: nowhere, gh });
        const no_worktree = await call("POST", `/sessions/${board_only.dir}/review`);
        expect(no_worktree.status).toBe(409);
        expect(await no_worktree.text()).toContain("no worktree");

        const summary = await review_session();
        const bad = await call("POST", `/sessions/${summary.dir}/review`, { pr: 7 });
        expect(bad.status).toBe(400);
        const one = { theme: "system", review: { models: [MODEL_A] } };
        expect((await call("PUT", "/settings", one)).status).toBe(200);
        await start_review(summary.dir);
        const again = await call("POST", `/sessions/${summary.dir}/review`);
        expect(again.status).toBe(409);
        expect(await again.text()).toContain("still reads");
        // A review holds no session lock: another job on the session may start beside it.
        expect(daemon?.jobs.running_on(summary.dir)).toBeNull();
    });

    it("PUT /settings validates review", async () => {
        await boot(24);
        const bad_n = await call("PUT", "/settings", { theme: "system", review: { n: 0 } });
        expect(bad_n.status).toBe(400);
        expect(await bad_n.text()).toContain("review.n");
        const bad_models = await call("PUT", "/settings", {
            theme: "system",
            review: { models: [] },
        });
        expect(bad_models.status).toBe(400);
        const unknown = await call("PUT", "/settings", { theme: "system", review: { x: 1 } });
        const unknown_text = await unknown.text();
        expect(unknown_text).toContain("unknown key");
        expect(unknown_text).toContain("review.x");
        const ok = await call("PUT", "/settings", {
            theme: "system",
            review: { skill: "/opt/skill", models: ["a/b"], n: 1 },
        });
        expect(ok.status).toBe(200);
        const read = (await (await call("GET", "/settings")).json()) as { settings: Settings };
        expect(read.settings.review).toEqual({ skill: "/opt/skill", models: ["a/b"], n: 1 });
    });
});
