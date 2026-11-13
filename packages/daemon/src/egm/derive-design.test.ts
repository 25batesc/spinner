// Goal: prove that `derive_design` implements every row of the design stage table and every
// line of the `needs_human` list in docs/designs/egm-adoption.md, Technical Plan T7, and that
// `normalized_doc_hash` ignores the Status line and line endings (entry 2.10). Method: one
// input fixture per row and per line, built from an empty baseline, changing only what the
// row names.
import { describe, expect, it } from "vitest";
import type { DesignApproval } from "@spinner/protocol";
import { derive_design, normalized_doc_hash, type DesignInput } from "./derive-design.js";

const DOC = "docs/designs/csv-export.md";
const HASH = "a".repeat(64);

function input(overrides: Partial<DesignInput> = {}): DesignInput {
    return {
        files: [],
        resolve_first_line: null,
        doc: null,
        doc_hash: null,
        doc_missing: false,
        approved: null,
        review_run: null,
        gate: null,
        waiting: false,
        lead_busy: false,
        goldfish_running: 0,
        ...overrides,
    };
}

/** A named doc whose hash is `HASH`. */
function named(overrides: Partial<DesignInput> = {}): DesignInput {
    return input({ doc: DOC, doc_hash: HASH, ...overrides });
}

const approval: DesignApproval = {
    path: DOC,
    repo: "web",
    sha256: HASH,
    at: "2026-11-04T11:40:00Z",
    blockers: 0,
    round: 1,
};

describe("derive_design: one row of the stage table per test", () => {
    it("8 intake: no file and no doc", () => {
        expect(derive_design(input())).toMatchObject({ stage: "intake", needs: null });
    });

    it("7 brainstorm: the concepts brief exists", () => {
        const result = derive_design(input({ files: ["concepts_brief.md"] }));
        expect(result).toMatchObject({ stage: "brainstorm", needs: null });
    });

    it("6 drafting: the draft exists", () => {
        const files = ["concepts_brief.md", "design_draft.md"];
        expect(derive_design(input({ files })).stage).toBe("drafting");
    });

    it("5 drafted: the doc is named", () => {
        const result = derive_design(named({ files: ["design_draft.md"] }));
        expect(result).toMatchObject({ stage: "drafted", needs: "review the design" });
    });

    it("4 design-review: the doc is named and one review report exists", () => {
        const result = derive_design(named({ files: ["zoom_out_report.md"] }));
        expect(result).toMatchObject({ stage: "design-review", needs: null });
        const reviews = { "5": true, "6": false, "7": false, "8": false, "9": false };
        expect(result.reviews).toEqual(reviews);
        expect(derive_design(input({ files: ["zoom_out_report.md"] })).stage).toBe("intake");
    });

    it("3 design-ready: a consolidated or a readiness report", () => {
        const consolidated = derive_design(named({ files: ["consolidated_review_report.md"] }));
        expect(consolidated).toMatchObject({
            stage: "design-ready",
            needs: "approve the design",
            consolidated: true,
        });
        const readiness = derive_design(named({ files: ["implementation_readiness_report.md"] }));
        expect(readiness.stage).toBe("design-ready");
        expect(readiness.reviews["9"]).toBe(true);
    });

    it("3 design-ready: the stage 8 report ends a feature_spec run or an unrecorded run", () => {
        const files = ["zoom_out_report.md", "intermediate_zoom_out_report.md"];
        const run = (preset: "feature_spec" | "interactive") => ({
            id: "r1",
            preset,
            started: "2026-11-04T10:00:00Z",
        });
        expect(derive_design(named({ files, review_run: run("feature_spec") })).stage).toBe(
            "design-ready",
        );
        expect(derive_design(named({ files, review_run: run("interactive") })).stage).toBe(
            "design-review",
        );
        expect(derive_design(named({ files, review_run: null })).stage).toBe("design-ready");
    });

    it("2 resolving: the resolve report is open, and resolved once Step 5 marks it", () => {
        const files = ["consolidated_review_report.md", "goldfish_review_report.md"];
        const open = derive_design(named({ files, resolve_first_line: "# Resolve report" }));
        expect(open).toMatchObject({
            stage: "resolving",
            resolve: "open",
            needs: "resolve the review findings",
        });
        const resolved = derive_design(named({ files, resolve_first_line: "Status: resolved" }));
        expect(resolved).toMatchObject({ stage: "design-ready", resolve: "resolved" });
        expect(derive_design(named()).resolve).toBe("none");
    });

    it("1 approved: the approval's hash equals the doc's hash", () => {
        const files = ["consolidated_review_report.md"];
        const result = derive_design(named({ files, approved: approval }));
        expect(result).toMatchObject({
            stage: "approved",
            needs: null,
            changed_after_approval: false,
        });
    });
});

