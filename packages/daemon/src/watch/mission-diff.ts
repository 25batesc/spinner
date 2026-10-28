// Pure: which sections of MISSION.md changed between two versions of the file, in the form
// the change steer uses: `Roster (own row), Contracts (+1), Log (+2)`
// (docs/SESSION_PROTOCOL.md, "Change propagation").
import type { MissionSection } from "@spinner/protocol";
import { split_mission } from "../pipeline/mission-sections.js";
import { SECTION_HEADINGS } from "../store/mission-writer.js";

/** Sections where a change is counted in appended lines. */
const LINE_SECTIONS: readonly MissionSection[] = ["plan", "contracts", "open_questions", "log"];

export interface SectionChange {
    section: MissionSection;
    /** Lines added, for the line-oriented sections; 0 for the others. */
    added: number;
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
        changes.push({ section, added });
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
