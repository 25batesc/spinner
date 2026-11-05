// The Implement view's rules (docs/designs/session-workspace.md, entry 2.16). Method: each case
// builds Plan items with entry tokens and a doc scan, as the daemon and `scan` produce them,
// and reads what the view would show: the groups and their order, which group opens, the
// view's state and header, the rail state per agent, the mark of each entry, and the goal
// block's source and paragraph.
import type {
    AgentSpec, DesignView, PlanItem, PlanScan, QuestionItem,
} from "@spinner/protocol";
import { scan } from "@spinner/protocol";
import { describe, expect, it } from "vitest";

import {
    entryMarks, goalParagraph, goalSource, headerText, implementState, markTitle, needsAgent,
    phaseGroups, questionGroups, railState, resolutionText,
} from "./implement.ts";

const DOC = [
    "# X",
    "",
    "## Overview",
    "",
    "The first line of the overview.",
    "The second line of the same paragraph.",
    "",
    "A second paragraph.",
    "",
    "## Detailed Implementation Plan",
    "",
    "#### Build session 1: the engine",
    "",
    "##### 1.1 `a.ts` (Create)",
    "##### 1.2 `b.ts` (Modify)",
    "",
    "#### Build session 2: the UI",
    "",
    "##### 2.1 `c.ts` (Modify)",
    "##### 2.2 `d.ts` (Modify)",
    "",
    "#### Build session 3",
    "",
    "##### 3.1 `e.ts` (Create)",
].join("\n");

const FLAT = ["## Implementation Plan", "", "#### 1. `a.ts`", "#### 2. `b.ts`"].join("\n");

function item(
    id: number, entry: string | null, text: string, state: PlanItem["state"] = "next",
    owner: string | null = null,
): PlanItem {
    return { id, entry, text, owner, state, ticked_at: state === "done" ? "02:00" : null };
}

function design(partial: Partial<DesignView> = {}): DesignView {
    return {
        track: "design", stage: "approved", files: [],
        reviews: { "5": false, "6": false, "7": false, "8": false, "9": false },
        consolidated: false, resolve: "none", review_run: null, doc: "docs/designs/x.md",
        doc_missing: false, approved: null, approvals: [], changed_after_approval: false,
        gate: null, goldfish: [], goldfish_live: 0, cost_by_stage: {}, ...partial,
    };
}

const PLAN: PlanItem[] = [
    item(1, "1.1", "`a.ts`", "done", "engine"),
    item(2, "1.2", "`b.ts`", "done", "engine"),
    item(3, "2.1", "`c.ts`", "doing", "ui"),
    item(4, "2.2", "`d.ts`"),
    item(5, "3.1", "`e.ts`"),
    item(6, null, "fix the guard", "next", "lead"),
    item(7, "9.9", "`gone.ts`"),
    item(8, "2.2", "`d-old.ts`", "done"),
];

describe("phaseGroups", () => {
    const groups = phaseGroups(PLAN, scan(DOC));

    it("makes one group per phase, then Other for free and orphan items", () => {
        expect(groups.map((group) => [group.id, group.label, group.total])).toEqual([
            ["phase-1", "Build session 1: the engine", 2],
            ["phase-2", "Build session 2: the UI", 3],
            ["phase-3", "Build session 3", 1],
            ["other", "Other", 2],
        ]);
        expect(groups[3]?.rows.map((row) => [row.item.id, row.orphan])).toEqual(
            [[6, false], [7, true]],
        );
    });

    it("keeps a stale item in its phase with the badge", () => {
        const stale = groups[1]?.rows.find((row) => row.item.id === 8);
        expect(stale?.stale).toBe(true);
        expect(groups[1]?.rows.filter((row) => row.stale).map((row) => row.item.id)).toEqual([8]);
    });

    it("sorts doing, then next, then done inside a group, and counts them", () => {
        expect(groups[1]?.rows.map((row) => row.item.id)).toEqual([3, 4, 8]);
        expect([groups[1]?.done, groups[1]?.doing]).toEqual([1, 1]);
        expect([groups[0]?.done, groups[0]?.doing]).toEqual([2, 0]);
    });

    it("opens the groups with a doing row, else the first with an open row", () => {
        expect(groups.map((group) => group.open)).toEqual([false, true, false, false]);
        const quiet = phaseGroups(PLAN.map((row) =>
            row.state === "doing" ? { ...row, state: "next" as const } : row), scan(DOC));
        expect(quiet.map((group) => group.open)).toEqual([false, true, false, false]);
    });

    it("gives one Plan group for a flat doc and for no doc", () => {
        const flat = phaseGroups([item(1, "1", "`a.ts`"), item(2, null, "x")], scan(FLAT));
        expect(flat.map((group) => [group.id, group.total, group.open]))
            .toEqual([["plan", 2, true]]);
        const none = phaseGroups(PLAN, null);
        expect(none.map((group) => [group.id, group.total])).toEqual([["plan", 8]]);
        expect(none[0]?.rows.every((row) => !row.orphan && !row.stale)).toBe(true);
    });
});

