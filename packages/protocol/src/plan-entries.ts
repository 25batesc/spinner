// The plan entry grammar (docs/designs/session-workspace.md, T2, T3, D8). The daemon seeds
// the MISSION.md Plan from the design doc's Detailed Implementation Plan at approval, and the
// UI groups the Plan by the doc's phases and marks each entry done; both call `scan` here, so
// a heading counts as an entry on one side if and only if it counts on the other. `headings`
// is the one fence-aware heading walker; the daemon's blocker count consumes it too. The
// token functions carry the entry link on a Plan line (`- [ ] 7. [1.5] text (engine)`). This
// package is imported by the browser UI, so it throws plain `Error`s and uses no `node:`
// module.

/** The scan reads at most this many lines of a doc; past it the scan throws. */
export const DOC_LINES_MAX = 100_000;
/** A doc has at most this many `#### Build session N` phases; past it the scan throws. */
export const PHASES_MAX = 50;
/** A doc has at most this many entries (the Plan's `ITEMS_MAX`); past it the scan throws. */
export const ENTRIES_MAX = 500;
/** An entry id in a token is at most this many characters of `[0-9.]`. */
export const ENTRY_TOKEN_MAX = 16;

/** One `#` heading outside a code fence. `line` is 1-based. */
export interface DocHeading {
    level: number;
    text: string;
    line: number;
}

/** One `#### Build session N[: title]` heading of the plan section. */
export interface PlanPhase {
    number: number;
    title: string;
    line: number;
}

/** One `#### n.` or `##### n.n` heading of the plan section. */
export interface PlanEntry {
    /** The id as written: `1.5` or `3`. */
    id: string;
    /** The number before the dot, or null for a flat `#### n.` entry. */
    phase: number | null;
    /** The heading text after the three strips of T2 step 3; the backticks stay. */
    title: string;
    /** `Create`, `Modify`, `Delete` or `Remove` from the trailing parenthetical, else null. */
    kind: string | null;
    line: number;
}

export interface PlanScan {
    phases: PlanPhase[];
    entries: PlanEntry[];
    /** The ids that appear more than once; the first heading of each id is kept. */
    duplicates: string[];
    /** The ids whose title is empty after the strips. */
    empty_titles: string[];
}

/** 3 or more backticks or tildes open a fence; the same character, as long or longer, closes it. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;

/**
 * Every `#` heading outside a code fence, in order, with the fence rule of the UI's
 * `docSections`. Throws past `lines_max`, so a doc over the bound is an error, not a partial
 * read.
 */
export function headings(text: string, lines_max: number): DocHeading[] {
    if (!(lines_max > 0)) {
        throw new Error(`lines_max must be positive, got ${lines_max}`);
    }
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    if (lines.length > lines_max) {
        throw new Error(`the document has more than ${lines_max} lines`);
    }
    const out: DocHeading[] = [];
    let fence: string | null = null;
    for (const [index, line] of lines.entries()) {
        const opened = FENCE.exec(line)?.[1];
        if (opened !== undefined) {
            if (fence === null) {
                fence = opened;
            } else if (opened[0] === fence[0] && opened.length >= fence.length) {
                fence = null;
            }
            continue;
        }
        if (fence !== null) {
            continue;
        }
        const match = HEADING.exec(line);
        if (match !== null) {
            out.push({ level: (match[1] ?? "").length, text: match[2] ?? "", line: index + 1 });
        }
    }
    return out;
}

const PLAN_SECTION = /Implementation Plan$/;
const PHASE = /^Build session (\d+)\b(?::\s*(.*))?$/;
const ENTRY = /^(\d+(?:\.\d+)?)\.?\s+(.*)$/;
const TAG = /\*\*\[[^\]]*\]\*\*/g;
const KINDS = ["Create", "Modify", "Delete", "Remove"];

/**
 * The phases and entries of the doc's plan section (T2): the first `## ` heading that ends
 * with `Implementation Plan`, up to the next `## ` heading. A duplicate id keeps its first
 * heading; an empty title is reported, not dropped. Throws past `PHASES_MAX` or `ENTRIES_MAX`.
 */
