// The plans library and `Implement`. Method: a temp home; a plan with a two-entry document;
// attach it to a session and check the copy, the record in `session.yaml`, the seeded Plan
// and the plan's status as items are ticked. Then the import of an older session's approved
// design, and the refusals.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { APPROVED_COPY, EGM_ARTIFACT_DIR, PLANS_REPO } from "@spinner/protocol";
import { EventBus } from "../event-bus.js";
import { resolve_home, type SpinnerHome } from "../home.js";
import { MissionWriter } from "../store/mission-writer.js";
import { create_session, read_session, write_session } from "../store/session-store.js";
import {
    attach_plan,
    implement_blocker,
    implement_message,
    plan_to_implement,
    PlanRefusal,
} from "./implement.js";
import {
    ensure_plan,
    import_designs,
    plan_dir,
    plan_doc_path,
    plan_views,
    read_plan,
    write_plan,
} from "./library.js";

const DOC = [
    "# Export redesign",
    "",
    "## Overview",
    "Two steps.",
    "",
    "## Detailed Implementation Plan",
    "",
    "#### 1.1 Add the endpoint",
    "Return the rows as CSV.",
    "",
    "#### 1.2 Add the button",
    "Call the endpoint.",
    "",
].join("\n");

let home: SpinnerHome;
let writer: MissionWriter;
const NOW = new Date("2026-11-12T12:00:00Z");

function plan_with_doc(id: string, text = DOC): void {
    ensure_plan(home, { id, title: "Export redesign", project: null, origin: null, now: NOW });
    writeFileSync(join(plan_dir(home, id), "export.md"), text);
}

function reread(dir: string) {
    const read = read_session(home, dir);
    if (!read.ok) {
        throw new Error(read.error);
    }
    return read.summary;
}

beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "spinner-plans-"));
    home = resolve_home({ SPINNER_HOME: root, SPINNER_SESSION_IDS: "home" });
    writer = new MissionWriter(home, new EventBus());
});

