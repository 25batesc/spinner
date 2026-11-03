// Goal: the PR body of a session with an approved design carries the doc's Overview and Goals
// and names the doc, never the whole doc, and the Slack line is the Overview's first sentence
// (docs/designs/egm-adoption.md, entry 6.8). Method: the pure functions on doc texts with and
// without each section; `approved_doc_of` on summaries with and without an approval.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Session, SessionSummary } from "@spinner/protocol";
import { resolve_home } from "../home.js";
import { create_session } from "../store/session-store.js";
import {
    OVERVIEW_LINE_CHARS_MAX,
    approved_doc_of,
    overview_line,
    pr_body_from_design,
} from "./pr-body.js";

const DOC = [
    "# CSV export",
    "",
    "*   **Status:** Approved",
    "",
    "## Overview",
    "",
    "Operators export a report as CSV. The export runs in the browser.",
    "No server change.",
    "",
    "## Goals",
    "",
    "*   One click exports the table.",
    "*   The file opens in a spreadsheet.",
    "",
    "## The Problem",
    "",
    "Secret problem text that stays out of the PR.",
    "",
].join("\n");

describe("pr_body_from_design", () => {
    it("carries the Overview body, the Goals list, the doc line and the session line", () => {
        const body = pr_body_from_design(DOC, "docs/designs/csv-export.md", "s042");
        expect(body).toBe(
            [
                "Operators export a report as CSV. The export runs in the browser.",
                "No server change.",
                "",
                "## Goals",
                "*   One click exports the table.",
                "*   The file opens in a spreadsheet.",
                "",
                "Design: `docs/designs/csv-export.md` (drafted with EGM)",
                "",
                "Spinner session s042",
                "",
            ].join("\n"),
        );
        expect(body).not.toContain("Secret problem text");
        expect(body).not.toContain("Status:");
    });

    it("skips a missing Overview", () => {
        const doc = DOC.replace(/## Overview[\s\S]*?(?=## Goals)/u, "");
        const body = pr_body_from_design(doc, "d.md", "s1");
        expect(body.startsWith("## Goals\n")).toBe(true);
        expect(body).not.toContain("Operators export");
    });

    it("skips missing Goals", () => {
        const doc = DOC.replace(/## Goals[\s\S]*?(?=## The Problem)/u, "");
        const body = pr_body_from_design(doc, "d.md", "s1");
        expect(body).not.toContain("## Goals");
        expect(body).toContain("No server change.\n\nDesign: `d.md` (drafted with EGM)");
    });

    it("gives only the doc and session lines for a doc with neither section", () => {
        const body = pr_body_from_design("# Title\n\n## Other\n\ntext\n", "d.md", "s1");
        expect(body).toBe("Design: `d.md` (drafted with EGM)\n\nSpinner session s1\n");
    });

    it("does not end a section at a heading inside a code fence", () => {
        const doc = [
            "## Overview",
            "Intro.",
            "```markdown",
            "## Not a heading",
            "```",
            "After the fence.",
            "## Goals",
            "*   G.",
        ].join("\n");
        const body = pr_body_from_design(doc, "d.md", "s1");
        expect(body).toContain("## Not a heading\n```\nAfter the fence.\n\n## Goals\n*   G.");
    });

    it("keeps `###` subsections inside the Overview body", () => {
        const doc = "## Overview\nIntro.\n### Glossary\nTerm.\n## Goals\n*   G.\n";
        expect(pr_body_from_design(doc, "d.md", "s1")).toContain("Intro.\n### Glossary\nTerm.");
    });
});

describe("overview_line", () => {
    it("is the first sentence of the Overview", () => {
        expect(overview_line(DOC)).toBe("Operators export a report as CSV.");
    });

    it("joins a sentence that spans lines", () => {
        const doc = "## Overview\n\nOne sentence\nover two lines. Second.\n";
        expect(overview_line(doc)).toBe("One sentence over two lines.");
    });

    it("is the whole first paragraph when it has no sentence end", () => {
        const doc = "## Overview\nNo full stop here\n\nNext.\n";
        expect(overview_line(doc)).toBe("No full stop here");
    });

    it("cuts a long sentence at the limit", () => {
        const long = `${"word ".repeat(80)}end.`;
        const line = overview_line(`## Overview\n${long}\n`);
        expect(line.length).toBeLessThanOrEqual(OVERVIEW_LINE_CHARS_MAX);
        expect(line.endsWith("\u2026")).toBe(true);
        expect(line.startsWith("word word")).toBe(true);
    });

    it("keeps a sentence of exactly the limit", () => {
        const exact = `${"a".repeat(OVERVIEW_LINE_CHARS_MAX - 1)}.`;
        expect(overview_line(`## Overview\n${exact}\n`)).toBe(exact);
    });

    it("is empty without an Overview", () => {
        expect(overview_line("# T\n\n## Goals\n*   G.\n")).toBe("");
    });
});

describe("approved_doc_of", () => {
    const approved = {
        path: "docs/designs/t.md",
        repo: "web",
        sha256: "ab",
        at: "2026-11-03T00:00:00Z",
        blockers: 0,
        round: 1,
    };

    function summary_with(design: Session["design"]): SessionSummary {
        const root = mkdtempSync(join(tmpdir(), "spinner-pr-body-"));
        const home = resolve_home({ SPINNER_HOME: join(root, "h") });
        const created = create_session(home, { title: "Doc paths" });
        const repos = { web: { path: "~/code/web", changed: true, worktree: "repos/web" } };
        return { ...created, session: { ...created.session, repos, design } };
    }

    it("is null without an approval", () => {
        expect(approved_doc_of(summary_with(undefined))).toBeNull();
        const design = { track: "design" as const, doc: "docs/designs/t.md", repo: "web" };
        expect(approved_doc_of(summary_with(design))).toBeNull();
    });

    it("joins the session, the repo's worktree and the doc path", () => {
        const summary = summary_with({ track: "design", approved });
        expect(approved_doc_of(summary)).toEqual({
            path: "docs/designs/t.md",
            absolute: join(summary.path, "repos/web/docs/designs/t.md"),
        });
    });

    it("is null when the doc's repo has no worktree", () => {
        const summary = summary_with({ track: "design", approved: { ...approved, repo: "api" } });
        expect(approved_doc_of(summary)).toBeNull();
    });
});
