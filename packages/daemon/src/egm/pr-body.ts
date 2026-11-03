// The PR body and the Slack summary line of a session with an approved design doc
// (docs/designs/egm-adoption.md, entries 6.8 to 6.10). The PR carries the doc's Overview and
// Goals, never the whole doc, and names the doc's path, so a reviewer reads the design from
// the tree. Pure functions over the doc text; `pipeline/pr.ts` and `pipeline/post.ts` read
// the file and fall back to the mission when the session has no approved doc.
import assert from "node:assert/strict";
import { join } from "node:path";
import type { SessionSummary } from "@spinner/protocol";

/** Upper bound on the summary line's length, in characters. */
export const OVERVIEW_LINE_CHARS_MAX = 200;

/** Upper bound on `## ` sections in one doc; the design template has about 12. */
const SECTIONS_MAX = 200;

const FENCE = /^```/u;

/**
 * The PR body: the `## Overview` body, then `## Goals` with its list, then the line that
 * names the doc, then the session line. A missing section is skipped.
 */
export function pr_body_from_design(doc: string, doc_path: string, session_id: string): string {
    assert.ok(doc_path.length > 0, "the PR body names the doc");
    assert.ok(session_id.length > 0, "the PR body names the session");
    const overview = doc_section(doc, "Overview");
    const goals = doc_section(doc, "Goals");
    const parts: string[] = [];
    if (overview.length > 0) {
        parts.push(overview, "");
    }
    if (goals.length > 0) {
        parts.push("## Goals", goals, "");
    }
    parts.push(`Design: \`${doc_path}\` (drafted with EGM)`, "");
    parts.push(`Spinner session ${session_id}`, "");
    return parts.join("\n");
}

/** The first sentence of `## Overview`, cut at `OVERVIEW_LINE_CHARS_MAX`; "" without one. */
export function overview_line(doc: string): string {
    const overview = doc_section(doc, "Overview");
    const paragraph = overview.split(/\n\s*\n/u)[0] ?? "";
    const text = paragraph
        .split("\n")
        .map((line) => line.trim())
        .join(" ")
        .trim();
    const sentence = /^.*?[.!?](?=\s|$)/u.exec(text)?.[0] ?? text;
    if (sentence.length <= OVERVIEW_LINE_CHARS_MAX) {
        return sentence;
    }
    const cut = `${sentence.slice(0, OVERVIEW_LINE_CHARS_MAX - 1).trimEnd()}\u2026`;
    assert.ok(cut.length <= OVERVIEW_LINE_CHARS_MAX);
    return cut;
}

/** The approved doc of a session: its repo-relative path and its absolute path. */
export interface ApprovedDoc {
    path: string;
    absolute: string;
}

/**
 * Where the approved doc lives in the session: the worktree of `design.approved.repo` and
 * `design.approved.path`. Null without an approval, or when that repo has no worktree.
 */
export function approved_doc_of(summary: SessionSummary): ApprovedDoc | null {
    const approved = summary.session.design?.approved;
    if (approved === undefined) {
        return null;
    }
    const worktree = summary.session.repos[approved.repo]?.worktree;
    if (worktree === undefined) {
        return null;
    }
    return { path: approved.path, absolute: join(summary.path, worktree, approved.path) };
}

/**
 * The body of the `## <heading>` section, trimmed, up to the next `## ` or `# ` heading;
 * "" when absent. Lines inside fenced code blocks never start or end a section.
 */
function doc_section(doc: string, heading: string): string {
    const lines = doc.split("\n");
    let fenced = false;
    let inside = false;
    let sections = 0;
    const body: string[] = [];
    for (const line of lines) {
        const is_heading = !fenced && /^#{1,2}\s/u.test(line);
        if (FENCE.test(line)) {
            fenced = !fenced;
        }
        if (is_heading) {
            sections += 1;
            assert.ok(sections <= SECTIONS_MAX, `more than ${SECTIONS_MAX} sections in the doc`);
            if (inside) {
                break;
            }
            inside = line.replace(/^#{1,2}\s+/u, "").trim() === heading && line.startsWith("## ");
            continue;
        }
        if (inside) {
            body.push(line);
        }
    }
    return body.join("\n").trim();
}
