// Goal: `POST /reviews` (MISSION.md s015, Plan item 2) makes one session of `kind: review`
// per PR reference in the paste: the repository cloned once under `<home>/reviews/`, the PR
// head fetched and checked out detached under the session, the PR facts in `session.yaml`
// so the poller tracks it, and the view carrying `kind`, the checks with the failing ones
// named, the decision, the thread count and an empty swarm; `review.updated` on the bus.
// Method: a daemon on a temporary home with a fake `gh` that serves the fixture of PR 4812
// with its head SHA rewritten to a commit of a local origin repository, which the daemon
// clones from a path instead of GitHub.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type {
    Job,
    ReviewUpdatedEvent,
    Session,
    SessionView,
    SpinnerEvent,
} from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { start_daemon, type Daemon } from "../server.js";
import type { GhRunner } from "./github.js";
import { poll_once } from "./poller.js";
import { review_clone_path } from "./reviews.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "..", "..", "test", "fixtures", "github", "pr-approving.json");
const FIXTURE_HEAD = "c46867ff747b5d774b3073ead5ebc54c939bdfb4";
const PR_URL = "https://github.com/acme/backend/pull/4812";

let root: string;
let home: SpinnerHome;
let daemon: Daemon;
let base: string;
let events: SpinnerEvent[];
let origin: string;
let head: string;
let gh_calls: string[][];

/** Serves PR 4812 with the local origin's commit as its head; records every call. */
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

/** A repository with `main` and a PR head reachable as `refs/pull/4812/head` only. */
function make_origin(path: string): string {
    mkdirSync(path, { recursive: true });
    git(path, "init", "--quiet", "--initial-branch=main");
    git(path, "config", "user.email", "spinner@example.test");
    git(path, "config", "user.name", "spinner");
    writeFileSync(join(path, "README.md"), "# origin\n");
    git(path, "add", "README.md");
    git(path, "commit", "--quiet", "-m", "init");
    git(path, "checkout", "--quiet", "-b", "devin/example-feature");
    writeFileSync(join(path, "feature.txt"), "the feature\n");
    git(path, "add", "feature.txt");
    git(path, "commit", "--quiet", "-m", "feat: example");
    const sha = git(path, "rev-parse", "HEAD");
    git(path, "update-ref", "refs/pull/4812/head", sha);
    git(path, "checkout", "--quiet", "main");
    git(path, "branch", "--quiet", "-D", "devin/example-feature");
    return sha;
}

beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "spinner-reviews-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home") });
    mkdirSync(home.root, { recursive: true });
    origin = join(root, "origin");
    head = make_origin(origin);
    gh_calls = [];
    daemon = await start_daemon({
        home,
        port: 0,
        operator: false,
        log: () => undefined,
        poll_seconds: 0,
        gh,
        notify: async () => undefined,
        ui_dir: null,
        // A path that does not exist: the test asserts what the daemon does when pi cannot
        // start, and the developer's machine has pi on PATH.
        pi: join(root, "no-pi"),
        observe_interval_ms: 60_000,
        agents_harness: "rpc",
        extension: null,
        cwd: root,
        clone_url: () => origin,
    });
    base = `http://127.0.0.1:${daemon.port}`;
    events = [];
    daemon.bus.subscribe((event) => events.push(event));
});

