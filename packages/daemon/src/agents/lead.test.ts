// Goal: a session starts from one paste (MISSION.md s014, "Done when" items 1 and 2).
// `POST /sessions/extract` finds the PR references in the paste and resolves them against
// the project; `POST /sessions` with `text` and `adopt` creates the session with a
// provisional title, attaches the project with the adopted PR's worktree on its head branch,
// starts the agent `lead` in the lead role with the lead brief, and prompts it with the
// paste; `POST /sessions/:dir/adopt` adopts a reference into the running session. Method: a
// daemon on a temporary home with the fake interactive pi, a fake `gh` that serves the
// scrubbed fixtures, and a real clone of a bare origin as the project's repo.
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtractResponse, Job, SpinnerEvent } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import type { GhRunner, PrResponse } from "../pipeline/github.js";
import { start_daemon, type Daemon } from "../server.js";
import { run_ok } from "../stack/shell.js";
import { read_session } from "../store/session-store.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(here, "..", "..", "test", "fixtures", "fake-pi-tty.ts");
const FIXTURES = resolve(here, "..", "..", "test", "fixtures", "github");
const APPROVING = join(FIXTURES, "pr-approving.json");
const FIXING = join(FIXTURES, "pr-fixing.json");
const PR_URL = "https://github.com/acme/backend/pull/4812";

const SPEC = [
    "name: acme",
    "base: develop",
    "repos:",
    "  backend: { path: ../code/backend }",
    "services: {}",
    "pipeline:",
    "  github: { org: acme }",
    "",
].join("\n");

let root: string;
let home: SpinnerHome;
let daemon: Daemon;
let base: string;
let events: SpinnerEvent[];

/** Answers `api user`, serves the fixtures for PRs 4812 and 4825, 404s the rest. */
const gh: GhRunner = async (args) => {
    if (args[0] === "api" && args[1] === "user") {
        return "owner-1\n";
    }
    if (args.some((arg) => arg === "number=4812")) {
        return readFileSync(APPROVING, "utf8");
    }
    if (args.some((arg) => arg === "number=4825")) {
        return readFileSync(FIXING, "utf8");
    }
    throw new Error("Could not resolve to a PullRequest with the number given");
};

function head_of(fixture: string): string {
    return (JSON.parse(readFileSync(fixture, "utf8")) as PrResponse).data.repository.pullRequest
        .headRefName;
}

async function make_backend(root_dir: string): Promise<void> {
    const seed = join(root_dir, "seed");
    await run_ok("git", ["init", "--quiet", "--initial-branch", "develop", seed]);
    await run_ok("git", ["-C", seed, "config", "user.email", "t@example.com"]);
    await run_ok("git", ["-C", seed, "config", "user.name", "t"]);
    writeFileSync(join(seed, "README.md"), "hi\n");
    await run_ok("git", ["-C", seed, "add", "README.md"]);
    await run_ok("git", ["-C", seed, "commit", "--quiet", "-m", "init"]);
    await run_ok("git", ["-C", seed, "branch", head_of(APPROVING), "develop"]);
    await run_ok("git", ["-C", seed, "branch", head_of(FIXING), "develop"]);
    const origin = join(root_dir, "origin.git");
    await run_ok("git", ["clone", "--quiet", "--bare", seed, origin]);
    await run_ok("git", ["clone", "--quiet", origin, join(root_dir, "code", "backend")]);
}

beforeEach(async () => {
    chmodSync(FAKE_PI, 0o755);
    root = mkdtempSync(join(tmpdir(), "spinner-lead-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home") });
    const project = join(root, "acme");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "spinner.yaml"), SPEC);
    await make_backend(root);
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
        cwd: root,
    });
    base = `http://127.0.0.1:${daemon.port}`;
    events = [];
    daemon.bus.subscribe((event) => events.push(event));
});

afterEach(async () => {
    await daemon.close();
    delete process.env["FAKE_PI_ARGS_FILE"];
    rmSync(root, { recursive: true, force: true });
});

function call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

