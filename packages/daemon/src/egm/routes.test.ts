// Goal: the EGM routes answer as docs/designs/egm-adoption.md, entries 2.24 and 2.25, say:
// `PUT …/design/track` with 200, 400 and both 409s, `PUT …/design/doc` with 200, one 400 per
// refusal kind and the 409s, and `GET /egm` with a status. Method: `create_app` on a scratch
// home with real collaborators (the job runner, the mission writer, the design tracker, the
// view builder), one session made by `create_session` whose `web` worktree is a real clone
// of a bare origin, and an `EgmFetcher` over a scratch pi agent dir.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EgmResponse, SessionResponse, SessionSummary } from "@spinner/protocol";
import { EGM_ADAPTER_VERSION, EGM_REQUIRED_FILES } from "@spinner/protocol";
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
    const agents = new AgentManager(home, { default: "rpc", rpc }, bus);
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