export function scan(doc: string): PlanScan {
    const result: PlanScan = { phases: [], entries: [], duplicates: [], empty_titles: [] };
    const seen = new Set<string>();
    let inside = false;
    for (const heading of headings(doc, DOC_LINES_MAX)) {
        if (heading.level === 2) {
            if (inside) {
                break;
            }
            inside = PLAN_SECTION.test(heading.text);
            continue;
        }
        if (!inside) {
            continue;
        }
        const phase = heading.level === 4 ? PHASE.exec(heading.text) : null;
        if (phase !== null) {
            result.phases.push({
                number: Number(phase[1]),
                title: (phase[2] ?? "").trim(),
                line: heading.line,
            });
            if (result.phases.length > PHASES_MAX) {
                throw new Error(`the plan has more than ${PHASES_MAX} phases`);
            }
            continue;
        }
        const entry =
            heading.level === 4 || heading.level === 5
                ? parse_entry_heading(heading.text, heading.line)
                : null;
        if (entry === null) {
            continue;
        }
        if (seen.has(entry.id)) {
            result.duplicates.push(entry.id);
            continue;
        }
        seen.add(entry.id);
        result.entries.push(entry);
        if (result.entries.length > ENTRIES_MAX) {
            throw new Error(`the plan has more than ${ENTRIES_MAX} entries`);
        }
        if (entry.title.length === 0) {
            result.empty_titles.push(entry.id);
        }
    }
    return result;
}

/**
 * T2 step 3 on one heading text: the id, then the title after the three strips (every
 * `**[…]**` tag, one trailing parenthetical, surrounding whitespace) and the kind from that
 * parenthetical. Null for a heading that is not an entry. The UI calls it on a rendered
 * heading, where `line` is unknown.
 */
export function parse_entry_heading(text: string, line = 0): PlanEntry | null {
    const match = ENTRY.exec(text.trim());
    if (match === null) {
        return null;
    }
    const id = match[1] ?? "";
    if (id.length === 0) {
        throw new Error(`an entry heading must carry an id: ${text}`);
    }
    const untagged = (match[2] ?? "").replace(TAG, "").trim();
    const { before, inside } = split_trailing_parenthetical(untagged);
    const first_word = /^([A-Za-z]+)/.exec((inside ?? "").trim())?.[1] ?? null;
    const dot = id.indexOf(".");
    return {
        id,
        phase: dot === -1 ? null : Number(id.slice(0, dot)),
        title: before.trim(),
        kind: first_word !== null && KINDS.includes(first_word) ? first_word : null,
        line,
    };
}

/**
 * Splits `text ( … )` at its trailing parenthetical, whatever it holds, nested parentheses
 * included. `inside` is null without one.
 */
function split_trailing_parenthetical(text: string): { before: string; inside: string | null } {
    if (!text.endsWith(")")) {
        return { before: text, inside: null };
    }
    let depth = 0;
    for (let index = text.length - 1; index >= 0; index -= 1) {
        const char = text[index];
        if (char === ")") {
            depth += 1;
        } else if (char === "(") {
            depth -= 1;
            if (depth === 0) {
                return { before: text.slice(0, index), inside: text.slice(index + 1, -1) };
            }
        }
    }
    return { before: text, inside: null };
}

const ENTRY_ID = /^[0-9.]{1,16}$/;
const TOKEN = /^\[([0-9.]{1,16})\] (.+)$/;
const LEGACY_PREFIX = /^plan ([0-9.]{1,16}): (.+)$/;

/** True for a token id: 1 to `ENTRY_TOKEN_MAX` characters of `[0-9.]`. */
export function is_entry_id(text: string): boolean {
    return ENTRY_ID.test(text);
}

/**
 * The entry link at the start of a Plan item's text (T3): `[1.5] text` or the legacy
 * `plan 1.5: text`. A bracket text that is not a token (`[D7] fix`, a 17-character id, a
 * token with nothing after it) is plain text with `entry` null.
 */
export function parse_entry_token(text: string): { entry: string | null; rest: string } {
    const token = TOKEN.exec(text) ?? LEGACY_PREFIX.exec(text);
    if (token === null) {
        return { entry: null, rest: text };
    }
    return { entry: token[1] ?? null, rest: token[2] ?? "" };
}

/** The canonical text of a linked item: `[1.5] text`; `rest` alone without an entry. */
export function render_entry_token(entry: string | null, rest: string): string {
    if (entry === null) {
        return rest;
    }
    if (!is_entry_id(entry)) {
        throw new Error(`not an entry id: "${entry}"`);
    }
    return `[${entry}] ${rest}`;
}