describe("implementState and headerText", () => {
    const approved = {
        path: "docs/designs/x.md", repo: "web", sha256: "a", at: "2026-11-05T02:00:00Z",
        blockers: 0, round: 1,
    };

    it("names the three states and their header", () => {
        const parsed = scan(DOC);
        expect(implementState(undefined, null)).toBe("no-doc");
        expect(implementState(design({ track: "direct", stage: null }), parsed)).toBe("no-doc");
        expect(implementState(design({ doc: null }), null)).toBe("no-doc");
        expect(implementState(design(), parsed)).toBe("unapproved");
        expect(implementState(design({ approved }), parsed)).toBe("approved");
        expect(headerText("no-doc", null, [])).toBe("No design doc yet");
        expect(headerText("unapproved", parsed, [])).toBe("Approve to seed 5 entries");
        expect(headerText("approved", parsed, PLAN)).toBe("entries done 2 / 5");
    });
});

describe("railState", () => {
    const spec = { process: "running" } as unknown as AgentSpec;
    const idle = { process: "idle" } as unknown as AgentSpec;

    it("gives each of the five states", () => {
        expect(railState(spec, true, false, false)).toBe("working");
        expect(railState(idle, true, false, false)).toBe("idle");
        expect(railState(spec, false, false, false)).toBe("off");
        expect(railState(spec, true, true, false)).toBe("blocked");
        expect(railState(spec, true, true, true)).toBe("needs-you");
        expect(railState(undefined, false, false, false)).toBe("off");
    });

    it("reads whether needs_human names the agent", () => {
        expect(needsAgent("ui is blocked: waiting for engine", "ui")).toBe(true);
        expect(needsAgent("the build agent waits", "ui")).toBe(false);
        expect(needsAgent(null, "ui")).toBe(false);
    });
});

describe("entryMarks", () => {
    it("applies D9: none, doing, partial, done; doing wins over partial", () => {
        const parsed: PlanScan = scan(DOC);
        const marks = entryMarks(parsed, [
            ...PLAN,
            item(9, "3.1", "split", "done"),
            item(10, "2.1", "split", "done"),
        ]);
        expect(marks.get("1.1")).toEqual({ state: "done", done: 1, total: 1 });
        expect(marks.get("2.1")).toEqual({ state: "doing", done: 1, total: 2 });
        expect(marks.get("2.2")).toEqual({ state: "partial", done: 1, total: 2 });
        expect(marks.get("3.1")).toEqual({ state: "partial", done: 1, total: 2 });
        expect(marks.size).toBe(5);
    });

    it("marks an entry with no linked item none, and titles each mark", () => {
        const marks = entryMarks(scan(DOC), [item(1, "1.1", "`a.ts`", "done")]);
        expect(marks.get("1.2")).toEqual({ state: "none", done: 0, total: 0 });
        expect(markTitle(marks.get("1.1") as never)).toBe("done 1 / 1");
        expect(markTitle({ state: "doing", done: 0, total: 2 })).toBe("doing");
        expect(markTitle({ state: "partial", done: 1, total: 3 })).toBe("partial 1 / 3");
        expect(markTitle({ state: "none", done: 0, total: 0 })).toBeNull();
    });
});

describe("the goal block", () => {
    it("reads the doc on the design track with a named doc, else the mission", () => {
        expect(goalSource(design())).toBe("doc");
        expect(goalSource(design({ doc: null }))).toBe("mission");
        expect(goalSource(design({ track: "direct", stage: null }))).toBe("mission");
        expect(goalSource(undefined)).toBe("mission");
    });

    it("takes the first paragraph of the Overview, joined on one line", () => {
        expect(goalParagraph(DOC)).toBe(
            "The first line of the overview. The second line of the same paragraph.",
        );
        expect(goalParagraph("## Goals\nx")).toBeNull();
        expect(goalParagraph("## Overview\n\n\n## Goals")).toBeNull();
    });
});

describe("questionGroups", () => {
    const question = (
        id: number, answer: string | null, resolved: QuestionItem["resolved"] = null,
    ): QuestionItem => ({
        id, ts: id === 1 ? null : `10:0${id}`, author: "lead", text: `q${id}`, answer, resolved,
    });
    const done = { ts: "10:40", author: "lead", reason: "became Contract 14:15" };

    it("splits open, answered and resolved, each in id order", () => {
        const groups = questionGroups([
            question(4, "10:05 operator: yes", done), question(3, "10:04 operator: no"),
            question(2, null), question(1, null), question(5, null, done),
        ]);
        expect(groups.open.map((item) => item.id)).toEqual([1, 2]);
        expect(groups.answered.map((item) => item.id)).toEqual([3]);
        expect(groups.resolved.map((item) => item.id)).toEqual([4, 5]);
    });

    it("words a resolution, and none for an unresolved question", () => {
        expect(resolutionText(question(5, null, done)))
            .toBe("resolved by lead at 10:40: became Contract 14:15");
        expect(resolutionText(question(6, null, { ts: null, author: null, reason: "moot" })))
            .toBe("resolved: moot");
        expect(resolutionText(question(2, null))).toBeNull();
    });
});
