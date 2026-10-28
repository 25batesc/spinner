// Goal: prove the whole loop of s005 Done-when through the daemon's routes with no GitHub and
// no Slack: new session with a worktree → pr (push + create, stage fixing on the fixture's
// bot threads) → threads: reply, flag, resolve → verify → post (fixture Slack) → approve
// → land (enqueue with the head, merged on the fixture's second look) → reset (round 2). Method:
// `start_daemon` with `github_fixture` on a scratch directory holding `loop/default.json`,
// a session spec copy that allow-lists `acme/fixture`, and plain `fetch`.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
    ApproveResponse,
    Job,
    PostResponse,
    Session,
    SessionResponse,
    ThreadResponse,
    ThreadsResponse,
} from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { start_daemon, type Daemon } from "../server.js";
import { SESSION_SPEC } from "../stack/runner.js";
import { create_session, write_session } from "../store/session-store.js";
import { github_fixture } from "./github-fixture.js";

const here = dirname(fileURLToPath(import.meta.url));
const LOOP_FIXTURE = resolve(here, "..", "..", "test", "fixtures", "github", "loop");

const SPEC = [
    "name: loop",
    "base: develop",
    "repos:",
    "  backend: { path: ~/code/backend }",
    "services: {}",
    "pipeline:",
    "  github:",
    '    bot_logins: ["devin-ai-integration[bot]"]',
    "    write_repos: [acme/backend]",
    "    merge_queue: github",
    "  threads: { resolve_human: false }",
    "  slack: { channel: C0LOOP }",
    "",
].join("\n");

let home: SpinnerHome;
let daemon: Daemon;
let base: string;
let fixture_dir: string;

beforeEach(async () => {
    home = resolve_home({ SPINNER_HOME: mkdtempSync(join(tmpdir(), "spinner-loop-")) });
    fixture_dir = mkdtempSync(join(tmpdir(), "spinner-loop-gh-"));
    copyFileSync(join(LOOP_FIXTURE, "default.json"), join(fixture_dir, "default.json"));
    const fixture = github_fixture(fixture_dir);
    daemon = await start_daemon({
        home,
        port: 0,
        log: () => undefined,
        poll_seconds: 0,
        gh: fixture.gh,
        writer: fixture.writer,
        notify: async () => undefined,
        ui_dir: null,
        observe_interval_ms: 60_000,
        pi: "/bin/false",
        land_poll_ms: 5,
    });
    base = `http://127.0.0.1:${daemon.port}`;
});

afterEach(async () => {
    await daemon.close();
    rmSync(home.root, { recursive: true, force: true });
});

function session_dir(): string {
    const created = create_session(home, { title: "Loop" });
    const worktree = join(created.path, "worktrees", "backend");
    mkdirSync(worktree, { recursive: true });
    // `verify` reads each worktree's HEAD with real git; the fixture fakes every other call.
    execFileSync("git", ["-C", worktree, "init", "-q", "-b", "feat/loop"]);
    const identity = ["-c", "user.email=t@t", "-c", "user.name=t"];
    execFileSync("git", ["-C", worktree, ...identity, "commit", "-q", "--allow-empty", "-m", "i"]);
    mkdirSync(join(created.path, "stack"), { recursive: true });
    writeFileSync(join(created.path, SESSION_SPEC), SPEC);
    const session: Session = {
        ...created.session,
        base: "develop",
        project: "loop",
        repos: {
            backend: { path: "~/code/backend", worktree: "worktrees/backend", changed: true },
        },
    };
    write_session({ ...created, session });
    writeFileSync(join(created.path, "MISSION.md"), "# loop\n\n## Goal\nShip it.\n\n## Log\n");
    return created.dir;
}

