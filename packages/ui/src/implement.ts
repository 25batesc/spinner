// The Implement view's rules (docs/designs/session-workspace.md, T6, T7, D4, D9, D14): where
// the goal block reads from, how the Plan groups by the doc's phases, the view's state and
// header text, the rail's live dot per agent, and the mark of each doc entry. Everything here
// is pure over `MissionView`, the doc's `PlanScan` and the facts of `SessionView`; the
// component renders what these return.
import type {
    AgentSpec, DesignView, PlanItem, PlanScan, QuestionItem,
} from "@spinner/protocol";

import { agentState } from "./agent-view.ts";
import { docSections } from "./design-workspace.ts";

/** About four lines of the goal block at its narrowest useful width. */
export const GOAL_CLAMP_CHARS = 280;

/** Where the goal block reads from (D4): the doc on the design track with a named doc. */
export function goalSource(design: DesignView | undefined): "doc" | "mission" {
    if (design !== undefined && design.track === "design" && design.doc !== null) {
        return "doc";
    }
    return "mission";
}

/**
 * The first paragraph of the doc's `## Overview` (D4), or null without one. A paragraph ends
 * at the first blank line after its first line of text; the heading line is left out.
 */
export function goalParagraph(text: string): string | null {
    const overview = docSections(text).find((section) => section.heading === "Overview");
    if (overview === undefined) {
        return null;
    }
    const lines = overview.text.split("\n").slice(1);
    const paragraph: string[] = [];
    for (const line of lines) {
        if (line.trim() === "") {
            if (paragraph.length > 0) {
                break;
            }
            continue;
        }
        paragraph.push(line.trim());
    }
    return paragraph.length === 0 ? null : paragraph.join(" ");
}

/** One row of the phase list: a Plan item with its badges. */
export interface PlanRow {
    item: PlanItem;
    /** The item's entry is not in the doc. */
    orphan: boolean;
    /** The item's entry is in the doc with another title. */
    stale: boolean;
}

/** One collapsible section of the phase list. */
export interface PhaseGroup {
    /** `phase-1`, `other`, `plan`. */
    id: string;
    /** `Build session 1: the engine`, `Other`, `Plan`. */
    label: string;
    rows: PlanRow[];
    done: number;
    doing: number;
    total: number;
    /** Open by default: it holds a doing row, or it is the first with an open row. */
    open: boolean;
}

const STATE_ORDER: Record<PlanItem["state"], number> = { doing: 0, next: 1, done: 2 };

/** Inside a group: `doing` rows first, then `next`, then `done`, each in id order. */
function sortRows(rows: PlanRow[]): PlanRow[] {
    return [...rows].sort((a, b) => {
        const byState = STATE_ORDER[a.item.state] - STATE_ORDER[b.item.state];
        return byState !== 0 ? byState : a.item.id - b.item.id;
    });
}

function group(id: string, label: string, rows: PlanRow[]): PhaseGroup {
    const sorted = sortRows(rows);
    return {
        id, label, rows: sorted,
        done: sorted.filter((row) => row.item.state === "done").length,
        doing: sorted.filter((row) => row.item.state === "doing").length,
        total: sorted.length,
        open: false,
    };
}

/** The phase number of an entry id: the part before the dot, or null for a flat id. */
function phaseOf(entry: string): number | null {
    const dot = entry.indexOf(".");
    return dot === -1 ? null : Number(entry.slice(0, dot));
}

/**
 * The Plan grouped by the doc's phases (T6): one group per phase with its items, then `Other`
 * for the items without an entry or with an orphan entry. A stale item stays in its phase
 * with a badge. Without a scan, or with entries and no phases (EGM's flat template), one
 * group `Plan`. The groups' `open` flags follow the rule of T6.
 */
export function phaseGroups(plan: readonly PlanItem[], scan: PlanScan | null): PhaseGroup[] {
    const entries = new Map(scan?.entries.map((entry) => [entry.id, entry]) ?? []);
    const rowOf = (item: PlanItem): PlanRow => {
        if (item.entry === null || scan === null) {
            return { item, orphan: false, stale: false };
        }
        const entry = entries.get(item.entry);
        if (entry === undefined) {
            return { item, orphan: true, stale: false };
        }
        return { item, orphan: false, stale: entry.title !== item.text };
    };
    const rows = plan.map(rowOf);
    let groups: PhaseGroup[];
    if (scan === null || scan.phases.length === 0) {
        groups = [group("plan", "Plan", rows)];
    } else {
        const phases = scan.phases.map((phase) => {
            const own = rows.filter((row) =>
                !row.orphan && row.item.entry !== null && phaseOf(row.item.entry) === phase.number);
            const label = phase.title === ""
                ? `Build session ${phase.number}`
                : `Build session ${phase.number}: ${phase.title}`;
            return group(`phase-${phase.number}`, label, own);
        });
        const placed = new Set(phases.flatMap((phase) => phase.rows.map((row) => row.item.id)));
        const other = rows.filter((row) => !placed.has(row.item.id));
        groups = other.length === 0 ? phases : [...phases, group("other", "Other", other)];
    }
    return openGroups(groups);
}