describe("derive_design: the needs_human list", () => {
    const asked = "2026-11-04T10:12:00Z";
    const gate = { question: `${"Q".repeat(90)}?`, options: ["a", "b"], asked };

    it("1 an open gate, at every stage, cut to 80 characters", () => {
        const needs = `answer Remy: ${"Q".repeat(80)}`;
        expect(derive_design(input({ gate })).needs).toBe(needs);
        const approved = named({ files: ["critic_report.md"], approved: approval, gate });
        expect(derive_design(approved)).toMatchObject({ stage: "approved", needs });
    });

    it("2 resolving waits for the lead to settle", () => {
        const files = ["goldfish_review_report.md"];
        const busy = derive_design(named({ files, lead_busy: true }));
        expect(busy).toMatchObject({ stage: "resolving", needs: null });
        const settled = derive_design(named({ files, waiting: true }));
        expect(settled).toMatchObject({ stage: "resolving", needs: "resolve the review findings" });
    });

    it("3 the lead waits on a question, unless a Goldfish runs", () => {
        const draft = input({ files: ["design_draft.md"], waiting: true });
        expect(derive_design(draft).needs).toBe("reply to the lead (drafting)");
        expect(derive_design({ ...draft, goldfish_running: 1 }).needs).toBeNull();
        expect(derive_design({ ...draft, lead_busy: true }).needs).toBeNull();
    });

    it("4 a missing doc with an approval counts as changed", () => {
        const files = ["consolidated_review_report.md"];
        const missing = named({ files, doc_hash: null, doc_missing: true, approved: approval });
        expect(derive_design(missing)).toMatchObject({
            stage: "design-ready",
            needs: `the design doc ${DOC} is missing from the worktree`,
            changed_after_approval: true,
        });
    });

    it("5 a doc changed after approval is design-ready and asks for re-approval", () => {
        const files = ["consolidated_review_report.md"];
        const changed = named({ files, doc_hash: "b".repeat(64), approved: approval });
        expect(derive_design(changed)).toMatchObject({
            stage: "design-ready",
            needs: "re-approve the design (changed since approval)",
            changed_after_approval: true,
        });
    });

    it("6 drafted and 7 design-ready name the next click; 8 otherwise null", () => {
        expect(derive_design(named()).needs).toBe("review the design");
        const ready = named({ files: ["consolidated_review_report.md"] });
        expect(derive_design(ready).needs).toBe("approve the design");
        expect(derive_design(input({ files: ["design_draft.md"] })).needs).toBeNull();
    });

    it("refuses more than DESIGN_FILES_MAX files", () => {
        const files = Array.from({ length: 201 }, (_, index) => `f${index}.md`);
        expect(() => derive_design(input({ files }))).toThrow(/more than 200/);
    });
});

describe("normalized_doc_hash", () => {
    it("ignores the Status line and CRLF line endings", () => {
        const draft = "# T\n\n*   **Status:** Reviewed\n*   **Version:** 3\n\nBody.\n";
        const approved =
            "# T\r\n\r\n*   **Status:** Approved\r\n*   **Version:** 3\r\n\r\nBody.\r\n";
        expect(normalized_doc_hash(draft)).toBe(normalized_doc_hash(approved));
        expect(normalized_doc_hash(draft)).toMatch(/^[0-9a-f]{64}$/);
        expect(normalized_doc_hash(draft)).not.toBe(normalized_doc_hash(`${draft}More.\n`));
    });
});