async function post(path: string, body?: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const JOB_POLL_MS = 50;
const JOB_POLLS_MAX = 600;

async function job(path: string, body?: unknown): Promise<Job> {
    const response = await post(path, body);
    expect(response.status).toBe(202);
    const { job: started } = (await response.json()) as { job: Job };
    // A reset runs git fetch, branch and worktree moves; a CI runner needs well over 3 s.
    for (let i = 0; i < JOB_POLLS_MAX; i += 1) {
        const current = ((await (await fetch(`${base}/jobs/${started.id}`)).json()) as { job: Job })
            .job;
        if (current.state !== "running") {
            return current;
        }
        await new Promise((r) => setTimeout(r, JOB_POLL_MS));
    }
    throw new Error(`job ${started.id} still running after ${JOB_POLLS_MAX * JOB_POLL_MS} ms`);
}

async function get(path: string): Promise<unknown> {
    return (await fetch(`${base}${path}`)).json();
}

async function session(dir: string): Promise<Session> {
    const body = (await (await fetch(`${base}/sessions/${dir}`)).json()) as SessionResponse;
    return body.session.summary.session;
}

describe("the loop on fixtures", () => {
    it("runs pr → threads → verify → post → approve → land → reset", async () => {
        const dir = session_dir();

        const pr = await job(`/sessions/${dir}/pr`, {});
        expect(pr.error).toBeNull();
        let current = await session(dir);
        expect(current.repos["backend"]?.pr?.number).toBe(100);
        expect(current.stage).toBe("fixing");

        const threads = (await get(`/sessions/${dir}/threads`)) as ThreadsResponse;
        expect(threads.threads.prs[0]?.open_bot).toBe(2);
        const [t1, t2] = threads.threads.prs[0]?.threads ?? [];
        expect(t1?.label).toBe("T1");

        const early = await post(`/sessions/${dir}/threads/T1/resolve`);
        expect(early.status).toBe(409);
        const replied = await post(`/sessions/${dir}/threads/${t1?.id ?? ""}/reply`, {
            text: "Fixed in the next push.",
        });
        expect(replied.status).toBe(200);
        expect(((await replied.json()) as ThreadResponse).thread.replied).toBe(true);
        const resolved = await post(`/sessions/${dir}/threads/T1/resolve`);
        expect(resolved.status).toBe(200);
        const flagged = await post(`/sessions/${dir}/threads/${t2?.id ?? ""}/flag`, {
            reason: "design question",
        });
        expect(flagged.status).toBe(200);
        current = await session(dir);
        expect(current.needs_human).toBe("1 thread flagged on backend#100");
        await post(`/sessions/${dir}/threads/T2/reply`, { text: "Keeping it; see flag." });
        expect((await post(`/sessions/${dir}/threads/T2/resolve`)).status).toBe(200);
        current = await session(dir);
        expect(current.stage).toBe("verifying");

        expect((await job(`/sessions/${dir}/verify`, {})).error).toBeNull();
        const preview = (await get(`/sessions/${dir}/post`)) as PostResponse;
        expect(preview.post.blocked).toBeNull();
        expect(preview.post.transport).toBe("fixture");
        expect(preview.post.text).toContain("Ship it.");
        expect((await job(`/sessions/${dir}/post`, { confirm: true })).error).toBeNull();
        current = await session(dir);
        expect(current.pipeline?.slack_post).toMatch(/^https:\/\/fixture.slack.invalid\//);
        expect(current.stage).toBe("peer-review");

        const approve = (await get(`/sessions/${dir}/approve`)) as ApproveResponse;
        expect(approve.approve.prs[0]?.blocked).toBeNull();
        expect(approve.approve.prs[0]?.open_threads).toBe(0);
        expect((await job(`/sessions/${dir}/approve`, { confirm: true })).error).toBeNull();
        current = await session(dir);
        const head = current.repos["backend"]?.pr?.head;
        expect(current.pipeline?.approved_heads?.["backend"]).toBe(head);
        expect(current.repos["backend"]?.pr?.approvals.owner).toBe(true);

        const land = await job(`/sessions/${dir}/land`, {});
        expect(land.error).toBeNull();
        expect(land.log.some((line) => line.includes("enqueuing at"))).toBe(true);
        current = await session(dir);
        expect(current.repos["backend"]?.pr?.state).toBe("merged");
        expect(current.stage).toBe("merged");

        const reset = await job(`/sessions/${dir}/reset`, {});
        expect(reset.error).toBeNull();
        current = await session(dir);
        expect(current.round).toBe(2);
        expect(current.stage).toBe("planned");
        const writes = readFileSync(join(fixture_dir, "writes.log"), "utf8");
        expect(writes).toMatch(/git -C .* push --set-upstream origin/);
        expect(writes).toMatch(/gh pr create --repo acme\/backend/);
        expect(writes).toMatch(/gh pr review .* --approve/);
        expect(writes).toMatch(/enqueuePullRequest/);
    }, 20_000);
});
