// Goal: the EGM routes answer as docs/designs/egm-adoption.md, entries 2.24, 2.25, 3.9 and
// 3.12 say: `PUT …/design/track` with 200, 400 and both 409s, `PUT …/design/doc` with 200,
// one 400 per refusal kind and the 409s, `GET /egm` with a status, and the gate, answer and
// run routes with their 200, 400 and 409 paths, the composed `/skill:` text of each row of
// the T9 table, the review-run archive, and `session.needs_human` read back from
// `session.yaml`. Method: `create_app` on a scratch home with real collaborators (the job
// runner, the mission writer, the design tracker, the view builder), one session made by
// `create_session` whose `web` worktree is a real clone of a bare origin, and an
// `EgmFetcher` over a scratch pi agent dir. The lead's pi process is the one seam: an
// `AgentManager` whose `get` answers a recording handle for `lead` while the test says it
// runs, so a test reads the exact text that would reach pi. Build sessions 4 and 5 (4.9,
// 5.3, 5.4): the Goldfish events route and the live cap read real `status.json` files
// through a real `GoldfishWatcher` and `CostLedger`; the workspace routes read real files
// under `<session>/design/` and the doc in the worktree. Build session 6 (6.2, 6.3, 6.6,
// 6.7): approval through the routes on the real doc in the worktree, with the lead's notices
// recorded at `notify_all`, the manager's seam for the design-change notice.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
    AgentCommandResponse,
    EgmResponse,
    SessionResponse,
    SessionSummary,
} from "@spinner/protocol";
import type {
    AgentEventsResponse,
    DesignApproveRefusal,
    DesignApproveResponse,
    DesignChangesResponse,
    DesignFilesResponse,
} from "@spinner/protocol";
import { EGM_ADAPTER_VERSION, EGM_REQUIRED_FILES, GOLDFISH_LIVE_MAX } from "@spinner/protocol";
import { CostLedger } from "../costs/ledger.js";
import type { AgentHandle } from "../agents/harness.js";
import { AgentManager } from "../agents/manager.js";
import { PiRpcHarness } from "../agents/harness.js";
import { EventBus } from "../event-bus.js";
import { resolve_home, type SpinnerHome } from "../home.js";
import { JobRunner } from "../jobs/jobs.js";
import { mission_view } from "../pipeline/mission-sections.js";
import { create_app } from "../server.js";
import { run_ok } from "../stack/shell.js";
import { MissionWriter } from "../store/mission-writer.js";
import { create_session, read_session, write_session } from "../store/session-store.js";
import { build_session_view } from "../views/session-view.js";
import { DesignTracker } from "./design.js";
import { normalized_doc_hash } from "./derive-design.js";
import { EgmFetcher, egm_source_dir, marker_path } from "./fetch.js";
import { GoldfishWatcher } from "./goldfish.js";
import { EGM_PIN } from "./pins.js";

const DOC_TEXT = [
    "# CSV",
    "",
    "## Overview",
    "",
    "Rows.",
    "",
    "## Detailed Implementation Plan",
    "",
    "#### Build session 1: the engine",
    "",
    "##### 1.1 `src/a.ts` (Create)",
    "",
    "##### 1.2 `src/b.ts` (Modify) **[D7]**",
    "",
].join("\n");

let root: string;
let home: SpinnerHome;
let summary: SessionSummary;
let designs: string;
let tracker: DesignTracker;
let agents: RecordingAgents;
let goldfish: GoldfishWatcher;
let ledger: CostLedger;

/** The lead's pi, recorded: every prompt and steer, in order, while `running` is true. */
class RecordingAgents extends AgentManager {
    running_lead = true;
    sent: string[] = [];
    /** The texts of `notify_all` with the steer fallback: the design-change notice (6.6). */
    notices: string[] = [];

    override async notify_all(
        dir: string,
        text: string,
        options: { steer_fallback: boolean } = { steer_fallback: false },
    ): Promise<string[]> {
        if (options.steer_fallback) {
            this.notices.push(text);
        }
        return super.notify_all(dir, text, options);
    }

    override get(dir: string, name: string): AgentHandle | null {
        if (name !== "lead" || !this.running_lead) {
            return super.get(dir, name);
        }
        const record = async (text: string): Promise<string> => {
            this.sent.push(text);
            return "started";
        };
        return {
            pid: 1,
            pi_session_id: "lead",
            prompt: record,
            steer: record,
            abort: async () => undefined,
            commands: async () => [],
            on_event: () => () => undefined,
            exited: new Promise(() => undefined),
            stop: async () => 0,
        };
    }
}

beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "spinner-egm-routes-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home") });
    summary = create_session(home, { title: "CSV export" });
    const worktree = join(summary.path, "worktrees", "web");
    designs = join(worktree, "docs", "designs");
    const seed = join(root, "seed");
    await run_ok("git", ["init", "--quiet", "--initial-branch", "main", seed]);
    await run_ok("git", ["-C", seed, "config", "user.email", "t@example.com"]);
    await run_ok("git", ["-C", seed, "config", "user.name", "t"]);
    mkdirSync(join(seed, "docs", "designs"), { recursive: true });
    writeFileSync(join(seed, "docs", "designs", "landed.md"), DOC_TEXT);
    await run_ok("git", ["-C", seed, "add", "."]);
    await run_ok("git", ["-C", seed, "commit", "--quiet", "-m", "init"]);
    await run_ok("git", ["clone", "--quiet", "--bare", seed, join(root, "origin.git")]);
    await run_ok("git", ["clone", "--quiet", join(root, "origin.git"), worktree]);
    summary.session.base = "main";
    summary.session.repos = { web: { path: worktree, worktree: "worktrees/web", changed: false } };
    write_session(summary);
});

