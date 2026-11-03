// Goal: prove the pipeline routes on a live daemon: `pr` runs as a job and the allow-list
// refusal is the job's error; `post` and `approve` refuse a body without `confirm: true`
// before any job starts; `GET threads` answers from the files; a thread write answers 409
// with the rule's reason. Method: `start_daemon` on a temporary SPINNER_HOME with a fake
// `gh` and a fake writer, plain `fetch` against the bound port.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Job, Session, ThreadsResponse } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { start_daemon, type Daemon } from "../server.js";
import { create_session, write_session } from "../store/session-store.js";
import type { GithubWriter } from "./github-write.js";

let home: SpinnerHome;
let daemon: Daemon;
let base: string;
let writes: string[][];

const writer: GithubWriter = {
    gh: async (args) => {
        writes.push(args);
        return "";
    },
    git: async (_cwd, args) => {
        if (args[0] === "remote") {
            return "https://github.com/acme/backend.git\n";
        }
        if (args[0] === "rev-list") {
            return "2\n";
        }
        return "";
    },
};

beforeEach(async () => {
    writes = [];
    home = resolve_home({ SPINNER_HOME: mkdtempSync(join(tmpdir(), "spinner-routes-")) });
    daemon = await start_daemon({
        home,
        port: 0,
        operator: false,
        log: () => undefined,
        poll_seconds: 0,
        gh: async (args) => (args[1] === "user" ? "owner-1\n" : "{}"),
        writer,
        notify: async () => undefined,
        ui_dir: null,
        observe_interval_ms: 60_000,
        pi: "/bin/false",
    });
    base = `http://127.0.0.1:${daemon.port}`;
});

afterEach(async () => {
    await daemon.close();
    rmSync(home.root, { recursive: true, force: true });
});

function session_dir(): string {
    const created = create_session(home, { title: "Routes" });
    mkdirSync(join(created.path, "worktrees", "backend"), { recursive: true });
    const session: Session = {
        ...created.session,
        repos: { backend: { path: "~/x", worktree: "worktrees/backend", changed: false } },
    };
    write_session({ ...created, session });
    writeFileSync(join(created.path, "MISSION.md"), "# r\n\n## Goal\nG\n\n## Log\n");
    return created.dir;
}

async function post(path: string, body?: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

/** Polls the job until it finished, at most 3 s. */
async function finished(id: string): Promise<Job> {
    for (let i = 0; i < 60; i += 1) {
        const job = ((await (await fetch(`${base}/jobs/${id}`)).json()) as { job: Job }).job;
        if (job.state !== "running") {
            return job;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`job ${id} still running`);
}

describe("pipeline routes", () => {
    it("runs pr as a job and reports the allow-list refusal as its error", async () => {
        const dir = session_dir();
        const response = await post(`/sessions/${dir}/pr`, {});
        expect(response.status).toBe(202);
        const { job } = (await response.json()) as { job: Job };
        expect(job.action).toBe("pr");
        const done = await finished(job.id);
        expect(done.state).toBe("failed");
        expect(done.error).toMatch(/refusing GitHub write to acme\/backend/);
        expect(done.log.some((line) => line.includes("2 commit(s) ahead"))).toBe(true);
        expect(writes).toEqual([]);
    });

    it("rejects a bad pr body and an unknown session", async () => {
        const dir = session_dir();
        expect((await post(`/sessions/${dir}/pr`, { repos: "backend" })).status).toBe(400);
        expect((await post(`/sessions/nope/pr`, {})).status).toBe(404);
    });

    it("refuses post and approve without confirm: true, before any job", async () => {
        const dir = session_dir();
        const no_post = await post(`/sessions/${dir}/post`, { to: "@sam" });
        expect(no_post.status).toBe(400);
        expect(((await no_post.json()) as { error: string }).error).toMatch(/confirm: true/);
        const no_approve = await post(`/sessions/${dir}/approve`, {});
        expect(no_approve.status).toBe(400);
        const jobs = (await (await fetch(`${base}/jobs`)).json()) as { jobs: Job[] };
        expect(jobs.jobs).toEqual([]);
        const preview = await fetch(`${base}/sessions/${dir}/post`);
        expect(preview.status).toBe(200);
        const body = (await preview.json()) as { post: { blocked: string | null } };
        expect(body.post.blocked).toBe("no pipeline.slack.channel configured");
    });

    it("serves threads from the files and answers 409 for a thread it does not know", async () => {
        const dir = session_dir();
        const empty = await fetch(`${base}/sessions/${dir}/threads`);
        expect(empty.status).toBe(200);
        const body = (await empty.json()) as ThreadsResponse;
        expect(body.threads).toEqual({ session: dir, prs: [], rendered: null });
        const reply = await post(`/sessions/${dir}/threads/T1/reply`, { text: "hi" });
        expect(reply.status).toBe(409);
        expect(((await reply.json()) as { error: string }).error).toMatch(/no thread "T1"/);
        const no_text = await post(`/sessions/${dir}/threads/T1/reply`, {});
        expect(no_text.status).toBe(400);
    });

    it("refuses land and reset through their jobs when nothing is ready", async () => {
        const dir = session_dir();
        const land = (await (await post(`/sessions/${dir}/land`, {})).json()) as { job: Job };
        expect((await finished(land.job.id)).error).toBe("no open PR to land");
        const reset = (await (await post(`/sessions/${dir}/reset`, {})).json()) as { job: Job };
        const done = await finished(reset.job.id);
        expect(done.state).toBe("ok");
        const session = (await (await fetch(`${base}/sessions/${dir}`)).json()) as {
            session: { summary: { session: Session } };
        };
        expect(session.session.summary.session.round).toBe(2);
    });

    it("answers a round's Log with 200, a bad round with 400, a missing one with 404", async () => {
        const dir = session_dir();
        const text = [
            "# r\n\n## Goal\nG\n\n## Log\n\n## Previous rounds",
            "### Round 1 · feat/routes · PRs: backend#7 (merged)",
            "- 09:00 lead: began",
            "",
        ].join("\n");
        writeFileSync(join(home.sessions, dir, "MISSION.md"), text);
        const log = await fetch(`${base}/sessions/${dir}/rounds/1/log`);
        expect(log.status).toBe(200);
        expect(log.headers.get("content-type")).toContain("text/markdown");
        expect(await log.text()).toBe("- 09:00 lead: began\n");
        for (const bad of ["0", "x", "201", "1.5"]) {
            const response = await fetch(`${base}/sessions/${dir}/rounds/${bad}/log`);
            expect(response.status, bad).toBe(400);
        }
        expect((await fetch(`${base}/sessions/${dir}/rounds/2/log`)).status).toBe(404);
        expect((await fetch(`${base}/sessions/nope/rounds/1/log`)).status).toBe(404);
        const view = (await (await fetch(`${base}/sessions/${dir}`)).json()) as {
            session: { round: number; rounds: { round: number; source: string }[] };
        };
        expect(view.session.round).toBe(1);
        expect(view.session.rounds).toMatchObject([{ round: 1, source: "mission" }]);
    });
});
