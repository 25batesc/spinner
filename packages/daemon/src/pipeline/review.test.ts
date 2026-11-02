// Goal: the `review` step (MISSION.md s014, Plan item 10). `POST /sessions/:dir/review`
// starts one `review` job per open PR that runs the operator's `review-blast` with the PR URL,
// `--models` and `--n` from the settings, its stdout and stderr in the job log, bounded;
// refuses a session without an open PR and a PR whose review runs; resolves the script from
// `SPINNER_REVIEW_BLAST`, then `settings.review.command`; polls GitHub once after the run;
// and `PUT /settings` validates `review`. Method: a daemon on a temporary home with a fake
// `gh` that serves the fixtures and a fake script (`test/fixtures/fake-review-blast.sh`).
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Job, SessionSummary, Settings, SpinnerEvent } from "@spinner/protocol";
import { REVIEW_MODELS_DEFAULT, REVIEW_N_DEFAULT } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { start_daemon, type Daemon } from "../server.js";
import { create_session } from "../store/session-store.js";
import { adopt_prs } from "./adopt.js";
import type { GhRunner } from "./github.js";
import { resolve_review_blast, review_args, review_targets } from "./review.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(here, "..", "..", "test", "fixtures", "fake-pi.ts");
const FAKE_BLAST = resolve(here, "..", "..", "test", "fixtures", "fake-review-blast.sh");
const FIXTURE = resolve(here, "..", "..", "test", "fixtures", "github", "pr-approving.json");
const PR_URL = "https://github.com/acme/backend/pull/4812";

let root: string;
let home: SpinnerHome;
let daemon: Daemon;
let base: string;
let events: SpinnerEvent[];
let gh_calls: string[][];
let env: NodeJS.ProcessEnv;

/** Answers `api user` and serves the fixture for PR 4812; records every call. */
const gh: GhRunner = async (args) => {
    gh_calls.push(args);
    if (args[0] === "api" && args[1] === "user") {
        return "owner-1\n";
    }
    if (args.some((arg) => arg === "number=4812")) {
        return readFileSync(FIXTURE, "utf8");
    }
    throw new Error(`fake gh: ${args.join(" ")}`);
};

