// The design workspace's rules (entry 5.12). Method: each case builds the `DesignView` or the
// `SessionView` facts the daemon sends and reads what a tab shows: the view tabs and the
// default tab per track, the stepper's tabs, the reload key, the doc's sections and outline
// (a heading inside a code fence stays text), the Review rows of the current and of an
// archived run, the rounds and the approvals of History, newest first, with their marks.
import type { DesignApproval, DesignView, RoundView, SessionView } from "@spinner/protocol";
import { describe, expect, it } from "vitest";

import {
    approvalRows, defaultTab, docSections, docSource, outline, reloadKey, revisionText,
    roundRows, shownView, sizeLabel, stageRows, stepTab, viewTabs,
} from "./design-workspace.ts";

function design(partial: Partial<DesignView> = {}): DesignView {
    return {
        track: "design", stage: "drafted", files: [],
        reviews: { "5": false, "6": false, "7": false, "8": false, "9": false },
        consolidated: false, resolve: "none", review_run: null, doc: null, doc_missing: false,
        approved: null, approvals: [], changed_after_approval: false, gate: null, goldfish: [],
        goldfish_live: 0, cost_by_stage: {}, ...partial,
    };
}

function session(
    partial: { design?: DesignView; round?: number; rounds?: RoundView[] } = {},
): SessionView {
    return {
        summary: { dir: "s1-csv", session: { branch: "feat/csv-export-r3" } },
        ...partial,
    } as unknown as SessionView;
}

const file = (name: string, mtime: string) => ({ name, bytes: 2048, mtime });

describe("the view tabs", () => {
    it("adds design after agents only for a session with a design block", () => {
        expect(viewTabs(session({ design: design() }))).toEqual(
            ["agents", "design", "mission", "threads", "services"],
        );
        expect(viewTabs(session())).toEqual(["agents", "mission", "threads", "services"]);
        expect(viewTabs(undefined)).toEqual(["agents", "mission", "threads", "services"]);
    });

    it("falls back to agents when the session has no design view", () => {
        expect(shownView(session({ design: design() }), "design")).toBe("design");
        expect(shownView(session(), "design")).toBe("agents");
        expect(shownView(session(), "threads")).toBe("threads");
    });

    it("opens on Brief on the design track and on Files on the direct track", () => {
        expect(defaultTab(design())).toBe("brief");
        expect(defaultTab(design({ track: "direct", stage: null }))).toBe("files");
    });

    it("maps each stepper step to its tab", () => {
        expect(stepTab("brainstorm")).toBe("brief");
        expect(stepTab("draft")).toBe("design");
        expect(stepTab("review")).toBe("review");
        expect(stepTab("approve")).toBe("design");
    });
});

describe("reloadKey", () => {
    it("moves with the newest file time and with the doc path", () => {
        const older = design({ files: [file("a.md", "2026-10-20T10:00:00Z")] });
        const newer = design({
            files: [file("a.md", "2026-10-20T10:00:00Z"), file("b.md", "2026-10-20T11:00:00Z")],
        });
        expect(reloadKey("s1", older)).toBe("s1#2026-10-20T10:00:00Z#");
        expect(reloadKey("s1", newer)).toBe("s1#2026-10-20T11:00:00Z#");
        expect(reloadKey("s1", design({ doc: "docs/designs/x.md" }))).toBe(
            "s1##docs/designs/x.md",
        );
    });
});

describe("docSource", () => {
    it("shows the doc once named, else the draft, else nothing", () => {
        expect(docSource(design({ doc: "docs/designs/csv-export.md" }))).toEqual({
            kind: "doc", name: "csv-export.md", path: "docs/designs/csv-export.md",
        });
        const drafted = design({ files: [file("design_draft.md", "2026-10-20T10:00:00Z")] });
        expect(docSource(drafted)).toEqual({ kind: "draft", name: "design_draft.md" });
        expect(docSource(design())).toBeNull();
    });
});