afterEach(async () => {
    goldfish.close();
    await tracker.close();
    rmSync(root, { recursive: true, force: true });
});

/** An app whose EGM is ready with pi-subagents, or absent (never fetched). */
function app_with(egm_ready: boolean): Hono {
    const pi_dir = mkdtempSync(join(root, "pi-"));
    const settings = { packages: ["npm:pi-subagents"] };
    writeFileSync(join(pi_dir, "settings.json"), JSON.stringify(settings));
    if (egm_ready) {
        for (const file of EGM_REQUIRED_FILES) {
            const path = join(egm_source_dir(home), file);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, "x\n");
        }
        const marker = { sha: EGM_PIN.sha, adapter_version: EGM_ADAPTER_VERSION, fetched: "x" };
        writeFileSync(marker_path(home), JSON.stringify(marker));
    }
    const bus = new EventBus();
    const rpc = new PiRpcHarness({ pi: () => "pi-is-not-started-here", extension: null });
    agents = new RecordingAgents(home, { default: "rpc", rpc }, bus);
    const writer = new MissionWriter(home, bus);
    const log = (): void => undefined;
    const refresh = async (): Promise<void> => undefined;
    goldfish = new GoldfishWatcher({ home, agents, bus, log, on_change: refresh });
    ledger = new CostLedger(home);
    tracker = new DesignTracker({
        home,
        cwd: root,
        agents,
        bus,
        writer,
        refresh,
        log,
        goldfish,
        cost: (dir) => ledger.session_cost(dir),
    });
    const design = tracker;
    const ctx = { home, cwd: root, gh: async () => "" };
    const view_ctx = {
        home,
        cwd: root,
        observation: () => null,
        agents_running: () => [],
        design: (entry: SessionSummary) => design.view(entry),
        now: () => new Date(),
        log,
    };
    return create_app({
        home,
        started: new Date().toISOString(),
        build: { version: "0.0.0", commit: null, built: null },
        log,
        ctx,
        jobs: new JobRunner(bus),
        view: (entry) => build_session_view(view_ctx, entry),
        refresh,
        ui_dir: null,
        ui_commit: null,
        agents,
        models: async () => [],
        bus,
        writer,
        egm: new EgmFetcher(home, { PI_CODING_AGENT_DIR: pi_dir }),
        design,
        goldfish,
    });
}