describe("the plans library", () => {
    it("keeps a plan's record and finds its document, named or the only one", () => {
        plan_with_doc("p1");
        const record = read_plan(home, "p1");
        expect(record).toMatchObject({ id: "p1", doc: null, implementations: [] });
        expect(plan_doc_path(home, record!)).toBe(join(plan_dir(home, "p1"), "export.md"));
        // A second file makes the unnamed document ambiguous; the record's name settles it.
        writeFileSync(join(plan_dir(home, "p1"), "notes.md"), "notes\n");
        expect(plan_doc_path(home, record!)).toBeNull();
        write_plan(home, { ...record!, doc: "export.md" });
        expect(plan_doc_path(home, read_plan(home, "p1")!)).toContain("export.md");
        // An id that is not a directory name of the library reads as no plan.
        expect(read_plan(home, "../outside")).toBeNull();
        expect(read_plan(home, "p9")).toBeNull();
    });

    it("says draft, drafted, implementing and done as the work goes", async () => {
        ensure_plan(home, { id: "p0", title: "Empty", project: null, origin: null, now: NOW });
        plan_with_doc("p1");
        const status = () => Object.fromEntries(plan_views(home, []).map((p) => [p.id, p.status]));
        expect(status()).toEqual({ p0: "draft", p1: "drafted" });
        const session = create_session(home, { title: "Build exports" });
        const deps = { home, writer, now: () => NOW };
        await attach_plan(deps, session, plan_to_implement(home, "p1"));
        const view = () => plan_views(home, [reread(session.dir)]).find((p) => p.id === "p1");
        expect(view()).toMatchObject({ status: "implementing", entries: 2, done: 0 });
        expect(view()?.sessions).toEqual([
            { session: session.dir, live: true, title: "Build exports", done: 0, entries: 2 },
        ]);
        // The lead ticks both items: the plan is done.
        const mission_file = join(session.path, "MISSION.md");
        const mission = readFileSync(mission_file, "utf8");
        writeFileSync(mission_file, mission.replace(/- \[ \] (\d+\. \[1\.)/g, "- [x] $1"));
        expect(view()).toMatchObject({ status: "done", done: 2 });
    });

    it("imports the approved design of an older session once, as a plan", () => {
        const old = create_session(home, { title: "CSV export" });
        mkdirSync(join(old.path, EGM_ARTIFACT_DIR), { recursive: true });
        writeFileSync(join(old.path, EGM_ARTIFACT_DIR, APPROVED_COPY), DOC);
        expect(import_designs(home, NOW)).toEqual([old.dir]);
        expect(import_designs(home, NOW)).toEqual([]);
        const record = read_plan(home, old.dir);
        expect(record).toMatchObject({ title: "CSV export", doc: "plan.md", origin: old.dir });
        expect(record?.implementations.map((entry) => entry.session)).toEqual([old.dir]);
        expect(readFileSync(plan_doc_path(home, record!)!, "utf8")).toBe(DOC);
    });
});

describe("Implement", () => {
    it("attaches the plan: the copy, the record, the seeded Plan, the Log", async () => {
        plan_with_doc("p1");
        const session = create_session(home, { title: "Build exports" });
        const plan = plan_to_implement(home, "p1");
        const seed = await attach_plan({ home, writer, now: () => NOW }, session, plan);
        expect(seed).toMatchObject({ doc_path: "p1/export.md", added: 2, kept: 0 });
        const design = reread(session.dir).session.design;
        expect(design).toMatchObject({ track: "direct", doc: "p1/export.md", repo: PLANS_REPO });
        expect(design?.approved?.sha256).toHaveLength(64);
        const copy = join(session.path, EGM_ARTIFACT_DIR, APPROVED_COPY);
        expect(readFileSync(copy, "utf8")).toBe(DOC);
        const mission = readFileSync(join(session.path, "MISSION.md"), "utf8");
        expect(mission).toMatch(/- \[ \] 1\. \[1\.1\] Add the endpoint/);
        expect(mission).toMatch(/- \[ \] 2\. \[1\.2\] Add the button/);
        expect(mission).toMatch(/plan attached: Export redesign \(p1, [0-9a-f]{12}\)/);
        expect(read_plan(home, "p1")?.implementations).toEqual([
            { session: session.dir, at: NOW.toISOString(), sha12: seed.sha12 },
        ]);
        const message = implement_message(plan, seed);
        expect(message).toContain('Implement the plan "Export redesign"');
        expect(message).toContain("`change` `start`");
        // The plan takes the title its planning session's lead gave it.
        const planning = create_session(home, { title: "Export redesign" });
        planning.session.kind = "plan";
        planning.session.title = "CSV export, phase 1";
        write_session(planning);
        const stored = read_plan(home, "p1")!;
        write_plan(home, { ...stored, origin: planning.dir });
        expect(plan_to_implement(home, "p1").record.title).toBe("CSV export, phase 1");
        expect(read_plan(home, "p1")?.title).toBe("CSV export, phase 1");
        // Two sessions with one title do not share a branch.
        const twin = create_session(home, { title: "Export redesign" });
        expect(planning.session.branch).toBe("feat/export-redesign");
        expect(twin.session.branch).toBe(`feat/export-redesign-${twin.session.id}`);
        // A session that implements a plan holds a copy; it is not imported as a plan.
        expect(import_designs(home, NOW)).toEqual([]);
    });

    it("refuses without a document, without entries, and for a planning session", () => {
        expect(() => plan_to_implement(home, "p9")).toThrow(PlanRefusal);
        ensure_plan(home, { id: "p0", title: "Empty", project: null, origin: null, now: NOW });
        expect(() => plan_to_implement(home, "p0")).toThrow(/no document yet/);
        plan_with_doc("p2", "# No plan\n\n## Overview\nNothing.\n");
        const session = create_session(home, { title: "Build" });
        expect(implement_blocker(session, plan_to_implement(home, "p2"))).toMatch(
            /no plan entries found/,
        );
        plan_with_doc("p1");
        const planning = create_session(home, { title: "A plan" });
        planning.session.kind = "plan";
        write_session(planning);
        expect(implement_blocker(planning, plan_to_implement(home, "p1"))).toMatch(
            /is a plan session/,
        );
        expect(existsSync(join(session.path, EGM_ARTIFACT_DIR, APPROVED_COPY))).toBe(false);
    });
});