describe("docSections and outline", () => {
    const doc = [
        "# CSV export",
        "Intro line.",
        "",
        "## Overview",
        "Text.",
        "```md",
        "## Not a heading",
        "```",
        "## Decisions ##",
        "### Sub",
        "More.",
    ].join("\n");

    it("cuts at each ## heading outside a fence, and joined back the parts are the doc", () => {
        const sections = docSections(doc);
        expect(sections.map((section) => section.heading)).toEqual(
            [null, "Overview", "Decisions"],
        );
        expect(sections.map((section) => section.text).join("\n")).toBe(doc);
        expect(sections[1]?.text).toContain("## Not a heading");
    });

    it("lists the ## headings in order, without the preamble", () => {
        expect(outline(doc)).toEqual(["Overview", "Decisions"]);
        expect(outline("no headings")).toEqual([]);
    });

    it("leaves out an empty preamble", () => {
        expect(docSections("## A\nx").map((section) => section.heading)).toEqual(["A"]);
    });

    it("words the revision request as the entry says", () => {
        expect(revisionText("Overview", "csv-export.md", "Name the row cap.")).toBe(
            'Revision request for "Overview" in csv-export.md: Name the row cap.',
        );
    });
});

describe("stageRows", () => {
    it("lists stages 5 to 9 with written from design.reviews, reports when present", () => {
        const current = design({
            reviews: { "5": true, "6": true, "7": false, "8": false, "9": false },
            consolidated: true, resolve: "open",
        });
        const rows = stageRows(current);
        expect(rows.map((row) => [row.id, row.file, row.written])).toEqual([
            ["5", "zoom_out_report.md", true],
            ["6", "comprehension_report.md", true],
            ["7", "critic_report.md", false],
            ["8", "intermediate_zoom_out_report.md", false],
            ["9", "implementation_readiness_report.md", false],
            ["consolidated", "consolidated_review_report.md", true],
            ["resolve", "goldfish_review_report.md", true],
        ]);
        expect(rows[0]?.label).toBe("5 Zoom out");
    });

    it("hides the consolidated and resolve rows until the current run has them", () => {
        expect(stageRows(design()).map((row) => row.id)).toEqual(["5", "6", "7", "8", "9"]);
    });

    it("lists every row of an archived run with written unknown", () => {
        const rows = stageRows(design(), false);
        expect(rows).toHaveLength(7);
        expect(rows.every((row) => row.written === null)).toBe(true);
    });
});

describe("History", () => {
    const record = (round: number): RoundView => ({
        round, branch: `feat/csv-r${round}`, source: "record", prs: [],
        started: null, ended: null,
    });

    it("heads the rounds with the current one, then the earlier ones newest first", () => {
        const rows = roundRows(session({ round: 3, rounds: [record(1), record(2)] }));
        expect(rows.map((row) => [row.round, row.current, row.branch])).toEqual([
            [3, true, "feat/csv-export-r3"],
            [2, false, "feat/csv-r2"],
            [1, false, "feat/csv-r1"],
        ]);
    });

    it("reads a daemon without rounds as round 1 alone", () => {
        expect(roundRows(session()).map((row) => row.round)).toEqual([1]);
    });

    const first: DesignApproval = {
        path: "docs/designs/csv-export.md", repo: "web", sha256: "aaa", at: "2026-10-14T10:00:00Z",
        blockers: 2, round: 1,
    };
    const second: DesignApproval = {
        ...first, sha256: "bbb", at: "2026-10-18T10:00:00Z", round: 2,
    };

    it("lists approvals newest first and marks the standing one current", () => {
        const rows = approvalRows(design({ approvals: [first, second], approved: second }));
        expect(rows.map((row) => [row.approval.sha256, row.mark])).toEqual(
            [["bbb", "current"], ["aaa", null]],
        );
    });

    it("marks the standing approval invalidated after a change", () => {
        const rows = approvalRows(design({
            approvals: [first, second], approved: second, changed_after_approval: true,
        }));
        expect(rows.map((row) => row.mark)).toEqual(["invalidated", null]);
    });

    it("marks none without a standing approval", () => {
        const rows = approvalRows(design({ approvals: [first] }));
        expect(rows.map((row) => row.mark)).toEqual([null]);
    });
});

it("labels sizes in bytes and kilobytes", () => {
    expect(sizeLabel(812)).toBe("812 B");
    expect(sizeLabel(4096)).toBe("4.0 KB");
});