async function put(app: Hono, route: string, body: unknown): Promise<Response> {
    return app.request(`/sessions/${summary.dir}/design/${route}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

async function error_of(response: Response): Promise<string> {
    return ((await response.json()) as { error: string }).error;
}

function patch_session(patch: (session: SessionSummary["session"]) => void): void {
    const read = read_session(home, summary.dir);
    if (!read.ok) {
        throw new Error(read.error);
    }
    patch(read.summary.session);
    write_session(read.summary);
}

describe("PUT /sessions/:dir/design/track", () => {
    it("sets design with EGM ready: the view, the Goal pointer, the Done when item", async () => {
        const app = app_with(true);
        const response = await put(app, "track", { track: "design" });
        expect(response.status).toBe(200);
        const body = (await response.json()) as SessionResponse;
        expect(body.session.design).toMatchObject({ track: "design", stage: "intake" });
        const mission = readFileSync(join(summary.path, "MISSION.md"), "utf8");
        expect(mission).toContain("Spinner names it here once the lead calls design_doc.");
        expect(mission).toContain("- [ ] The design is approved and every Plan item is ticked.");
    });

    it("answers 400 for an unknown track", async () => {
        const response = await put(app_with(true), "track", { track: "sideways" });
        expect(response.status).toBe(400);
        expect(await error_of(response)).toBe("track must be one of design, direct");
    });

    it("answers 409 for design when EGM is not available", async () => {
        const response = await put(app_with(false), "track", { track: "design" });
        expect(response.status).toBe(409);
        expect(await error_of(response)).toBe("EGM is not available: absent");
    });

    it("answers 409 once a repo has commits", async () => {
        const app = app_with(true);
        expect((await put(app, "track", { track: "direct" })).status).toBe(200);
        patch_session((session) => {
            const web = session.repos["web"];
            if (web !== undefined) {
                web.changed = true;
            }
        });
        const response = await put(app, "track", { track: "design" });
        expect(response.status).toBe(409);
        expect(await error_of(response)).toBe("the build has started; the track is fixed");
    });
});

describe("PUT /sessions/:dir/design/doc", () => {
    it("names a new doc with 200 and refuses each kind of path with 400", async () => {
        const app = app_with(true);
        expect((await put(app, "track", { track: "design" })).status).toBe(200);
        writeFileSync(join(designs, "README.md"), DOC_TEXT);
        writeFileSync(join(designs, "brief.md"), "# Brief\n\n## Overview\n");
        writeFileSync(join(designs, "..", "x.md"), DOC_TEXT);
        const refusals: [string, string | RegExp][] = [
            ["docs/designs/a.md", "the path must be absolute"],
            [join(designs, "..", "x.md"), /directly in/],
            [join(designs, "README.md"), "SITEMAP.md and README.md are not design docs"],
            [join(designs, "none.md"), /^no file at /],
            [join(designs, "brief.md"), /this file lacks ## Detailed Implementation Plan$/],
            [join(designs, "landed.md"), /already exists on origin\/main/],
        ];
        for (const [path, message] of refusals) {
            const response = await put(app, "doc", { path });
            expect(response.status, path).toBe(400);
            expect(await error_of(response)).toMatch(message);
        }
        writeFileSync(join(designs, "csv.md"), DOC_TEXT);
        const named = await put(app, "doc", { path: join(designs, "csv.md") });
        expect(named.status).toBe(200);
        const body = (await named.json()) as SessionResponse;
        expect(body.session.design).toMatchObject({ doc: "docs/designs/csv.md", stage: "drafted" });
        // The ui's prefills (3.19, the ui agent's request): the doc's repo, the designs dir.
        expect(body.session.design).toMatchObject({ repo: "web", designs_dir: designs });
        expect(body.session.summary.session.needs_human).toBe("review the design");
    });

    it("answers 409 off the design track and while an approval stands", async () => {
        const app = app_with(true);
        expect((await put(app, "track", { track: "direct" })).status).toBe(200);
        writeFileSync(join(designs, "csv.md"), DOC_TEXT);
        const direct = await put(app, "doc", { path: join(designs, "csv.md") });
        expect(direct.status).toBe(409);
        expect(await error_of(direct)).toBe("this session is not on the design track");
        const approved = {
            path: "docs/designs/csv.md",
            repo: "web",
            sha256: normalized_doc_hash(DOC_TEXT),
            at: "2026-11-04T11:40:00Z",
            blockers: 0,
            round: 1,
        };
        patch_session((session) => {
            session.design = { track: "design", doc: "docs/designs/csv.md", repo: "web", approved };
        });
        const locked = await put(app, "doc", { path: join(designs, "csv.md") });
        expect(locked.status).toBe(409);
        expect(await error_of(locked)).toBe("the design is approved; clear the approval first");
    });
});

describe("GET /egm", () => {
    it("returns the fetch status", async () => {
        const response = await app_with(true).request("/egm");
        expect(response.status).toBe(200);
        const body = (await response.json()) as EgmResponse;
        expect(body.egm).toMatchObject({ state: "ready", subagents: true });
    });
});

async function post(app: Hono, route: string, body: unknown): Promise<Response> {
    return app.request(`/sessions/${summary.dir}/design/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

function stored(): SessionSummary["session"] {
    const read = read_session(home, summary.dir);
    if (!read.ok) {
        throw new Error(read.error);
    }
    return read.summary.session;
}

/** A design-track app whose lead runs and whose `csv.md` is the named design doc. */
async function named_app(): Promise<Hono> {
    const app = app_with(true);
    expect((await put(app, "track", { track: "design" })).status).toBe(200);
    writeFileSync(join(designs, "csv.md"), DOC_TEXT);
    expect((await put(app, "doc", { path: join(designs, "csv.md") })).status).toBe(200);
    return app;
}

const GATE = {
    question: `Anchored feature hypothesis: ${"CSV export of the orders page. ".repeat(4)}Proceed?`,
    options: ["Review with Goldfishes", "Clarify additional constraints or assumptions in chat"],
};

describe("PUT /sessions/:dir/design/gate and POST …/design/answer (3.9)", () => {
    it("writes the gate and needs_human; an answer clears it and prompts the lead", async () => {
        const app = await named_app();
        const response = await put(app, "gate", GATE);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
        const gated = stored();
        expect(gated.design?.gate).toMatchObject(GATE);
        const needs = `answer the lead: ${GATE.question.slice(0, 80)}`;
        expect(gated.design?.needs).toBe(needs);
        expect(gated.needs_human).toBe(needs);

        const answered = await post(app, "answer", { text: GATE.options[0] });
        expect(answered.status).toBe(200);
        const body = (await answered.json()) as AgentCommandResponse;
        expect(body).toEqual({ ok: true, disposition: "started" });
        expect(agents.sent).toEqual([GATE.options[0]]);
        const after = stored();
        expect(after.design?.gate).toBeUndefined();
        // The next line of the list: stage drafted asks for the review.
        expect(after.needs_human).toBe("review the design");
    });

    it("answers 400 for a bad gate and a bad answer", async () => {
        const app = await named_app();
        const gates: [unknown, RegExp][] = [
            [{ question: "Q?" }, /question, options/],
            [{ question: "Q?", options: ["a", 1] }, /question, options/],
            [{ ...GATE, question: " " }, /question must not be empty/],
            [{ ...GATE, question: "Q".repeat(2001) }, /at most 2000/],
            [{ ...GATE, options: ["a"] }, /2 to 6 items/],
            [{ ...GATE, options: ["1", "2", "3", "4", "5", "6", "7"] }, /2 to 6 items/],
            [{ ...GATE, options: ["a", "b".repeat(301)] }, /options\[1\] must be at most 300/],
        ];
        for (const [body, fault] of gates) {
            const response = await put(app, "gate", body);
            expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(400);
            expect(await error_of(response)).toMatch(fault);
        }
        expect(stored().design?.gate).toBeUndefined();
        for (const text of ["", "  ", "x".repeat(4001)]) {
            expect((await post(app, "answer", { text })).status).toBe(400);
        }
        expect(agents.sent).toEqual([]);
    });

    it("answers 409 for a stopped lead and keeps the gate", async () => {
        const app = await named_app();
        expect((await put(app, "gate", GATE)).status).toBe(200);
        agents.running_lead = false;
        const response = await post(app, "answer", { text: "Review with Goldfishes" });
        expect(response.status).toBe(409);
        expect(await error_of(response)).toBe("the lead is not running; resume it from its tab");
        expect(stored().design?.gate).toMatchObject(GATE);
        const run = await post(app, "run", { skill: "egm-draft" });
        expect(run.status).toBe(409);
        expect(stored().design?.gate).toMatchObject(GATE);
    });

    it("keeps an open gate as needs_human for an approved design during the build", async () => {
        const app = await named_app();
        const sha256 = normalized_doc_hash(DOC_TEXT);
        patch_session((session) => {
            const approved = {
                path: "docs/designs/csv.md",
                repo: "web",
                sha256,
                at: "2026-11-04T11:40:00Z",
                blockers: 0,
                round: 1,
            };
            session.design = { ...session.design!, approved };
        });
        expect((await put(app, "gate", GATE)).status).toBe(200);
        const build = stored();
        expect(build.design?.stage).toBe("approved");
        expect(build.needs_human).toBe(`answer the lead: ${GATE.question.slice(0, 80)}`);
    });

    it("clears the gate on a prompt or a steer through the agents route (3.10)", async () => {
        const app = await named_app();
        for (const command of ["prompt", "steer"]) {
            expect((await put(app, "gate", GATE)).status).toBe(200);
            const response = await app.request(
                `/sessions/${summary.dir}/agents/lead/${command}`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ text: `typed ${command}` }),
                },
            );
            expect(response.status, command).toBe(200);
            expect(stored().design?.gate, command).toBeUndefined();
            expect(stored().needs_human).toBe("review the design");
        }
        expect(agents.sent).toEqual(["typed prompt", "typed steer"]);
    });

    it("sets needs_human to resolve the review findings at stage resolving", async () => {
        const app = await named_app();
        mkdirSync(join(summary.path, "design"), { recursive: true });
        writeFileSync(join(summary.path, "design", "goldfish_review_report.md"), "# Report\n");
        await tracker.refresh(summary.dir);
        const resolving = stored();
        expect(resolving.design?.stage).toBe("resolving");
        expect(resolving.needs_human).toBe("resolve the review findings");
        const answered = await post(app, "answer", { text: "Auto accept" });
        expect(answered.status).toBe(200);
        expect(agents.sent).toEqual(["Auto accept"]);
    });
});