/** A group opens when it holds a doing row; else the first group with an open row opens. */
function openGroups(groups: PhaseGroup[]): PhaseGroup[] {
    const anyDoing = groups.some((candidate) => candidate.doing > 0);
    const firstOpen = groups.find((candidate) => candidate.done < candidate.total);
    return groups.map((candidate) => ({
        ...candidate,
        open: anyDoing ? candidate.doing > 0 : candidate === firstOpen,
    }));
}

/** The mark of a doc entry on the Draft tab and in the header count (D9). */
export interface EntryMark {
    state: "none" | "doing" | "partial" | "done";
    done: number;
    total: number;
}

/**
 * The mark of every entry (D9): `done` when every linked item is ticked and at least one is
 * linked; else `doing` when any linked item is doing; else `partial` when some are ticked;
 * else `none`. `doing` wins over `partial`, so a split never reads done early.
 */
export function entryMarks(
    scan: PlanScan,
    plan: readonly PlanItem[],
): Map<string, EntryMark> {
    const linked = new Map<string, PlanItem[]>();
    for (const item of plan) {
        if (item.entry !== null) {
            linked.set(item.entry, [...(linked.get(item.entry) ?? []), item]);
        }
    }
    const marks = new Map<string, EntryMark>();
    for (const entry of scan.entries) {
        const items = linked.get(entry.id) ?? [];
        const done = items.filter((item) => item.state === "done").length;
        const doing = items.some((item) => item.state === "doing");
        let state: EntryMark["state"] = "none";
        if (items.length > 0 && done === items.length) {
            state = "done";
        } else if (doing) {
            state = "doing";
        } else if (done > 0) {
            state = "partial";
        }
        marks.set(entry.id, { state, done, total: items.length });
    }
    return marks;
}

/** `done 3 / 3`, `doing`, `partial 1 / 3`: the title of a marked heading (T7). */
export function markTitle(mark: EntryMark): string | null {
    switch (mark.state) {
        case "done":
            return `done ${mark.done} / ${mark.total}`;
        case "doing":
            return "doing";
        case "partial":
            return `partial ${mark.done} / ${mark.total}`;
        case "none":
            return null;
    }
}

export type ImplementState = "no-doc" | "unapproved" | "approved";

/** The view's state (T6): no named doc, a doc not yet approved, or approved. */
export function implementState(
    design: DesignView | undefined,
    scan: PlanScan | null,
): ImplementState {
    if (design === undefined || design.track !== "design" || scan === null) {
        return "no-doc";
    }
    return design.approved === null ? "unapproved" : "approved";
}

/** The header's entry count, or `null` for the direct track and before approval. */
export function headerText(
    state: ImplementState,
    scan: PlanScan | null,
    plan: readonly PlanItem[],
): string {
    switch (state) {
        case "no-doc":
            return "No design doc yet";
        case "unapproved":
            return `Approve to seed ${scan?.entries.length ?? 0} entries`;
        case "approved": {
            const marks = scan === null ? new Map<string, EntryMark>() : entryMarks(scan, plan);
            const done = [...marks.values()].filter((mark) => mark.state === "done").length;
            return `entries done ${done} / ${scan?.entries.length ?? 0}`;
        }
    }
}

export type RailState = "working" | "idle" | "blocked" | "needs-you" | "off";

/** True when the session's `needs_human` line names the agent. */
export function needsAgent(needs: string | null, name: string): boolean {
    return needs !== null && needs.split(/[^A-Za-z0-9_-]+/).includes(name);
}

/**
 * The rail's live dot per agent (D14): `agentState` for the chip's three states, `blocked`
 * from the Roster `Blocked?` cell, `needs-you` while `needs_human` names the agent (`needs`,
 * from `needsAgent`). `needs-you` wins, then `blocked`, then the chip's state.
 */
export function railState(
    spec: AgentSpec | undefined,
    hosted: boolean,
    blocked: boolean,
    needs: boolean,
): RailState {
    if (needs) {
        return "needs-you";
    }
    if (blocked) {
        return "blocked";
    }
    if (spec === undefined) {
        return "off";
    }
    return agentState(spec, hosted);
}

/**
 * The Open questions of the rail (#43), each group in id order. `open` waits on an answer:
 * no answer and not resolved; the pulse counts these. `answered` has an answer and waits on
 * the asker to resolve it. `resolved` carries a `[resolved]` line and folds in the rail.
 */
export interface QuestionGroups {
    open: QuestionItem[];
    answered: QuestionItem[];
    resolved: QuestionItem[];
}

export function questionGroups(questions: readonly QuestionItem[]): QuestionGroups {
    const groups: QuestionGroups = { open: [], answered: [], resolved: [] };
    const sorted = [...questions].sort((a, b) => a.id - b.id);
    for (const question of sorted) {
        if (question.resolved !== null) {
            groups.resolved.push(question);
        } else if (question.answer === null) {
            groups.open.push(question);
        } else {
            groups.answered.push(question);
        }
    }
    return groups;
}

/** `resolved by lead at 10:40: became Contract 14:15`: the folded line of a resolved one. */
export function resolutionText(question: QuestionItem): string | null {
    const resolved = question.resolved;
    if (resolved === null) {
        return null;
    }
    const by = resolved.author === null ? "" : ` by ${resolved.author}`;
    const at = resolved.ts === null ? "" : ` at ${resolved.ts}`;
    return `resolved${by}${at}: ${resolved.reason}`;
}
