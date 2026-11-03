// Goal: the design tracker derives the design stage of a session from its files, names the
// design doc through `set_doc` with every refusal of `check_design_doc`, writes
// `.state.json` for the edit guard, and re-derives `session.needs_human` in the same write
// (docs/designs/egm-adoption.md, entry 2.13, review v2 B-1 and M-4). Method: a scratch home
// with one session made by `create_session`, a real clone of a bare origin as its `web`
// worktree, and a real `MissionWriter`; each assertion reads `session.yaml` back from disk.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DesignState, Session, SessionSummary } from "@spinner/protocol";
import { AgentManager } from "../agents/manager.js";
import { PiRpcHarness } from "../agents/harness.js";
import { EventBus } from "../event-bus.js";
import { resolve_home, type SpinnerHome } from "../home.js";
import { run_ok } from "../stack/shell.js";
import { MissionWriter } from "../store/mission-writer.js";
import { create_session, read_session, write_session } from "../store/session-store.js";
import { DesignDocConflict, DesignDocRefused, DesignTracker } from "./design.js";
import { normalized_doc_hash } from "./derive-design.js";

const DOC_TEXT = [
    "# CSV export",
    "",
    "*   **Status:** Draft",
    "",
    "## Overview",
    "",
    "Export rows.",
    "",
    "## Detailed Implementation Plan",
    "",
    "1. Add the route.",
    "",
].join("\n");

let root: string;
let home: SpinnerHome;
let summary: SessionSummary;
let tracker: DesignTracker;
let worktree: string;
let designs: string;
let refreshed: string[];

async function make_worktree(path: string): Promise<void> {
    const seed = join(root, "seed");
    await run_ok("git", ["init", "--quiet", "--initial-branch", "main", seed]);
    await run_ok("git", ["-C", seed, "config", "user.email", "t@example.com"]);
    await run_ok("git", ["-C", seed, "config", "user.name", "t"]);
    mkdirSync(join(seed, "docs", "designs"), { recursive: true });
    writeFileSync(join(seed, "docs", "designs", "landed.md"), DOC_TEXT);
    await run_ok("git", ["-C", seed, "add", "."]);
    await run_ok("git", ["-C", seed, "commit", "--quiet", "-m", "init"]);
    const origin = join(root, "origin.git");
    await run_ok("git", ["clone", "--quiet", "--bare", seed, origin]);
    await run_ok("git", ["clone", "--quiet", origin, path]);
}

beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "spinner-design-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home") });
    summary = create_session(home, { title: "CSV export" });
    worktree = join(summary.path, "worktrees", "web");
    designs = join(worktree, "docs", "designs");
    await make_worktree(worktree);
    summary.session.base = "main";
    summary.session.repos = { web: { path: worktree, worktree: "worktrees/web", changed: false } };
    summary.session.design = { track: "design" };
    write_session(summary);
    const bus = new EventBus();
    const rpc = new PiRpcHarness({ pi: () => "pi-is-not-started-here", extension: null });
    const agents = new AgentManager(home, { default: "rpc", rpc }, bus);
    refreshed = [];
    tracker = new DesignTracker({
        home,
        cwd: root,
        agents,
        bus,
        writer: new MissionWriter(home, bus),
        refresh: async (dir) => {
            refreshed.push(dir);
        },
        log: () => undefined,
    });
});

afterEach(async () => {
    await tracker.close();
    rmSync(root, { recursive: true, force: true });
});

function session(): Session {
    const read = read_session(home, summary.dir);
    expect(read.ok).toBe(true);
    return (read as { ok: true; summary: SessionSummary }).summary.session;
}

function patch_design(patch: Partial<DesignState>): void {
    const read = read_session(home, summary.dir);
    if (!read.ok) {
        throw new Error(read.error);
    }
    read.summary.session.design = { ...(read.summary.session.design as DesignState), ...patch };
    write_session(read.summary);
}

function design_file(name: string, text = "x\n"): void {
    mkdirSync(join(summary.path, "design"), { recursive: true });
    writeFileSync(join(summary.path, "design", name), text);
}

function state(): unknown {
    return JSON.parse(readFileSync(join(summary.path, "design", ".state.json"), "utf8"));
}

describe("DesignTracker: the stage from files", () => {
    it("moves intake → brainstorm → drafting and writes .state.json", async () => {
        expect(session().needs_human).toBe("write Goal and Done when in MISSION.md");
        await tracker.refresh(summary.dir);
        expect(session().design?.stage).toBe("intake");
        expect(session().needs_human).toBeNull();
        expect(session().stage).toBe("planned");
        expect(state()).toEqual({
            track: "design",
            stage: "intake",
            approved: false,
            designs_dir: designs,
        });
        expect(refreshed).toEqual([summary.dir]);
        design_file("concepts_brief.md");
        await tracker.refresh(summary.dir);
        expect(session().design?.stage).toBe("brainstorm");
        design_file("design_draft.md");
        await tracker.refresh(summary.dir);
        expect(session().design?.stage).toBe("drafting");
        // A refresh with the same facts writes nothing.
        const count = refreshed.length;
        await tracker.refresh(summary.dir);
        expect(refreshed).toHaveLength(count);
    });
});