describe("POST /sessions/:dir/design/run (3.9)", () => {
    it("composes the /skill: text for each row of the T9 table", async () => {
        const app = await named_app();
        const doc = join(designs, "csv.md");
        const brief = join(summary.path, "design", "concepts_brief.md");
        const runs: [unknown, string][] = [
            [{ skill: "egm-brainstorm" }, "/skill:egm-brainstorm"],
            [
                { skill: "egm-brainstorm", args: "CSV export for orders" },
                "/skill:egm-brainstorm CSV export for orders",
            ],
            [
                { skill: "egm-draft" },
                `/skill:egm-draft Context File: ${brief}. Target directory: ${designs}.`,
            ],
            [
                { skill: "egm-review", preset: "uninterrupted" },
                `/skill:egm-review ${doc} Step: uninterrupted GoldfishContext: none`,
            ],
            [{ skill: "egm-review-loop", args: doc }, `/skill:egm-review-loop ${doc}`],
            [{ skill: "egm-resolve" }, `/skill:egm-resolve ${doc}`],
            [{ skill: "egm-drift-report" }, `/skill:egm-drift-report ${designs}`],
            [{ skill: "egm-bootstrap" }, `/skill:egm-bootstrap path: ${join(designs, "..", "..")}`],
        ];
        for (const [body, text] of runs) {
            const response = await post(app, "run", body);
            expect(response.status, JSON.stringify(body)).toBe(200);
            expect(agents.sent.at(-1)).toBe(text);
        }
        // The drift report names the landed PRs of the earlier rounds.
        patch_session((session) => {
            const pr = (number: number, state: "merged" | "closed") => ({
                repo: "web",
                number,
                url: null,
                state,
                merged_at: null,
            });
            session.rounds = [
                { round: 1, branch: "b", prs: [pr(41, "merged")], started: null, ended: null },
                { round: 2, branch: "b-r2", prs: [pr(50, "closed")], started: null, ended: null },
                { round: 3, branch: "b-r3", prs: [pr(57, "merged")], started: null, ended: null },
            ];
        });
        expect((await post(app, "run", { skill: "egm-drift-report" })).status).toBe(200);
        expect(agents.sent.at(-1)).toBe(
            `/skill:egm-drift-report ${designs} Landed rounds: r1 web#41, r3 web#57.`,
        );
    });

    it("clears an open gate when a skill starts", async () => {
        const app = await named_app();
        expect((await put(app, "gate", GATE)).status).toBe(200);
        expect((await post(app, "run", { skill: "egm-resolve" })).status).toBe(200);
        expect(stored().design?.gate).toBeUndefined();
    });

    it("answers 400 and 409 with the reason", async () => {
        const app = app_with(true);
        expect((await put(app, "track", { track: "design" })).status).toBe(200);
        const bad: [unknown, RegExp][] = [
            [{ skill: "egm-nothing" }, /skill must be one of egm-brainstorm/],
            [{ skill: "egm-draft", preset: "uninterrupted" }, /preset goes only with egm-review/],
            [{ skill: "egm-review", preset: "fast" }, /preset must be one of interactive/],
            [{ skill: "egm-brainstorm", args: "x".repeat(4001) }, /at most 4000/],
            [{ skill: "egm-brainstorm", args: 3 }, /args must be a string/],
        ];
        for (const [body, fault] of bad) {
            const response = await post(app, "run", body);
            expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(400);
            expect(await error_of(response)).toMatch(fault);
        }
        const no_doc = await post(app, "run", { skill: "egm-review", preset: "uninterrupted" });
        expect(no_doc.status).toBe(409);
        expect(await error_of(no_doc)).toBe("no design doc yet");
        patch_session((session) => {
            const web = session.repos["web"];
            if (web !== undefined) {
                web.changed = true;
            }
        });
        const drift = await post(app, "run", { skill: "egm-drift-report" });
        expect(drift.status).toBe(409);
        expect(await error_of(drift)).toMatch(/^the worktree has this round's unlanded commits/);
        agents.running_lead = false;
        const stopped = await post(app, "run", { skill: "egm-brainstorm" });
        expect(stopped.status).toBe(409);
        expect(await error_of(stopped)).toBe("the lead is not running; resume it from its tab");
        expect(agents.sent).toEqual([]);
    });

    it("archives the earlier run: r1, then r2 with r1's reports in reviews/r1 (3.8)", async () => {
        const app = await named_app();
        const review = { skill: "egm-review", preset: "uninterrupted" };
        expect((await post(app, "run", review)).status).toBe(200);
        expect(stored().design?.review_run).toMatchObject({ id: "r1", preset: "uninterrupted" });
        const report = join(summary.path, "design", "consolidated_review_report.md");
        writeFileSync(report, "# Consolidated\n");
        expect((await post(app, "run", review)).status).toBe(200);
        expect(stored().design?.review_run).toMatchObject({ id: "r2", preset: "uninterrupted" });
        const reviews = join(summary.path, "design", "reviews");
        const archived = join(reviews, "r1", "consolidated_review_report.md");
        expect(readFileSync(archived, "utf8")).toBe("# Consolidated\n");
        expect(existsSync(report)).toBe(false);
        expect(existsSync(join(reviews, "r2"))).toBe(false);
        // A review loop records a run without a preset.
        expect((await post(app, "run", { skill: "egm-review-loop" })).status).toBe(200);
        expect(stored().design?.review_run).toMatchObject({ id: "r3", preset: null });
    });
});

/** Writes one async run of the lead; each step's transcript holds one $`usd` message. */
function goldfish_run(
    run: string,
    state: string,
    steps: { agent: string; status: string }[],
    usd = 0.25,
): string[] {
    const files: string[] = [];
    const dir = join(summary.path, "egm-runs", "async-subagent-runs", run);
    mkdirSync(dir, { recursive: true });
    const entries = steps.map((step, index) => {
        const file = join(
            summary.path,
            "agents",
            "lead",
            "pi",
            "lead-session",
            run,
            `run-${index}`,
            "session.jsonl",
        );
        mkdirSync(dirname(file), { recursive: true });
        const message = {
            role: "assistant",
            content: [{ type: "text", text: `report of ${step.agent}` }],
            provider: "anthropic",
            model: "claude-fable-5-1",
            usage: { input: 1, output: 2, cost: { total: usd } },
            timestamp: 1,
        };
        writeFileSync(
            file,
            `${JSON.stringify({ type: "message", timestamp: "2026-11-02T10:00:00Z", message })}\n`,
        );
        files.push(file);
        return { ...step, sessionFile: file, tokens: { total: 3 } };
    });
    writeFileSync(
        join(dir, "status.json"),
        JSON.stringify({ runId: run, state, startedAt: 1000, steps: entries }),
    );
    return files;
}

describe("Goldfish routes and view (4.8, 4.9)", () => {
    it("shows each Goldfish in the view with cost by step, and serves its transcript", async () => {
        const app = await named_app();
        goldfish_run("r-a", "complete", [
            { agent: "egm-zoom-out", status: "complete" },
            { agent: "egm-design", status: "complete" },
        ]);
        writeFileSync(
            join(summary.path, "egm-runs", "runs.json"),
            JSON.stringify({ "r-a": "brainstorm" }),
        );
        ledger.refold();
        const response = await app.request(`/sessions/${summary.dir}`);
        const view = ((await response.json()) as SessionResponse).session;
        const fish = view.design?.goldfish ?? [];
        expect(
            fish.map((entry) => [entry.persona, entry.state, entry.usd, entry.design_step]),
        ).toEqual([
            ["zoom-out", "done", 0.25, "brainstorm"],
            ["design", "done", 0.25, "brainstorm"],
        ]);
        expect(fish.every((entry) => entry.transcript)).toBe(true);
        expect(view.design?.cost_by_stage).toEqual({ brainstorm: 0.5 });
        expect(view.cost).toBeUndefined();
        const events = await app.request(`/sessions/${summary.dir}/egm/goldfish/r-a/1/events`);
        expect(events.status).toBe(200);
        const body = (await events.json()) as AgentEventsResponse;
        expect(JSON.stringify(body.events)).toContain("report of egm-design");
        for (const route of ["r-a/2", "r-x/0", "r-a/x"]) {
            const missing = await app.request(
                `/sessions/${summary.dir}/egm/goldfish/${route}/events`,
            );
            expect(missing.status, route).toBe(404);
        }
    });

    it("answers 404 for a transcript outside the session's agents/", async () => {
        const app = await named_app();
        const dir = join(summary.path, "egm-runs", "async-subagent-runs", "r-out");
        mkdirSync(dir, { recursive: true });
        const outside = join(root, "outside.jsonl");
        writeFileSync(outside, "{}\n");
        const steps = [{ agent: "egm-design", status: "complete", sessionFile: outside }];
        writeFileSync(
            join(dir, "status.json"),
            JSON.stringify({ runId: "r-out", state: "complete", steps }),
        );
        const response = await app.request(`/sessions/${summary.dir}/egm/goldfish/r-out/0/events`);
        expect(response.status).toBe(404);
        // A step whose transcript file does not exist yet is a 404 too, not a 500.
        const pi = join(summary.path, "agents", "lead", "pi");
        const later = join(pi, "s", "r-out", "run-0", "session.jsonl");
        const pending = [{ agent: "egm-design", status: "running", sessionFile: later }];
        const status = { runId: "r-out", state: "running", steps: pending };
        writeFileSync(join(dir, "status.json"), JSON.stringify(status));
        const route = `/sessions/${summary.dir}/egm/goldfish/r-out/0/events`;
        expect((await app.request(route)).status).toBe(404);
    });

    it("answers 409 for a skill start while 12 Goldfish run across sessions", async () => {
        const app = await named_app();
        const running = Array.from({ length: GOLDFISH_LIVE_MAX }, () => ({
            agent: "egm-style",
            status: "running",
        }));
        goldfish_run("r-live", "running", running);
        goldfish.wake(summary.dir);
        await goldfish.tick(summary.dir);
        expect(goldfish.live_count()).toBe(GOLDFISH_LIVE_MAX);
        const refused = await post(app, "run", { skill: "egm-brainstorm" });
        expect(refused.status).toBe(409);
        expect(await error_of(refused)).toBe(
            "12 Goldfish are running across sessions (cap 12); start this skill when they finish",
        );
        // The 400 checks come first.
        expect((await post(app, "run", { skill: "egm-nothing" })).status).toBe(400);
        expect(agents.sent).toEqual([]);
    });
});

describe("design workspace routes (5.3, 5.4)", () => {
    function get(app: Hono, route: string): Promise<Response> {
        return app.request(`/sessions/${summary.dir}/design/${route}`);
    }

    it("lists the files and the archived runs, newest first", async () => {
        const app = await named_app();
        const design = join(summary.path, "design");
        writeFileSync(join(design, "concepts_brief.md"), "# Brief\n");
        for (const run of ["r1", "r10", "r2", "notarun"]) {
            mkdirSync(join(design, "reviews", run), { recursive: true });
        }
        const response = await get(app, "files");
        expect(response.status).toBe(200);
        const body = (await response.json()) as DesignFilesResponse;
        expect(body.files.map((file) => file.name)).toContain("concepts_brief.md");
        expect(body.files.some((file) => file.name.startsWith("."))).toBe(false);
        expect(body.review_runs).toEqual(["r10", "r2", "r1"]);
        expect((await app.request("/sessions/s999-none/design/files")).status).toBe(404);
    });

    it("serves a design file and an archived report as markdown; 400 and 404", async () => {
        const app = await named_app();
        const design = join(summary.path, "design");
        writeFileSync(join(design, "concepts_brief.md"), "# Brief\n");
        writeFileSync(join(design, ".hidden.md"), "secret\n");
        mkdirSync(join(design, "reviews", "r1"), { recursive: true });
        writeFileSync(join(design, "reviews", "r1", "critic_report.md"), "# Critic\n");
        const file = await get(app, "files/concepts_brief.md");
        expect(file.status).toBe(200);
        expect(file.headers.get("content-type")).toContain("text/markdown");
        expect(await file.text()).toBe("# Brief\n");
        const report = await get(app, "reviews/r1/critic_report.md");
        expect(report.status).toBe(200);
        expect(await report.text()).toBe("# Critic\n");
        const bad = [
            "files/.hidden.md",
            "files/..%2Fsession.yaml",
            "files/notes.txt",
            "reviews/r123/critic_report.md",
            "reviews/x1/critic_report.md",
            "reviews/r1/..%2F..%2Fconcepts_brief.md",
        ];
        for (const route of bad) {
            expect((await get(app, route)).status, route).toBe(400);
        }
        expect((await get(app, "files/absent.md")).status).toBe(404);
        expect((await get(app, "reviews/r2/critic_report.md")).status).toBe(404);
    });

    it("serves the design doc from the worktree; 404 before design_doc", async () => {
        const before = app_with(true);
        expect((await put(before, "track", { track: "design" })).status).toBe(200);
        expect((await get(before, "doc")).status).toBe(404);
        goldfish.close();
        await tracker.close();
        const app = await named_app();
        const doc = await get(app, "doc");
        expect(doc.status).toBe(200);
        expect(doc.headers.get("content-type")).toContain("text/markdown");
        expect(await doc.text()).toBe(DOC_TEXT);
        rmSync(join(designs, "csv.md"));
        expect((await get(app, "doc")).status).toBe(404);
    });
});

describe("design approval routes (6.2, 6.3, 6.6, 6.7)", () => {
    const DOC_STATUS = DOC_TEXT.replace("# CSV\n", "# CSV\n\n*   **Status:** Reviewed\n");
    const report = (name: string, text: string): void => {
        mkdirSync(join(summary.path, "design"), { recursive: true });
        writeFileSync(join(summary.path, "design", name), text);
    };
    const approve = (app: Hono, body: unknown): Promise<Response> => post(app, "approve", body);
    const state_file = (): { approved: boolean } =>
        JSON.parse(readFileSync(join(summary.path, "design", ".state.json"), "utf8")) as {
            approved: boolean;
        };

    /** A design-track app whose named doc carries a `Status:` line. */
    async function status_app(): Promise<Hono> {
        const app = app_with(true);
        expect((await put(app, "track", { track: "design" })).status).toBe(200);
        writeFileSync(join(designs, "csv.md"), DOC_STATUS);
        expect((await put(app, "doc", { path: join(designs, "csv.md") })).status).toBe(200);
        return app;
    }

    it("refuses with 409 without a doc, while resolving, and with an open gate", async () => {
        const bare = app_with(true);
        expect((await put(bare, "track", { track: "design" })).status).toBe(200);
        const no_doc = await approve(bare, { build: true });
        expect(no_doc.status).toBe(409);
        expect(await no_doc.json()).toEqual({ error: "no design doc yet", blockers: null });
        goldfish.close();
        await tracker.close();

        const app = await status_app();
        report("goldfish_review_report.md", "# Report\n### [Issue 1] [x] - Severity: High\n");
        await tracker.refresh(summary.dir);
        const resolving = await approve(app, { build: true });
        expect(resolving.status).toBe(409);
        expect(await resolving.json()).toMatchObject({ blockers: null });
        rmSync(join(summary.path, "design", "goldfish_review_report.md"));
        expect((await put(app, "gate", GATE)).status).toBe(200);
        const gated = await approve(app, { build: true });
        expect(gated.status).toBe(409);
        expect(await error_of(gated)).toBe("the lead asked a question; answer it first");
        expect(stored().design?.approved).toBeUndefined();
        expect(agents.sent).toEqual([]);
        for (const body of [{}, { build: "yes" }, { build: true, blockers_confirmed: -1 }]) {
            expect((await approve(app, body)).status, JSON.stringify(body)).toBe(400);
        }
    });

    it("needs the blocker count confirmed, then pins the hash and starts the build", async () => {
        const app = await status_app();
        const blockers =
            "# Consolidated\n## 🔴 Blockers\n### One\n### Two\n## 🟡 Majors\n### Three\n";
        report("consolidated_review_report.md", blockers);
        for (const body of [{ build: true }, { build: true, blockers_confirmed: 1 }]) {
            const refused = await approve(app, body);
            expect(refused.status).toBe(409);
            const refusal = (await refused.json()) as DesignApproveRefusal;
            expect(refusal).toEqual({
                error: "The newest review report lists 2 blockers.",
                blockers: 2,
            });
        }
        expect(stored().design?.approved).toBeUndefined();

        const approved = await approve(app, { build: true, blockers_confirmed: 2 });
        expect(approved.status).toBe(200);
        const doc = readFileSync(join(designs, "csv.md"), "utf8");
        expect(doc).toContain("*   **Status:** Approved\n");
        const sha256 = normalized_doc_hash(doc);
        expect(sha256).toBe(normalized_doc_hash(DOC_STATUS));
        const session = stored();
        expect(session.design?.approved).toMatchObject({
            path: "docs/designs/csv.md",
            repo: "web",
            sha256,
            blockers: 2,
            round: 1,
        });
        expect(session.design?.approvals).toHaveLength(1);
        expect(session.design?.stage).toBe("approved");
        expect(readFileSync(join(summary.path, "design", "approved.md"), "utf8")).toBe(doc);
        const mission = readFileSync(join(summary.path, "MISSION.md"), "utf8");
        const sha12 = sha256.slice(0, 12);
        const line = `design approved: docs/designs/csv.md (${sha12}, 2 listed blockers)`;
        expect(mission).toContain(`spinner: ${line}`);
        expect(agents.sent).toHaveLength(1);
        expect(agents.sent[0]).toContain(`The design is approved: ${join(designs, "csv.md")}`);
        expect(agents.sent[0]).toContain("mission_plan add");
        expect(state_file().approved).toBe(true);
        const copy = await app.request(`/sessions/${summary.dir}/design/approved`);
        expect(copy.status).toBe(200);
        expect(await copy.text()).toBe(doc);
        // The seed (session-workspace T4): one item per entry, owner null, the token first,
        // the seed Log line after the approval line, and the counts in the response.
        const body = (await approved.json()) as DesignApproveResponse;
        expect(body.seed).toEqual({
            doc_path: "docs/designs/csv.md",
            sha12,
            added: 2,
            kept: 0,
            stale: [],
            orphaned: [],
        });
        expect(body.session.design?.stage).toBe("approved");
        const plan = mission_view(mission).plan;
        expect(plan.map((item) => [item.id, item.entry, item.text, item.owner])).toEqual([
            [1, "1.1", "`src/a.ts`", null],
            [2, "1.2", "`src/b.ts`", null],
        ]);
        const seed_line =
            `plan seeded from docs/designs/csv.md (${sha12}): ` +
            "2 added, 0 kept, 0 stale, 0 orphaned";
        const lines = mission.split("\n");
        const approval_index = lines.findIndex((text) => text.includes(line));
        expect(lines[approval_index + 1]).toContain(`spinner: ${seed_line}`);
        expect(agents.sent[0]).toContain("2 added, 0 kept");
        expect(agents.sent[0]).toContain("`[n.n]` token");
    });

    it("refuses with 409 and records nothing when the seed checks fail", async () => {
        const app = await status_app();
        const cases: [string, string][] = [
            [
                DOC_STATUS.replace("##### 1.2 ", "##### 1.1 "),
                "the plan has duplicate entry ids: 1.1",
            ],
            [DOC_STATUS.replace("`src/b.ts` (Modify)", "(Modify)"), "entries without a title: 1.2"],
            [
                DOC_STATUS.replace("## Detailed Implementation Plan", "## Plan"),
                "no plan entries found under an Implementation Plan heading",
            ],
        ];
        for (const [text, reason] of cases) {
            writeFileSync(join(designs, "csv.md"), text);
            const refused = await approve(app, { build: true });
            expect(refused.status, reason).toBe(409);
            expect(await refused.json()).toEqual({ error: reason, blockers: null });
            expect(stored().design?.approved).toBeUndefined();
            expect(readFileSync(join(designs, "csv.md"), "utf8")).toBe(text);
        }
        expect(existsSync(join(summary.path, "design", "approved.md"))).toBe(false);
        expect(agents.sent).toEqual([]);
        expect(readFileSync(join(summary.path, "MISSION.md"), "utf8")).not.toContain("spinner:");
    });

    it("refuses a Plan that would pass ITEMS_MAX; a second seed adds the new only", async () => {
        const app = await status_app();
        const entries: string[] = [];
        for (let n = 3; n <= 499; n += 1) {
            entries.push(`##### 1.${n} \`src/${n}.ts\``);
        }
        const big = `${DOC_STATUS}\n${entries.join("\n\n")}\n`;
        writeFileSync(join(designs, "csv.md"), big);
        expect((await approve(app, { build: false })).status).toBe(200);
        const seeded = readFileSync(join(summary.path, "MISSION.md"), "utf8");
        expect(mission_view(seeded).plan).toHaveLength(499);
        // A free item beside the 499 seeded ones; one more entry would make 501 items.
        writeFileSync(
            join(summary.path, "MISSION.md"),
            seeded.replace("## Roster", "- [ ] 500. a free item (lead)\n\n## Roster"),
        );
        writeFileSync(join(designs, "csv.md"), `${big}\n##### 1.500 \`src/500.ts\`\n`);
        await tracker.refresh(summary.dir);
        const refused = await approve(app, { build: false });
        expect(refused.status).toBe(409);
        expect(await error_of(refused)).toBe("the Plan would hold 501 items; the bound is 500");
        // A doc past the scan's own bound is refused too, not a 500.
        const more = [500, 501].map((n) => `##### 1.${n} \`s${n}.ts\``).join("\n\n");
        const past = `${big}\n${more}\n`;
        writeFileSync(join(designs, "csv.md"), past);
        await tracker.refresh(summary.dir);
        const past_scan = await approve(app, { build: false });
        expect(past_scan.status).toBe(409);
        expect(await error_of(past_scan)).toBe("the plan has more than 500 entries");
        // A re-approval of the doc adds nothing; a renamed entry reads stale.
        writeFileSync(join(designs, "csv.md"), big.replace("`src/a.ts`", "`src/a2.ts`"));
        await tracker.refresh(summary.dir);
        const again = await approve(app, { build: false });
        expect(again.status).toBe(200);
        const body = (await again.json()) as DesignApproveResponse;
        expect(body.seed).toMatchObject({ added: 0, kept: 499, stale: ["1.1"], orphaned: [] });
        const final = readFileSync(join(summary.path, "MISSION.md"), "utf8");
        expect(mission_view(final).plan).toHaveLength(500);
    });

    it("approves without the build prompt; refuses a build while the lead is stopped", async () => {
        const app = await status_app();
        agents.running_lead = false;
        const stopped = await approve(app, { build: true });
        expect(stopped.status).toBe(409);
        expect(stored().design?.approved).toBeUndefined();
        const quiet = await approve(app, { build: false });
        expect(quiet.status).toBe(200);
        expect(stored().design?.approved?.blockers).toBe(0);
        expect(agents.sent).toEqual([]);
    });

    it("an edit invalidates the approval once per hash; re-approval in round 2", async () => {
        const app = await status_app();
        expect((await approve(app, { build: false })).status).toBe(200);
        const unchanged = await app.request(`/sessions/${summary.dir}/design/changes`);
        expect(((await unchanged.json()) as DesignChangesResponse).changes).toEqual([]);

        const edited = readFileSync(join(designs, "csv.md"), "utf8").replace(
            "Rows.",
            "Rows, quoted.",
        );
        writeFileSync(join(designs, "csv.md"), edited);
        await tracker.refresh(summary.dir);
        await tracker.refresh(summary.dir);
        const changed = stored();
        expect(changed.design?.changed_after_approval).toBe(true);
        expect(changed.design?.stage).toBe("drafted");
        expect(changed.needs_human).toBe("re-approve the design (changed since approval)");
        expect(state_file().approved).toBe(false);
        expect(agents.notices).toEqual([
            "The design doc changed in Overview; the approval is invalidated. " +
                "Your code writes stay locked until the operator re-approves.",
        ]);
        const response = await app.request(`/sessions/${summary.dir}/design/changes`);
        const body = (await response.json()) as DesignChangesResponse;
        expect(body.changes).toEqual([
            { heading: "Overview", approved: "\nRows.", current: "\nRows, quoted." },
        ]);

        patch_session((session) => {
            session.round = 2;
        });
        expect((await approve(app, { build: false })).status).toBe(200);
        const again = stored();
        expect(again.design?.changed_after_approval).toBe(false);
        expect(again.design?.approvals?.map((entry) => entry.round)).toEqual([1, 2]);
        expect(state_file().approved).toBe(true);
    });

    it("DELETE removes the approval and the copy and keeps the history", async () => {
        const app = await status_app();
        expect((await approve(app, { build: false })).status).toBe(200);
        const removed = await app.request(`/sessions/${summary.dir}/design/approve`, {
            method: "DELETE",
        });
        expect(removed.status).toBe(200);
        const session = stored();
        expect(session.design?.approved).toBeUndefined();
        expect(session.design?.changed_after_approval).toBe(false);
        expect(session.design?.approvals).toHaveLength(1);
        expect(existsSync(join(summary.path, "design", "approved.md"))).toBe(false);
        expect((await app.request(`/sessions/${summary.dir}/design/approved`)).status).toBe(404);
        expect(state_file().approved).toBe(false);
    });
});
