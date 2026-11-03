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
// runs, so a test reads the exact text that would reach pi.
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
import { EGM_ADAPTER_VERSION, EGM_REQUIRED_FILES } from "@spinner/protocol";
import type { AgentHandle } from "../agents/harness.js";
import { AgentManager } from "../agents/manager.js";
import { PiRpcHarness } from "../agents/harness.js";
import { EventBus } from "../event-bus.js";
import { resolve_home, type SpinnerHome } from "../home.js";
import { JobRunner } from "../jobs/jobs.js";
import { create_app } from "../server.js";
import { run_ok } from "../stack/shell.js";
import { MissionWriter } from "../store/mission-writer.js";
import { create_session, read_session, write_session } from "../store/session-store.js";
import { build_session_view } from "../views/session-view.js";
import { DesignTracker } from "./design.js";
import { normalized_doc_hash } from "./derive-design.js";
import { EgmFetcher, egm_source_dir, marker_path } from "./fetch.js";
import { EGM_PIN } from "./pins.js";

const DOC_TEXT = "# CSV\n\n## Overview\n\nRows.\n\n## Detailed Implementation Plan\n\n1. A.\n";

let root: string;
let home: SpinnerHome;
let summary: SessionSummary;
let designs: string;
let tracker: DesignTracker;
let agents: RecordingAgents;

/** The lead's pi, recorded: every prompt and steer, in order, while `running` is true. */
class RecordingAgents extends AgentManager {
    running_lead = true;
    sent: string[] = [];

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
    tracker = new DesignTracker({ home, cwd: root, agents, bus, writer, refresh, log });
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
