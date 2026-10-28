// Splits a MISSION.md into its sections. The daemon sends the raw file (`GET .../mission`), so
// the UI parses only the `##` headings and the Roster table; the daemon owns every write.
import type { MissionSection } from "@spinner/protocol";

export interface MissionPart {
    /** Heading text as written, for example `Contracts & decisions`. */
    heading: string;
    /** The protocol name of the section, or null for a heading Spinner does not know. */
    section: MissionSection | null;
    /** Lines between this heading and the next, without the blank lines at both ends. */
    body: string;
}

export interface ParsedMission {
    title: string;
    parts: MissionPart[];
}

const SECTION_BY_HEADING: Record<string, MissionSection> = {
    goal: "goal",
    "done when": "done_when",
    plan: "plan",
    roster: "roster",
    "contracts & decisions": "contracts",
    "open questions": "open_questions",
    log: "log",
};

/** Sections the operator edits in the UI; every other section is written by agents. */
export const OPERATOR_SECTIONS: readonly MissionSection[] = ["goal", "done_when"];

export function parseMission(markdown: string): ParsedMission {
    let title = "";
    const parts: MissionPart[] = [];
    let current: { heading: string; lines: string[] } | null = null;
    const close = () => {
        if (current !== null) {
            const heading = current.heading;
            const section = SECTION_BY_HEADING[heading.trim().toLowerCase()] ?? null;
            parts.push({ heading, section, body: current.lines.join("\n").trim() });
        }
    };
    for (const line of markdown.split("\n")) {
        if (line.startsWith("## ")) {
            close();
            current = { heading: line.slice(3).trim(), lines: [] };
        } else if (current !== null) {
            current.lines.push(line);
        } else if (line.startsWith("# ")) {
            title = line.slice(2).trim();
        }
    }
    close();
    return { title, parts };
}

/** The sections whose text differs between two parses, by heading. */
export function changedHeadings(before: ParsedMission | null, after: ParsedMission): string[] {
    if (before === null) {
        return [];
    }
    const old = new Map(before.parts.map((part) => [part.heading, part.body]));
    return after.parts.filter((part) => old.get(part.heading) !== part.body).map((p) => p.heading);
}

export function tableRows(body: string): string[][] {
    return body
        .split("\n")
        .filter((line) => line.trim().startsWith("|"))
        .map((line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()))
        .filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)));
}