afterEach(async () => {
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

async function until(check: () => boolean): Promise<void> {
    for (let poll = 0; poll < 500; poll += 1) {
        if (check()) {
            return;
        }
        await new Promise((resolve_) => setTimeout(resolve_, 20));
    }
    throw new Error("condition not met in time");
}

async function wait_job(id: string): Promise<Job> {
    let job: Job | null = null;
    await until(() => {
        const found = events.find(
            (event) => event.type === "job.finished" && event.job === id,
        ) as { data: Job } | undefined;
        job = found?.data ?? null;
        return job !== null;
    });
    return job as unknown as Job;
}

async function review_session(text: string): Promise<{ job: Job; dir: string }> {
    const response = await call("POST", "/reviews", { text });
    expect(response.status).toBe(202);
    const started = ((await response.json()) as { job: Job }).job;
    const job = await wait_job(started.id);
    expect(job.error).toBeNull();
    expect(job.state).toBe("ok");
    expect(job.session).not.toBeNull();
    return { job, dir: job.session as string };
}

function session_yaml(dir: string): Session {
    return parse(readFileSync(join(home.sessions, dir, "session.yaml"), "utf8")) as Session;
}

describe("POST /reviews", () => {
    it("makes a review session: clone, detached worktree, facts, the view", async () => {
        const { job, dir } = await review_session(`please look at ${PR_URL} when you can`);
        const session = session_yaml(dir);
        expect(session.kind).toBe("review");
        expect(session.project).toBeUndefined();
        expect(session.stack.state).toBe("none");
        expect(session.branch).toBe("devin/example-feature");
        expect(session.base).toBe("develop");
        expect(session.title).toContain("example feature");
        const repo = session.repos["backend"];
        const ref = { owner: "acme", name: "backend", number: 4812 };
        expect(repo?.path).toBe(review_clone_path(home, ref));
        expect(repo?.worktree).toBe("worktrees/backend");
        expect(repo?.pr?.number).toBe(4812);
        expect(repo?.pr?.head).toBe(head);
        expect(repo?.pr?.checks_failing).toEqual(["Independent approval"]);
        expect(job.log.some((line) => line.includes("cloning"))).toBe(true);

        const clone = join(home.root, "reviews", "acme-backend");
        expect(existsSync(join(clone, ".git"))).toBe(true);
        const worktree = join(home.sessions, dir, "worktrees", "backend");
        expect(git(worktree, "rev-parse", "HEAD")).toBe(head);
        expect(git(worktree, "branch", "--show-current")).toBe("");
        expect(existsSync(join(worktree, "feature.txt"))).toBe(true);
        expect(existsSync(join(worktree, ".spinner"))).toBe(true);

        const view = (
            (await (await call("GET", `/sessions/${dir}`)).json()) as { session: SessionView }
        ).session;
        expect(view.kind).toBe("review");
        // The paste starts the lead and the swarm (s016); this daemon's pi does not exist,
        // so each reviewer fails to start and the lead's failure is one job log line.
        expect(view.review).toEqual({
            checks: "red",
            failing: ["Independent approval"],
            review_decision: "none",
            threads: 2,
            swarm: [
                ["review-x-ai-grok-4-6", "x-ai/grok-4.6"],
                ["review-anthropic-claude-opus-5-5", "anthropic/claude-opus-5-5"],
                ["review-openai-gpt-6-luna", "openai/gpt-6-luna"],
            ].map(([name, model]) => ({
                name,
                model,
                state: "failed",
                usd: 0,
                pr: "backend",
                error: expect.stringMatching(/^did not start: /) as string,
            })),
            briefing: false,
            draft: null,
            posted_url: null,
            state: "idle",
            cancelled: false,
            comment_count: 0,
            event: null,
        });
        expect(job.log.some((line) => line.startsWith("lead did not start:"))).toBe(true);
        expect(job.log).toContain("swarm of 3: 0 started, 0 queued, 3 failed");
        const brief_file = join(home.sessions, dir, "agents", "lead", "BRIEF.md");
        const lead_brief = readFileSync(brief_file, "utf8");
        expect(lead_brief).toContain("Role: lead reviewer of acme/backend#4812");
        expect(lead_brief).toContain("Do not launch reviewers yourself: no `subagent`, no `pi`.");
        expect(lead_brief).toContain("| Any `BLOCKING:` finding | `COMMENT` | `A few blockers` |");
        expect(view.board?.prs[0]?.url).toBe(PR_URL);
        const updated = events.find(
            (event): event is ReviewUpdatedEvent =>
                event.type === "review.updated" && event.session === dir,
        );
        expect(updated?.data.failing).toEqual(["Independent approval"]);
    });

    it("clones once per repository, fetches per review; the poller tracks it", async () => {
        const first = await review_session(`acme/backend#4812`);
        const second = await review_session(`${PR_URL}/files`);
        expect(second.dir).not.toBe(first.dir);
        expect(second.job.log.some((line) => line.includes("cloning"))).toBe(false);
        expect(session_yaml(second.dir).kind).toBe("review");
        const calls_before = gh_calls.length;
        const report = await poll_once(home, {
            gh,
            notify: async () => undefined,
            cwd: root,
        });
        expect(report.errors).toEqual([]);
        expect(report.polled).toEqual([first.dir, second.dir].sort());
        expect(gh_calls.length).toBeGreaterThan(calls_before);
    });

    it("refuses a paste without a PR reference, and a body without text", async () => {
        const none = await call("POST", "/reviews", { text: "nothing to see, #12 is bare" });
        expect(none.status).toBe(409);
        const empty = await call("POST", "/reviews", {});
        expect(empty.status).toBe(400);
        expect(await empty.text()).toContain("`text`");
    });

    it("skips a reference GitHub does not know and still reviews the rest", async () => {
        const { job, dir } = await review_session(`${PR_URL} and acme/backend#9999`);
        expect(session_yaml(dir).kind).toBe("review");
        const skipped = job.log.find((line) => line.includes("9999"));
        expect(skipped).toContain("skipped");
    });
});