/** Polls `check` until it is true, at most 20 s (a worktree add runs git a few times). */
async function until(check: () => boolean): Promise<void> {
    for (let poll = 0; poll < 1000; poll += 1) {
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

describe("POST /sessions/extract", () => {
    it("resolves every reference form against the project and looks it up", async () => {
        const text = `Land the refund flow\n${PR_URL} and backend#4825, plus #4 and other#1`;
        const response = await call("POST", "/sessions/extract", { text, project: "acme" });
        expect(response.status).toBe(200);
        const body = (await response.json()) as ExtractResponse;
        expect(body.rest).toBe("Land the refund flow\nand , plus and");
        expect(body.prs.map((pr) => [pr.ref, pr.url, pr.key, pr.adoptable])).toEqual([
            [PR_URL, PR_URL, "backend", true],
            ["backend#4825", "https://github.com/acme/backend/pull/4825", "backend", true],
            ["#4", "https://github.com/acme/backend/pull/4", "backend", false],
            ["other#1", null, null, false],
        ]);
        expect(body.prs[0]?.branch).toBe(head_of(APPROVING));
        expect(body.prs[2]?.reason).toContain("Could not resolve");
        expect(body.prs[3]?.reason).toContain("not a repo of the project");
        // No project: a full URL still resolves, but nothing is adoptable.
        const bare = await call("POST", "/sessions/extract", { text: PR_URL });
        const prs = ((await bare.json()) as ExtractResponse).prs;
        expect(prs[0]).toMatchObject({ url: PR_URL, adoptable: false });
        expect(await (await call("POST", "/sessions/extract", {})).text()).toContain("`text`");
    });
});

describe("POST /sessions with text", () => {
    it("creates, adopts, starts the lead with its brief and the paste as its message", async () => {
        const args_file = join(root, "args.json");
        process.env["FAKE_PI_ARGS_FILE"] = args_file;
        const text = `Land the refund flow before Friday.\nSee ${PR_URL} and backend#4825.`;
        const started = await call("POST", "/sessions", { text, project: "acme", adopt: [PR_URL] });
        expect(started.status).toBe(202);
        const { job } = (await started.json()) as { job: Job };
        expect(job.session).not.toBeNull();
        const dir = job.session as string;
        expect(dir).toMatch(/^s\d+-land-the-refund-flow-before-friday$/);
        const done = await wait_job(job.id);
        expect(done.state, done.log.join("\n")).toBe("ok");
        expect(done.log.join("\n")).toContain("adopted acme/backend#4812 as backend");
        expect(done.log.join("\n")).toContain("starting lead in the backend worktree");
        expect(done.log.join("\n")).toContain("first message delivered");

        const read = read_session(home, dir);
        expect(read.ok).toBe(true);
        if (!read.ok) {
            return;
        }
        const session = read.summary.session;
        expect(session.title).toBe("Land the refund flow before Friday.");
        expect(session.branch).toBe(head_of(APPROVING));
        expect(session.repos["backend"]?.pr?.number).toBe(4812);
        const worktree = join(read.summary.path, session.repos["backend"]?.worktree ?? "");
        const branch = await run_ok("git", ["-C", worktree, "branch", "--show-current"]);
        expect(branch.trim()).toBe(head_of(APPROVING));
        expect(session.agents?.["lead"]).toMatchObject({ process: "idle", repo: "backend" });

        const spawned = JSON.parse(readFileSync(args_file, "utf8")) as {
            cwd: string;
            env: Record<string, string>;
        };
        expect(spawned.env["SPINNER_ROLE"]).toBe("lead");
        expect(realpathSync(spawned.cwd)).toBe(realpathSync(worktree));
        const brief = readFileSync(join(read.summary.path, "agents", "lead", "BRIEF.md"), "utf8");
        expect(brief).toContain("You own the mission");
        expect(brief).toContain("session_title");
        expect(brief).toContain("Do not push, post, approve, land, reset or close");
        const mission = readFileSync(join(read.summary.path, "MISSION.md"), "utf8");
        expect(mission).toContain("the lead agent owns the mission");
        expect(mission).toContain(`- ${PR_URL}`);

        // The paste, the adopted PR and the mentioned one reached pi as the first prompt.
        await until(() =>
            (daemon.tty.lookup(dir, "lead")?.scrollback_text() ?? "").includes("> Land the refund"),
        );
        const shown = daemon.tty.lookup(dir, "lead")?.scrollback_text() ?? "";
        expect(shown).toContain(`Adopted: ${PR_URL} (backend, worktree worktrees/backend)`);
        expect(shown).toContain("Mentioned: https://github.com/acme/backend/pull/4825");
    });

    it("keeps the old body working and refuses a body with neither title nor text", async () => {
        const old = await call("POST", "/sessions", { title: "Plain" });
        expect(old.status).toBe(202);
        const { job } = (await old.json()) as { job: Job };
        const done = await wait_job(job.id);
        expect(done.state).toBe("ok");
        const read = read_session(home, job.session as string);
        expect(read.ok && read.summary.session.agents).toEqual({});
        const neither = await call("POST", "/sessions", { project: "acme" });
        expect(neither.status).toBe(400);
        expect(await neither.text()).toContain("`title` or `text`");
        const adopt_without = await call("POST", "/sessions", { text: "x", adopt: [PR_URL] });
        expect(adopt_without.status).toBe(409);
    });
});

describe("POST /sessions/:dir/adopt", () => {
    it("adopts a reference into a running session and refuses the rest with a reason", async () => {
        const started = await call("POST", "/sessions", { text: "Refunds", project: "acme" });
        const { job } = (await started.json()) as { job: Job };
        const dir = job.session as string;
        expect((await wait_job(job.id)).state).toBe("ok");
        const adopt = await call("POST", `/sessions/${dir}/adopt`, {
            refs: ["backend#4825", "other#1"],
        });
        expect(adopt.status).toBe(202);
        const adopted = await wait_job(((await adopt.json()) as { job: Job }).job.id);
        expect(adopted.state, adopted.log.join("\n")).toBe("ok");
        expect(adopted.log.join("\n")).toContain("refused other#1");
        expect(adopted.log.join("\n")).toContain("switched to");
        const read = read_session(home, dir);
        expect(read.ok && read.summary.session.repos["backend"]?.pr?.number).toBe(4825);
        const worktree = join(home.sessions, dir, "worktrees", "backend");
        const branch = await run_ok("git", ["-C", worktree, "branch", "--show-current"]);
        expect(branch.trim()).toBe(head_of(FIXING));
        expect(existsSync(join(worktree, ".spinner"))).toBe(true);
        const none = await call("POST", `/sessions/${dir}/adopt`, { refs: ["other#1"] });
        const failed = await wait_job(((await none.json()) as { job: Job }).job.id);
        expect(failed.state).toBe("failed");
        expect(failed.error).toContain("no adoptable");
    });
});
