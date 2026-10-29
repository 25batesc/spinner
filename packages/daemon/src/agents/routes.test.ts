// Goal: an operator who adopted a PR in the UI can give the session a worktree and an agent
// from the UI alone. `POST /sessions/:dir/attach` checks the PR's head branch out for a
// session adopted without a project; `GET /sessions/:dir/agents/default-brief` renders the
// brief the daemon would write; `POST /sessions/:dir/agents` writes that brief, or the text
// the body carries, when the session has none. Method: a daemon on a temporary home with the
// fake pi, a fake `gh` that serves the scrubbed fixture, and a real clone of a bare origin as
// the project's repo.
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionSummary, SpinnerEvent } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { adopt_prs } from "../pipeline/adopt.js";
import type { GhRunner, PrResponse } from "../pipeline/github.js";
import { start_daemon, type Daemon } from "../server.js";
import { run_ok } from "../stack/shell.js";
import { read_session } from "../store/session-store.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(here, "..", "..", "test", "fixtures", "fake-pi.ts");
const FIXTURE = resolve(here, "..", "..", "test", "fixtures", "github", "pr-approving.json");
const PR_URL = "https://github.com/acme/backend/pull/4812";

const SPEC = [
    "name: acme",
    "base: develop",
    "repos:",
    "  backend: { path: ../code/backend }",
    "services: {}",
    "",
].join("\n");

let root: string;
let home: SpinnerHome;
let daemon: Daemon;
let base: string;
let events: SpinnerEvent[];
let project: string;

/** Answers `api user` and serves the fixture for PR 4812; nothing else. */
const gh: GhRunner = async (args) => {
    if (args[0] === "api" && args[1] === "user") {
        return "owner-1\n";
    }
    if (args.some((arg) => arg === "number=4812")) {
        return readFileSync(FIXTURE, "utf8");
    }
    throw new Error(`fake gh: ${args.join(" ")}`);
};

async function make_backend(root_dir: string): Promise<void> {
    const seed = join(root_dir, "seed");
    await run_ok("git", ["init", "--quiet", "--initial-branch", "develop", seed]);
    await run_ok("git", ["-C", seed, "config", "user.email", "t@example.com"]);
    await run_ok("git", ["-C", seed, "config", "user.name", "t"]);
    writeFileSync(join(seed, "README.md"), "hi\n");
    await run_ok("git", ["-C", seed, "add", "README.md"]);
    await run_ok("git", ["-C", seed, "commit", "--quiet", "-m", "init"]);
    const head = (JSON.parse(readFileSync(FIXTURE, "utf8")) as PrResponse).data.repository
        .pullRequest.headRefName;
    await run_ok("git", ["-C", seed, "branch", head, "develop"]);
    const origin = join(root_dir, "origin.git");
    await run_ok("git", ["clone", "--quiet", "--bare", seed, origin]);
    await run_ok("git", ["clone", "--quiet", origin, join(root_dir, "code", "backend")]);
}

beforeEach(async () => {
    chmodSync(FAKE_PI, 0o755);
    root = mkdtempSync(join(tmpdir(), "spinner-attach-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home") });
    project = join(root, "acme");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "spinner.yaml"), SPEC);
    await make_backend(root);
    daemon = await start_daemon({
        home,
        port: 0,
        log: () => undefined,
        poll_seconds: 0,
        gh,
        notify: async () => undefined,
        ui_dir: null,
        observe_interval_ms: 60_000,
        pi: FAKE_PI,
        extension: null,
        cwd: root,
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

/** Polls `check` until it is true, at most 10 s (a worktree add runs git a few times). */
async function until(check: () => boolean): Promise<void> {
    for (let poll = 0; poll < 500; poll += 1) {
        if (check()) {
            return;
        }
        await new Promise((resolve_) => setTimeout(resolve_, 20));
    }
    throw new Error("condition not met in time");
}

/** A session adopted without a project: board only, no worktree. */
function adopt_board_only(): Promise<SessionSummary> {
    return adopt_prs(home, { urls: [PR_URL], cwd: join(root, "nowhere"), gh });
}

function finished_job(): SpinnerEvent | undefined {
    return events.find((event) => event.type === "job.finished");
}

describe("POST /sessions/:dir/attach", () => {
    it("checks the PR branch out as the repo's worktree of an adopted session", async () => {
        const summary = await adopt_board_only();
        expect(summary.session.repos["backend"]?.worktree).toBeUndefined();

        expect((await call("POST", `/sessions/${summary.dir}/attach`, {})).status).toBe(400);
        expect((await call("POST", `/sessions/nope/attach`, { project })).status).toBe(404);
        const unknown = await call("POST", `/sessions/${summary.dir}/attach`, { project: "zz" });
        expect(unknown.status).toBe(400);

        const accepted = await call("POST", `/sessions/${summary.dir}/attach`, { project });
        expect(accepted.status).toBe(202);
        await until(() => finished_job() !== undefined);
        const finished = finished_job();
        expect(finished).toMatchObject({ type: "job.finished", ok: true });
        const read = read_session(home, summary.dir);
        expect(read.ok).toBe(true);
        if (!read.ok) {
            return;
        }
        const session = read.summary.session;
        expect(session.project).toBe("acme");
        expect(session.branch).toBe("devin/example-feature");
        expect(session.repos["backend"]?.worktree).toBe("worktrees/backend");
        expect(session.repos["backend"]?.pr?.number).toBe(4812);
        const worktree = join(read.summary.path, "worktrees", "backend");
        expect(existsSync(join(worktree, "README.md"))).toBe(true);
        expect(lstatSync(join(worktree, ".spinner")).isSymbolicLink()).toBe(true);
        const branch = await run_ok("git", ["-C", worktree, "branch", "--show-current"]);
        expect(branch.trim()).toBe("devin/example-feature");
        const view = (await (await call("GET", `/sessions/${summary.dir}`)).json()) as {
            session: { summary: SessionSummary };
        };
        expect(view.session.summary.session.repos["backend"]?.worktree).toBe("worktrees/backend");
    });
});
