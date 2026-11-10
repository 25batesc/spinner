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
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
    ExtractResponse,
    Job,
    MissionView,
    MissionViewResponse,
    SpinnerEvent,
} from "@spinner/protocol";
import type { Session } from "@spinner/protocol";
import { DESIGN_DEFAULT_TRACK, EGM_ADAPTER_VERSION, EGM_REQUIRED_FILES } from "@spinner/protocol";
import { DesignTracker } from "../egm/design.js";
import { MissionWriter } from "../store/mission-writer.js";
import { EgmFetcher, egm_source_dir, marker_path } from "../egm/fetch.js";
import type { Runner } from "../git/pinned-clone.js";
import { EGM_PIN } from "../egm/pins.js";
import { resolve_home, type SpinnerHome } from "../home.js";
import type { GhRunner, PrResponse } from "../pipeline/github.js";
import { start_daemon, type Daemon } from "../server.js";
import { run_ok } from "../stack/shell.js";
import { create_session, read_session } from "../store/session-store.js";
import { start_lead_session } from "./lead.js";

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
        expect(body.prs[2]?.reason).toBe("no PR #4 in acme/backend");
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
        // The operator's setting reaches the lead's pi at the spawn (agents.github).
        writeFileSync(join(home.root, "settings.yaml"), "theme: system\nagents:\n  github: full\n");
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
        // A session with adopted PRs gets the direct track (D12, 2.23).
        expect(done.log).toContain("track: direct");

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
        expect(session.design?.track).toBe("direct");

        const spawned = JSON.parse(readFileSync(args_file, "utf8")) as {
            cwd: string;
            env: Record<string, string>;
        };
        expect(spawned.env["SPINNER_ROLE"]).toBe("lead");
        expect(spawned.env["SPINNER_GITHUB"]).toBe("full");
        expect(realpathSync(spawned.cwd)).toBe(realpathSync(worktree));
        const brief = readFileSync(join(read.summary.path, "agents", "lead", "BRIEF.md"), "utf8");
        expect(brief).toContain("You own the mission");
        expect(brief).toContain("session_title");
        expect(brief).toContain("Do not post to Slack, approve, land, reset or close");
        expect(brief).toContain("GitHub (push, pull requests, comments, reviews)");
        // The design-track brief (3.13, 3.14): the new step 3 and the Design (EGM) section.
        expect(brief).toContain(
            "3. On the `direct` track, write the Goal with `mission_goal` (one paragraph), the " +
                "Done\n   when list with `mission_done_when`",
        );
        expect(brief).toContain("`mission_plan` (one owner per item; yourself until the work");
        expect(brief).toContain("On the `design`\n   track, skip this step");
        expect(brief).toContain("## Design (EGM)\n1. In your first answer, propose a track");
        expect(brief).toContain("the operator starts each EGM skill. You never start one on");
        expect(brief).toContain("3. Ask each EGM gate that has options with `ask_question`");
        expect(brief).toContain("write only the design doc and the session's files.");
        expect(brief).not.toContain("3. Write the Goal with `mission_goal`");
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

