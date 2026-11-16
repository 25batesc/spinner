// Pure: which sections of MISSION.md changed between two versions of the file, with the lines
// that are new, in the form the change notice uses (docs/SESSION_PROTOCOL.md, "Change
// propagation"). The notice carries the new lines so the agent does not re-read the file:
// a re-read of a long mission costs tens of thousands of tokens, and s039's agents were
// asked for one on every Log line of every other agent.
import assert from "node:assert/strict";
import type { MissionSection } from "@spinner/protocol";
import { split_mission } from "../pipeline/mission-sections.js";
import { SECTION_HEADINGS } from "../store/mission-writer.js";

/** Sections where a change is counted in appended lines. */
const LINE_SECTIONS: readonly MissionSection[] = ["plan", "contracts", "open_questions", "log"];

/** Upper bound on new lines one section shows in a notice; past it the agent reads it. */
export const NOTICE_LINES_MAX = 6;

/** Upper bound on one line in a notice; a Log line can run to a paragraph. */
export const NOTICE_LINE_CHARS_MAX = 300;

/**
 * The sections whose change interrupts a busy agent. A Log line or a Roster row is news the
 * agent reads at its next prompt; a Plan, Contract, Goal, Done when or Open question change
 * can change what it is doing now.
 */
export const STEER_SECTIONS: readonly MissionSection[] = [
    "goal",
    "done_when",
    "plan",
    "contracts",
    "open_questions",
];

export interface SectionChange {
    section: MissionSection;
    /** Lines added, for the line-oriented sections; 0 for the others. */
    added: number;
    /** The lines in the new body that the old one did not have, in order, bounded. */
    lines: string[];
    /** How many such lines `lines` leaves out. */
    more: number;
}

/** The sections whose body differs, in file order. */
export function diff_mission(before: string, after: string): SectionChange[] {
    const old_bodies = bodies_of(before);
    const new_bodies = bodies_of(after);
    const changes: SectionChange[] = [];
    for (const section of Object.keys(SECTION_HEADINGS) as MissionSection[]) {
        const old_body = old_bodies.get(section) ?? "";
        const new_body = new_bodies.get(section) ?? "";
        if (old_body === new_body) {
            continue;
        }
        const added = LINE_SECTIONS.includes(section)
            ? Math.max(1, count_lines(new_body) - count_lines(old_body))
            : 0;
        const fresh = new_lines(old_body, new_body);
        const lines = fresh.slice(0, NOTICE_LINES_MAX).map(clipped);
        changes.push({ section, added, lines, more: fresh.length - lines.length });
    }
    return changes;
}

/** `Roster (own row), Contracts (+1), Log (+2)`; the Roster says `own row` with a known author. */
export function describe_changes(changes: readonly SectionChange[], author_known: boolean): string {
    return changes
        .map((change) => {
            const heading = SECTION_HEADINGS[change.section];
            if (change.section === "roster") {
                return author_known ? `${heading} (own row)` : heading;
            }
            return change.added > 0 ? `${heading} (+${change.added})` : heading;
        })
        .join(", ");
}

/**
 * The notice text: the header line, the new lines of each section under its heading, and
 * one line naming the sections the agent must read because their change does not fit.
 */
export function render_notice(
    author: string,
    changes: readonly SectionChange[],
    author_known: boolean,
): string {
    assert.ok(changes.length > 0, "a notice needs a change");
    const lines = [`MISSION.md changed by ${author}: ${describe_changes(changes, author_known)}.`];
    const to_read: string[] = [];
    for (const change of changes) {
        const heading = SECTION_HEADINGS[change.section];
        if (change.lines.length === 0 || change.more > 0) {
            to_read.push(change.section);
        }
        if (change.lines.length > 0) {
            lines.push(`${heading}:`, ...change.lines.map((line) => `  ${line}`));
        }
        if (change.more > 0) {
            lines.push(`  (${change.more} more)`);
        }
    }
    if (to_read.length > 0) {
        lines.push(`Read ${to_read.join(", ")} with \`mission_read\`; nothing else changed.`);
    }
    return lines.join("\n");
}

/** True when a change needs the agent now, not at its next prompt. */
export function is_urgent(changes: readonly SectionChange[]): boolean {
    return changes.some((change) => STEER_SECTIONS.includes(change.section));
}

function bodies_of(text: string): Map<MissionSection, string> {
    const by_heading = new Map<string, string>();
    for (const block of split_mission(text)) {
        by_heading.set(block.heading, block.body.trim());
    }
    const bodies = new Map<MissionSection, string>();
    for (const [section, heading] of Object.entries(SECTION_HEADINGS)) {
        bodies.set(section as MissionSection, by_heading.get(heading) ?? "");
    }
    return bodies;
}

function count_lines(body: string): number {
    return body.length === 0 ? 0 : body.split("\n").filter((line) => line.trim().length > 0).length;
}

/** The non-empty lines of `after` that `before` does not contain, in order. */
function new_lines(before: string, after: string): string[] {
    const known = new Set(before.split("\n").map((line) => line.trim()));
    return after
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !known.has(line));
}

function clipped(line: string): string {
    return line.length > NOTICE_LINE_CHARS_MAX ? `${line.slice(0, NOTICE_LINE_CHARS_MAX)}…` : line;
}
