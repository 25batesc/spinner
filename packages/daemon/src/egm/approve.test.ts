// Goal: the pure parts of approval (docs/designs/egm-adoption.md, 6.2, 6.3) follow their
// rules: `count_listed_blockers` on the three report layouts EGM writes, a fenced heading and
// a report with neither layout; the `Status:` rewrite; the build message. Method: fixture
// texts in the layouts of `egm-resolve`, the synthesizer and `egm-review`'s cross-stage
// synthesis. The approval itself (the 409s, the seed, the record, the copy, the Log lines,
// the prompt) runs through the routes in `routes.test.ts`, which has the session, the
// worktree and the recording lead.
import { describe, expect, it } from "vitest";
import { build_message, count_listed_blockers, rewrite_status } from "./approve.js";

const RESOLVE_LAYOUT = [
    "# Goldfish review report",
    "",
    "### [Issue 1] [zoom_out] - Severity: High",
    "Text.",
    "### [Issue 2] [critic] - Severity: High",
    "### [Issue 3] [style] - Severity: high",
    "### [Issue 4] [style] - Severity: Low",
].join("\n");

const SYNTHESIZER_LAYOUT = [
    "# Consolidated review",
    "## Findings",
    "### Missing rollback - Severity: Blocker",
    "### Unbounded queue - Severity: Blocker",
    "### Naming - Severity: Major",
].join("\n");

const SECTION_LAYOUT = [
    "# Consolidated review",
    "## 🔴 Blockers",
    "### No migration plan",
    "Text with a #### inline mention.",
    "#### Detail (a level below the findings; not counted)",
    "### The approval hash ignores the status line",
    "## 🟡 Majors",
    "### One",
    "### Two",
    "### Three",
].join("\n");

const FENCED = [
    "# Report",
    "```markdown",
    "### Example - Severity: Blocker",
    "## Blockers",
    "### Inside the fence",
    "```",
    "## Notes",
].join("\n");

describe("count_listed_blockers (6.2)", () => {
    it("counts Severity: High headings in the resolve layout", () => {
        expect(count_listed_blockers(RESOLVE_LAYOUT)).toBe(3);
    });

    it("counts Severity: Blocker headings and not Major in the synthesizer layout", () => {
        expect(count_listed_blockers(SYNTHESIZER_LAYOUT)).toBe(2);
    });

    it("counts the headings one level below a 🔴 Blockers section", () => {
        expect(count_listed_blockers(SECTION_LAYOUT)).toBe(2);
        const level_three = "## Review\n### Blockers\n#### A\n#### B\n#### C\n### Majors\n#### D\n";
        expect(count_listed_blockers(level_three)).toBe(3);
    });

    it("skips headings inside a code fence", () => {
        expect(count_listed_blockers(FENCED)).toBe(0);
    });

    it("answers 0 for a report with neither layout", () => {
        const plain = "# Report\n## Summary\nAll good.\n### Severity notes\nLow only.\n";
        expect(count_listed_blockers(plain)).toBe(0);
        expect(count_listed_blockers("")).toBe(0);
    });

    it("prefers severity mode when a report has both layouts", () => {
        const both = `${SECTION_LAYOUT}\n### Extra - Severity: Blocker\n`;
        expect(count_listed_blockers(both)).toBe(1);
    });
});

describe("rewrite_status and build_message (6.2)", () => {
    it("rewrites the first Status line to Approved and leaves a doc without one", () => {
        const doc = "# CSV\n\n*   **Author:** a\n*   **Status:** Reviewed\n\n## Overview\n";
        expect(rewrite_status(doc)).toBe(
            "# CSV\n\n*   **Author:** a\n*   **Status:** Approved\n\n## Overview\n",
        );
        const plain = "# CSV\n\nStatus: Draft\n## Overview\n";
        expect(rewrite_status(plain)).toBe(plain);
    });

    it("names the doc, the hash prefix, the token, the #id convention and Open questions", () => {
        const seed = {
            doc_path: "docs/designs/csv.md",
            sha12: "0123456789ab",
            added: 23,
            kept: 2,
            stale: [],
            orphaned: [],
        };
        const path = "/s/worktrees/web/docs/designs/csv.md";
        const text = build_message(path, "0123456789abcdef", seed);
        const head = "The design is approved: /s/worktrees/web/docs/designs/csv.md";
        expect(text.startsWith(`${head} (sha256 0123456789ab).`)).toBe(true);
        expect(text).toContain("one item per plan entry (23 added, 2 kept)");
        expect(text).toContain("`[n.n]` token");
        expect(text).toContain("mission_plan add and `entry: \"n.n\"`");
        expect(text).toContain("Roster Doing cell names `#id`");
        expect(text).toContain("goes under Open questions with the entry id");
        expect(text).not.toContain("add one MISSION.md Plan item per");
        expect(text).not.toContain("plan <id>:");
        expect(text).toContain("ask the operator to re-approve; the seed runs again.");
        const flagged = build_message("/d.md", "0123456789abcdef", {
            ...seed,
            stale: ["2.4"],
            orphaned: ["3.9"],
        });
        expect(flagged).toContain("stale (2.4) or orphaned (3.9)");
        expect(flagged).toContain("mission_plan edit and a new token");
    });
});
