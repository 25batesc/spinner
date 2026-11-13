// The pure function from design facts to the design stage and its `needs_human`
// (docs/designs/egm-adoption.md, Technical Plan T7, entry 2.9). The facts are the file names
// directly in `<session>/design/`, the first line of the resolve report, the doc's hash and
// the `design` block of `session.yaml`. Nothing here reads the disk, so one fixture per rule
// proves the table, as for `derive_stage`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type {
    DesignApproval,
    DesignGate,
    DesignReviewRun,
    DesignStage,
    ReviewStageId,
} from "@spinner/protocol";
import {
    ASSISTANT_NAME,
    BRIEF_FILE,
    CONSOLIDATED_REPORT,
    DESIGN_FILES_MAX,
    DRAFT_FILE,
    RESOLVE_REPORT,
    REVIEW_REPORT_FILES,
    REVIEW_STAGE_REPORTS,
} from "@spinner/protocol";

/** The first non-empty line of a resolve report that `egm-resolve` Step 5 closed. */
export const RESOLVED_LINE = "Status: resolved";

/** The gate's question is cut to this many characters in `needs_human`. */
const GATE_NEEDS_CHARS_MAX = 80;

export interface DesignInput {
    /** The names directly in `<session>/design/`: the current review run. */
    files: string[];
    /** The first non-empty line of the resolve report, trimmed; null without one. */
    resolve_first_line: string | null;
    /** `design.doc`, repo-relative, or null before `design_doc`. */
    doc: string | null;
    /** `normalized_doc_hash` of the doc now, or null when it is missing or unset. */
    doc_hash: string | null;
    doc_missing: boolean;
    approved: DesignApproval | null;
    review_run: DesignReviewRun | null;
    gate: DesignGate | null;
    /** The lead's last assistant text ends with `?` (build session 3 fills it). */
    waiting: boolean;
    /** The lead runs a turn (build session 3 fills it). */
    lead_busy: boolean;
    /** Goldfish of the session in state `running` (build session 4 fills it). */
    goldfish_running: number;
}

export interface DesignResult {
    stage: DesignStage;
    needs: string | null;
    changed_after_approval: boolean;
    reviews: Record<ReviewStageId, boolean>;
    consolidated: boolean;
    resolve: "none" | "open" | "resolved";
}

export function derive_design(input: DesignInput): DesignResult {
    assert.ok(input.files.length <= DESIGN_FILES_MAX, `more than ${DESIGN_FILES_MAX} files`);
    assert.ok(input.goldfish_running >= 0, "goldfish_running must not be negative");
    const files = new Set(input.files);
    const reviews = review_flags(files);
    const consolidated = files.has(CONSOLIDATED_REPORT);
    const resolve = resolve_state(files, input.resolve_first_line);
    const changed_after_approval = input.approved !== null && !doc_matches(input);
    const stage = design_stage(input, files, resolve);
    const needs = design_needs(input, stage, changed_after_approval);
    return { stage, needs, changed_after_approval, reviews, consolidated, resolve };
}

/** The rule table of T7, rows 1 to 8; the first match wins. */
function design_stage(
    input: DesignInput,
    files: Set<string>,
    resolve: DesignResult["resolve"],
): DesignStage {
    if (input.approved !== null && doc_matches(input)) {
        return "approved";
    }
    if (resolve === "open") {
        return "resolving";
    }
    if (input.doc !== null) {
        if (review_concluded(input, files)) {
            return "design-ready";
        }
        if (REVIEW_REPORT_FILES.some((name) => files.has(name))) {
            return "design-review";
        }
        return "drafted";
    }
    if (files.has(DRAFT_FILE)) {
        return "drafting";
    }
    if (files.has(BRIEF_FILE)) {
        return "brainstorm";
    }
    return "intake";
}

/**
 * Row 3: a consolidated or a readiness report ends a review. The stage 8 report ends it only
 * for the `feature_spec` preset, or when no run is recorded (a review typed in the terminal).
 */
function review_concluded(input: DesignInput, files: Set<string>): boolean {
    if (files.has(CONSOLIDATED_REPORT) || files.has(REVIEW_STAGE_REPORTS["9"])) {
        return true;
    }
    if (!files.has(REVIEW_STAGE_REPORTS["8"])) {
        return false;
    }
    return input.review_run === null || input.review_run.preset === "feature_spec";
}

/**
 * The `needs_human` list of T7. Line 1 (an open gate) applies at every stage; lines 2 to 7
 * apply only before approval. At `approved` without a gate the result is null.
 */
function design_needs(
    input: DesignInput,
    stage: DesignStage,
    changed_after_approval: boolean,
): string | null {
    if (input.gate !== null) {
        const question = input.gate.question.slice(0, GATE_NEEDS_CHARS_MAX);
        return `answer ${ASSISTANT_NAME}: ${question}`;
    }
    if (stage === "approved") {
        return null;
    }
    if (stage === "resolving" && !input.lead_busy) {
        return "resolve the review findings";
    }
    if (input.waiting && !input.lead_busy && input.goldfish_running === 0) {
        return `reply to the lead (${stage})`;
    }
    if (input.doc !== null && input.doc_missing) {
        return `the design doc ${input.doc} is missing from the worktree`;
    }
    if (changed_after_approval) {
        return "re-approve the design (changed since approval)";
    }
    if (stage === "drafted") {
        return "review the design";
    }
    if (stage === "design-ready") {
        return "approve the design";
    }
    return null;
}

/** A missing doc never matches, so it counts as changed after approval. */
function doc_matches(input: DesignInput): boolean {
    if (input.approved === null || input.doc_missing || input.doc_hash === null) {
        return false;
    }
    return input.doc_hash === input.approved.sha256;
}

function review_flags(files: Set<string>): Record<ReviewStageId, boolean> {
    return {
        "5": files.has(REVIEW_STAGE_REPORTS["5"]),
        "6": files.has(REVIEW_STAGE_REPORTS["6"]),
        "7": files.has(REVIEW_STAGE_REPORTS["7"]),
        "8": files.has(REVIEW_STAGE_REPORTS["8"]),
        "9": files.has(REVIEW_STAGE_REPORTS["9"]),
    };
}

function resolve_state(files: Set<string>, first_line: string | null): DesignResult["resolve"] {
    if (!files.has(RESOLVE_REPORT)) {
        return "none";
    }
    return first_line === RESOLVED_LINE ? "resolved" : "open";
}

/**
 * SHA-256 hex of the doc after two steps: `\r\n` becomes `\n`, and the first line that
 * matches `^\*\s+\*\*Status:\*\*` is removed. The approve route rewrites that line, so the
 * hash must not see it.
 */
export function normalized_doc_hash(text: string): string {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const status = lines.findIndex((line) => /^\*\s+\*\*Status:\*\*/.test(line));
    if (status >= 0) {
        lines.splice(status, 1);
    }
    return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}