describe("DesignTracker: set_doc", () => {
    it("refuses each path that is not a new design doc of this session", async () => {
        const refused = async (path: string, message: string | RegExp): Promise<void> => {
            const attempt = tracker.set_doc(summary.dir, path);
            await expect(attempt).rejects.toBeInstanceOf(DesignDocRefused);
            await expect(tracker.set_doc(summary.dir, path)).rejects.toThrow(message);
        };
        await refused("docs/designs/a.md", "the path must be absolute");
        writeFileSync(join(worktree, "a.md"), DOC_TEXT);
        await refused(join(worktree, "a.md"), `a .md file directly in ${designs}`);
        writeFileSync(join(designs, "SITEMAP.md"), DOC_TEXT);
        await refused(join(designs, "SITEMAP.md"), "SITEMAP.md and README.md are not design docs");
        await refused(join(designs, "none.md"), `no file at ${join(designs, "none.md")}`);
        writeFileSync(join(designs, "brief.md"), "# Brief\n\n## Overview\n\nAn RFC.\n");
        await refused(join(designs, "brief.md"), /this file lacks ## Detailed Implementation Plan/);
        await refused(
            join(designs, "landed.md"),
            "docs/designs/landed.md already exists on origin/main; a session names a new doc",
        );
        expect(session().design?.doc).toBeUndefined();
    });

    it("names a new doc: drafted, the Goal pointer, and needs_human from the design", async () => {
        writeFileSync(join(designs, "csv-export.md"), DOC_TEXT);
        const named = await tracker.set_doc(summary.dir, join(designs, "csv-export.md"));
        expect(named.session.design).toMatchObject({
            doc: "docs/designs/csv-export.md",
            repo: "web",
            stage: "drafted",
        });
        expect(session().needs_human).toBe("review the design");
        expect(session().stage).toBe("planned");
        const mission = readFileSync(join(summary.path, "MISSION.md"), "utf8");
        const pointer = "The design doc holds the goal: `web/docs/designs/csv-export.md`.";
        expect(mission).toContain(pointer);
        design_file("consolidated_review_report.md");
        await tracker.refresh(summary.dir);
        expect(session().design?.stage).toBe("design-ready");
        expect(session().needs_human).toBe("approve the design");
    });

    it("accepts a doc on origin/<base> when it is the session's current doc", async () => {
        patch_design({ doc: "docs/designs/landed.md", repo: "web" });
        const named = await tracker.set_doc(summary.dir, join(designs, "landed.md"));
        expect(named.session.design?.doc).toBe("docs/designs/landed.md");
    });

    it("refuses while an approval stands", async () => {
        patch_design({
            doc: "docs/designs/landed.md",
            repo: "web",
            approved: {
                path: "docs/designs/landed.md",
                repo: "web",
                sha256: normalized_doc_hash(DOC_TEXT),
                at: "2026-11-04T11:40:00Z",
                blockers: 0,
                round: 1,
            },
        });
        await expect(
            tracker.set_doc(summary.dir, join(designs, "landed.md")),
        ).rejects.toBeInstanceOf(DesignDocConflict);
    });
});

describe("DesignTracker: approval, change and the track switch", () => {
    it("approved, then changed by an edit that the doc watcher sees: re-approve", async () => {
        const doc = join(designs, "csv-export.md");
        writeFileSync(doc, DOC_TEXT);
        await tracker.set_doc(summary.dir, doc);
        design_file("consolidated_review_report.md");
        const approved = {
            path: "docs/designs/csv-export.md",
            repo: "web",
            sha256: normalized_doc_hash(DOC_TEXT.replace("Draft", "Approved")),
            at: "2026-11-04T11:40:00Z",
            blockers: 0,
            round: 1,
        };
        patch_design({ approved, approvals: [approved] });
        await tracker.refresh(summary.dir);
        expect(session().design?.stage).toBe("approved");
        expect(session().needs_human).toBeNull();
        expect(state()).toMatchObject({ stage: "approved", approved: true });
        // The doc watcher refreshes the session on an edit; wait on session.yaml, 15 s at most.
        // chokidar's native watch can start late under load (watch/live.ts), so the edit is
        // repeated every second until the artifact shows.
        const deadline = Date.now() + 15_000;
        for (let edit = 1; session().design?.changed_after_approval !== true; edit += 1) {
            expect(Date.now()).toBeLessThan(deadline);
            writeFileSync(doc, `${DOC_TEXT}${edit + 1}. Add the button.\n`);
            const changed = (): boolean => session().design?.changed_after_approval === true;
            for (let tick = 0; tick < 20 && !changed(); tick += 1) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        }
        expect(session().design).toMatchObject({
            stage: "design-ready",
            changed_after_approval: true,
        });
        expect(session().needs_human).toBe("re-approve the design (changed since approval)");
        expect(session().stage).toBe("planned");
        expect(state()).toMatchObject({ stage: "design-ready", approved: false });
    }, 20_000);

    it("a switch to direct rewrites .state.json and gives the pipeline's needs_human", async () => {
        writeFileSync(join(designs, "csv-export.md"), DOC_TEXT);
        await tracker.set_doc(summary.dir, join(designs, "csv-export.md"));
        expect(session().needs_human).toBe("review the design");
        patch_design({ track: "direct" });
        await tracker.refresh(summary.dir);
        expect(state()).toMatchObject({ track: "direct", approved: false });
        expect(session().needs_human).toBeNull();
        expect(tracker.view(read_session_ok())?.stage).toBeNull();
    });
});

function read_session_ok(): SessionSummary {
    const read = read_session(home, summary.dir);
    if (!read.ok) {
        throw new Error(read.error);
    }
    return read.summary;
}