describe("GET /sessions/:dir/mission/view and PUT /sessions/:dir/title", () => {
    it("answers the structured mission, carries it on the event, and sets the title", async () => {
        const started = await call("POST", "/sessions", { title: "Plain" });
        const { job } = (await started.json()) as { job: Job };
        const dir = job.session as string;
        expect((await wait_job(job.id)).state).toBe("ok");
        const written = await call("PUT", `/sessions/${dir}/mission/section`, {
            section: "plan",
            mode: "item",
            text: "",
            author: "lead",
            item: { command: "add", text: "first thing" },
        });
        expect(written.status).toBe(200);
        const changed = events.find((event) => event.type === "mission.changed") as
            | { view?: MissionView }
            | undefined;
        expect(changed?.view?.plan).toEqual([
            {
                id: 1,
                text: "first thing",
                owner: "lead",
                entry: null,
                state: "next",
                ticked_at: null,
            },
        ]);
        const response = await call("GET", `/sessions/${dir}/mission/view`);
        expect(response.status).toBe(200);
        const { view } = (await response.json()) as MissionViewResponse;
        expect(view.title).toBe("Plain");
        expect(view.plan[0]?.text).toBe("first thing");
        expect(view.log[0]?.text).toBe("session created");

        const titled = await call("PUT", `/sessions/${dir}/title?author=lead`, {
            title: "Refunds, end to end",
        });
        expect(titled.status).toBe(200);
        const body = (await titled.json()) as {
            session: { summary: { session: { title: string } } };
        };
        expect(body.session.summary.session.title).toBe("Refunds, end to end");
        const mission = readFileSync(join(home.sessions, dir, "MISSION.md"), "utf8");
        expect(mission.split("\n")[0]).toMatch(/^# s\d+ \u00b7 Refunds, end to end$/);
        const again = await call("GET", `/sessions/${dir}/mission/view`);
        const after = (await again.json()) as MissionViewResponse;
        expect(after.view.title).toBe("Refunds, end to end");
        expect(after.view.plan).toHaveLength(1);
        const bad = await call("PUT", `/sessions/${dir}/title`, { title: "" });
        expect(bad.status).toBe(400);
        expect((await call("GET", "/sessions/nope/mission/view")).status).toBe(404);
    });

    // Dogfood #27: an operator's rename pins the title against the lead until he unpins it,
    // and every change writes a Log line by its author.
    it("pins the operator's title, refuses the lead's while pinned, logs each change", async () => {
        const started = await call("POST", "/sessions", { title: "Plain" });
        const { job } = (await started.json()) as { job: Job };
        const dir = job.session as string;
        expect((await wait_job(job.id)).state).toBe("ok");
        const put = (body: unknown, author?: string): Promise<Response> => {
            const query = author === undefined ? "" : `?author=${author}`;
            return call("PUT", `/sessions/${dir}/title${query}`, body);
        };
        const yaml = (): { title: string; title_pinned?: boolean } =>
            parse(readFileSync(join(home.sessions, dir, "session.yaml"), "utf8")) as {
                title: string;
                title_pinned?: boolean;
            };
        const log = (): string[] =>
            readFileSync(join(home.sessions, dir, "MISSION.md"), "utf8")
                .split("\n")
                .filter((line) => / title: /.test(line));

        expect((await put({ title: "Refunds" }, "lead")).status).toBe(200);
        expect(yaml().title_pinned).toBeUndefined();
        expect((await put({ title: "Refund flow" })).status).toBe(200);
        expect(yaml()).toMatchObject({ title: "Refund flow", title_pinned: true });
        const refused = await put({ title: "Something else" }, "lead");
        expect(refused.status).toBe(409);
        expect(((await refused.json()) as { error: string }).error).toMatch(/pinned the title/);
        expect((await put({ pinned: false }, "lead")).status).toBe(400);
        expect(yaml().title).toBe("Refund flow");
        expect((await put({ pinned: false })).status).toBe(200);
        expect(yaml()).toEqual(expect.not.objectContaining({ title_pinned: expect.anything() }));
        expect((await put({ title: "Refunds, round 2" }, "lead")).status).toBe(200);
        expect((await put({ title: "Refunds, round 2" }, "lead")).status).toBe(200);
        expect((await put({})).status).toBe(400);
        expect(log().map((line) => line.replace(/^- \d\d:\d\d /, ""))).toEqual([
            "lead: title: Refunds (was Plain)",
            "operator: title: Refund flow (was Refunds)",
            "lead: title: Refunds, round 2 (was Refund flow)",
        ]);
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

describe("the EGM step of a lead start", () => {
    /** A pi agent dir whose settings list pi-subagents, or list nothing. */
    function pi_env(installed: boolean): NodeJS.ProcessEnv {
        const dir = mkdtempSync(join(root, "pi-"));
        const packages = installed ? ["npm:pi-subagents"] : [];
        writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages }));
        return { PI_CODING_AGENT_DIR: dir };
    }

    const failing: Runner = () =>
        Promise.resolve({ code: 128, stdout: "", stderr: "network down" });

    let last: Session | null = null;

    /** Starts a lead; with `design`, the tracker and the writer join the deps (2.23). */
    async function start(egm: EgmFetcher | undefined, design = false): Promise<string[]> {
        const summary = create_session(home, { title: "Egm lead", lead: true });
        const lines: string[] = [];
        const writer = new MissionWriter(home, daemon.bus);
        const tracker = new DesignTracker({
            home,
            cwd: root,
            agents: daemon.agents,
            bus: daemon.bus,
            writer,
            refresh: async () => undefined,
            log: () => undefined,
        });
        const deps = {
            home,
            ctx: { home, cwd: root, gh },
            agents: daemon.agents,
            ...(egm === undefined ? {} : { egm }),
            ...(design ? { design: tracker, writer } : {}),
        };
        try {
            const started = await start_lead_session(
                deps,
                summary,
                { text: "Add a flag" },
                (line) => lines.push(line),
            );
            expect(started.session.agents?.["lead"]?.process).toBe("idle");
            last = started.session;
        } finally {
            await tracker.close();
        }
        await daemon.agents.stop(summary.dir, "lead");
        return lines;
    }

    function fetched_home(): void {
        for (const file of EGM_REQUIRED_FILES) {
            const path = join(egm_source_dir(home), file);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, "x\n");
        }
        const marker = { sha: EGM_PIN.sha, adapter_version: EGM_ADAPTER_VERSION, fetched: "x" };
        writeFileSync(marker_path(home), JSON.stringify(marker));
    }

    it("starts the lead and logs the reason when the fetch fails", async () => {
        const lines = await start(new EgmFetcher(home, pi_env(true), failing));
        expect(lines).toContain(`fetching EGM ${EGM_PIN.sha.slice(0, 12)}`);
        const reason = lines.find((line) => line.startsWith("EGM unavailable: "));
        expect(reason).toMatch(/network down[\s\S]*; the lead starts without it$/);
        expect(lines.some((line) => line.startsWith("lead started"))).toBe(true);
    });

    it("skips the fetch without pi-subagents and logs the reason", async () => {
        const lines = await start(new EgmFetcher(home, pi_env(false), failing));
        expect(lines).toContain(
            "EGM unavailable: pi-subagents is not in the pi settings; the lead starts without it",
        );
        expect(lines.some((line) => line.startsWith("fetching EGM"))).toBe(false);
    });

    it("skips the fetch on a fetched home", async () => {
        fetched_home();
        const lines = await start(new EgmFetcher(home, pi_env(true), failing));
        expect(lines.filter((line) => line.includes("EGM"))).toEqual([]);
    });

    it("gives a ready EGM the design track (2.23, 3.1, 3.14)", async () => {
        expect(DESIGN_DEFAULT_TRACK).toBe("design");
        fetched_home();
        const lines = await start(new EgmFetcher(home, pi_env(true), failing), true);
        expect(lines).toContain("track: design");
        expect(last?.design?.track).toBe("design");
    });

    it("gives a failed fetch the direct track", async () => {
        const lines = await start(new EgmFetcher(home, pi_env(true), failing), true);
        expect(lines).toContain("track: direct");
        expect(last?.design?.track).toBe("direct");
    });

    it("writes no design block without the tracker in the deps", async () => {
        fetched_home();
        const lines = await start(new EgmFetcher(home, pi_env(true), failing));
        expect(lines.some((line) => line.startsWith("track:"))).toBe(false);
        expect(last?.design).toBeUndefined();
    });

    it("logs no EGM line without a fetcher", async () => {
        const lines = await start(undefined);
        expect(lines.filter((line) => line.includes("EGM"))).toEqual([]);
        expect(lines.some((line) => line.startsWith("lead started"))).toBe(true);
    });
});