beforeEach(async () => {
    chmodSync(FAKE_PI, 0o755);
    chmodSync(FAKE_BLAST, 0o755);
    root = mkdtempSync(join(tmpdir(), "spinner-review-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home") });
    mkdirSync(home.root, { recursive: true });
    gh_calls = [];
    env = { ...process.env, SPINNER_REVIEW_BLAST: FAKE_BLAST };
    delete env["FAKE_REVIEW_SLEEP"];
    delete env["FAKE_REVIEW_EXIT"];
    daemon = await start_daemon({
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
        agents_harness: "rpc",
        extension: null,
        cwd: root,
        env,
        review_timeout_ms: 1_500,
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

/** A session adopted board-only from the open PR of the fixture. */
function adopted(): Promise<SessionSummary> {
    return adopt_prs(home, { urls: [PR_URL], cwd: join(root, "nowhere"), gh });
}

describe("review helpers", () => {
    it("resolves the script from the environment, then the settings, then PATH", () => {
        const settings: Settings = { theme: "system", review: { command: "/opt/rb" } };
        expect(resolve_review_blast({ SPINNER_REVIEW_BLAST: "/x/rb" }, settings)).toBe("/x/rb");
        expect(resolve_review_blast({}, settings)).toBe("/opt/rb");
        expect(resolve_review_blast({}, { theme: "system" })).toBe("review-blast");
        expect(review_args(PR_URL, ["a/b", "c/d"], 2)).toEqual([
            PR_URL,
            "--models",
            "a/b,c/d",
            "--n",
            "2",
        ]);
    });

    it("targets every open PR, or the one named, and refuses the rest", async () => {
        const summary = await adopted();
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
    it("runs review-blast per open PR with the settings' models, logs it, polls once", async () => {
        const summary = await adopted();
        const settings = {
            theme: "system",
            review: { models: ["x-ai/grok-4.6", "openai/gpt-6-luna"], n: 2 },
        };
        expect((await call("PUT", "/settings", settings)).status).toBe(200);
        const calls_before = gh_calls.length;
        const started = await call("POST", `/sessions/${summary.dir}/review`);
        expect(started.status).toBe(202);
        const { job } = (await started.json()) as { job: Job };
        expect(job.action).toBe("review");
        expect(job.session).toBe(summary.dir);
        const done = await wait_job(job.id);
        expect(done.state, done.log.join("\n")).toBe("ok");
        const log = done.log.join("\n");
        expect(log).toContain("review of backend#4812: 2 models, 2 each");
        expect(log).toContain(
            `review-blast args: ${PR_URL} --models x-ai/grok-4.6,openai/gpt-6-luna --n 2`,
        );
        const cwd_line = done.log.find((line) => line.startsWith("cwd: ")) ?? "";
        expect(realpathSync(cwd_line.slice(5))).toBe(realpathSync(summary.path));
        expect(log).toContain("stderr: a warning");
        expect(log).toContain("polling GitHub once");
        // The poll fetched the PR again after the run.
        const fetched = gh_calls.slice(calls_before).filter((args) => args.includes("number=4812"));
        expect(fetched.length).toBeGreaterThanOrEqual(1);
    });

    it("uses the default models and count without settings.review", async () => {
        const summary = await adopted();
        const started = await call("POST", `/sessions/${summary.dir}/review`, { pr: "backend" });
        const { job } = (await started.json()) as { job: Job };
        const done = await wait_job(job.id);
        expect(done.log.join("\n")).toContain(
            `--models ${REVIEW_MODELS_DEFAULT.join(",")} --n ${REVIEW_N_DEFAULT}`,
        );
    });

    it("refuses a session without an open PR, a running review, and a bad body", async () => {
        const plain = create_session(home, { title: "Plain" });
        const none = await call("POST", `/sessions/${plain.dir}/review`);
        expect(none.status).toBe(409);
        expect(await none.text()).toContain("no open PR");
        expect((await call("POST", "/sessions/nope/review")).status).toBe(404);

        const summary = await adopted();
        const bad = await call("POST", `/sessions/${summary.dir}/review`, { pr: 7 });
        expect(bad.status).toBe(400);
        env["FAKE_REVIEW_SLEEP"] = "0.5";
        const first = await call("POST", `/sessions/${summary.dir}/review`);
        expect(first.status).toBe(202);
        const again = await call("POST", `/sessions/${summary.dir}/review`);
        expect(again.status).toBe(409);
        expect(await again.text()).toContain("already runs");
        // A review holds no session lock: another job on the session may start beside it.
        expect(daemon.jobs.running_on(summary.dir)).toBeNull();
        const { job } = (await first.json()) as { job: Job };
        expect((await wait_job(job.id)).state).toBe("ok");
        const after = await call("POST", `/sessions/${summary.dir}/review`);
        expect(after.status).toBe(202);
        await wait_job(((await after.json()) as { job: Job }).job.id);
    });

    it("fails the job on a non-zero exit and on the time bound", { timeout: 15_000 }, async () => {
        const summary = await adopted();
        env["FAKE_REVIEW_EXIT"] = "3";
        const failed = await call("POST", `/sessions/${summary.dir}/review`);
        const job = await wait_job(((await failed.json()) as { job: Job }).job.id);
        expect(job.state).toBe("failed");
        expect(job.error).toContain("exited with 3");
        expect(job.log.join("\n")).toContain("review-blast args");
        delete env["FAKE_REVIEW_EXIT"];
        env["FAKE_REVIEW_SLEEP"] = "5";
        const slow = await call("POST", `/sessions/${summary.dir}/review`);
        const timed = await wait_job(((await slow.json()) as { job: Job }).job.id);
        expect(timed.state).toBe("failed");
        expect(timed.error).toContain("ran past");
    });

    it("PUT /settings validates review", async () => {
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
            review: { command: "/opt/rb", models: ["a/b"], n: 1 },
        });
        expect(ok.status).toBe(200);
        const read = (await (await call("GET", "/settings")).json()) as { settings: Settings };
        expect(read.settings.review).toEqual({ command: "/opt/rb", models: ["a/b"], n: 1 });
    });
});
