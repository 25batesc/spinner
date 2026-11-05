// Reads the sections of MISSION.md the pipeline commands need (`pr` builds a PR body from
// Goal, Done when and the Log; `reset` moves the round's history under `## Previous rounds`)
// and appends Log lines for them. Pure functions over the file text; the callers read and
// write the file. The daemon's serialized mission writer (ext, `store/mission-*.ts`) owns
// tool writes; these are the pipeline's own, made from inside a job. Since s014 the file
// also carries ids and times on list items (`- [x] 3. text (owner, 14:02)`); `parse_item`,
// `render_item` and `mission_view` read and write that form, and the older ones. Since
// session-workspace (T3) a Plan line can start its text with an entry token (`[1.5] text`)
// that links the item to a design doc entry; the token rule is `@spinner/protocol`'s.
import assert from "node:assert/strict";
import type {
    DoneWhenItem,
    LogLine,
    MissionLine,
    MissionView,
    PlanItem,
    QuestionItem,
    RosterRow,
} from "@spinner/protocol";
import { parse_entry_token, render_entry_token } from "@spinner/protocol";

/** A `## ` heading and the lines under it, up to the next `## ` heading. */
export interface MissionBlock {
    heading: string;
    body: string;
}

/** Upper bound on headings; a mission has seven sections plus a few rounds. */
const BLOCKS_MAX = 100;

/** Splits the text at `## ` headings. Text before the first heading is the title block. */
export function split_mission(text: string): MissionBlock[] {
    const blocks: MissionBlock[] = [];
    let current: MissionBlock = { heading: "", body: "" };
    for (const line of text.split("\n")) {
        if (line.startsWith("## ")) {
            blocks.push(current);
            assert.ok(blocks.length < BLOCKS_MAX, `more than ${BLOCKS_MAX} sections`);
            current = { heading: line.slice(3).trim(), body: "" };
            continue;
        }
        current.body += `${line}\n`;
    }
    blocks.push(current);
    return blocks;
}

export function join_mission(blocks: readonly MissionBlock[]): string {
    return blocks
        .map((block) => (block.heading === "" ? block.body : `## ${block.heading}\n${block.body}`))
        .join("");
}

/** The body of the section with `heading`, trimmed, or "" when the section is absent. */
export function mission_section(text: string, heading: string): string {
    const block = split_mission(text).find((entry) => entry.heading === heading);
    return block === undefined ? "" : block.body.trim();
}

/** Appends `- HH:MM author: text` at the end of the Log section. */
export function append_log_line(text: string, time: string, author: string, line: string): string {
    assert.ok(/^\d\d:\d\d$/.test(time), `time must be HH:MM, got "${time}"`);
    const blocks = split_mission(text);
    const log = blocks.find((entry) => entry.heading === "Log");
    const entry = `- ${time} ${author}: ${line}\n`;
    if (log === undefined) {
        blocks.push({ heading: "Log", body: entry });
        return join_mission(blocks);
    }
    log.body = `${log.body.replace(/\n+$/, "")}\n${entry}`;
    return join_mission(blocks);
}

/** The PR body `spinner pr` writes: Goal, Done when and the Log of the session. */
export function pr_body_from_mission(text: string, session_id: string): string {
    const goal = mission_section(text, "Goal");
    const done_when = mission_section(text, "Done when");
    const log = mission_section(text, "Log");
    const parts = [
        "## Goal",
        goal.length > 0 ? goal : "(no goal written)",
        "",
        "## Done when",
        done_when.length > 0 ? done_when : "(no acceptance list written)",
        "",
        "## Log",
        log.length > 0 ? log : "(empty)",
        "",
        `_Opened by Spinner from session ${session_id}._`,
        "",
    ];
    return parts.join("\n");
}

/** A checklist line of Plan or Done when, as the file carries it. */
export interface MissionItem {
    checked: boolean;
    /** The Plan number; null for a Done when line or a Plan line written before s014. */
    id: number | null;
    /** The text without the entry token. */
    text: string;
    owner: string | null;
    /** The doc entry of the `[1.5]` token or the legacy `plan 1.5: ` prefix; null without one. */
    entry: string | null;
    /** `HH:MM` from the tick, or null. */
    ticked_at: string | null;
}

const ITEM_LINE = /^- \[( |x)\]\s*(?:(\d+)\.\s*)?(.*?)\s*$/;
const TRAILING_PAREN = /^(.*?)\s*\(([^()]*)\)$/;
const TIME = /^\d\d:\d\d$/;
/** An owner is one name, or `the operator`; prose in a parenthesis is longer than that. */
const OWNER = /^(?:the )?[A-Za-z0-9_.-]+$/;

/** Upper bound on items in one section; a mission is meant to stay under 400 lines. */
const ITEMS_MAX = 500;

/**
 * Reads `- [ ] 3. text (owner)`, `- [x] 3. text (owner, 14:02)` and the older forms without
 * an id or an owner. The last parenthesis is the owner and the time when its first part is a
 * name; other parts in it (`after 3`) go back into the text. The entry token at the start
 * of the text is read into `entry` on every checklist line (T3). Null for a line that is
 * not a checklist item, or an empty placeholder (`- [ ] 1. `).
 */
export function parse_item(line: string): MissionItem | null {
    const match = ITEM_LINE.exec(line);
    if (match === null) {
        return null;
    }
    const [, mark, id_text, rest] = match;
    assert.ok(mark !== undefined && rest !== undefined);
    if (rest.length === 0) {
        return null;
    }
    const item = parse_owner({
        checked: mark === "x",
        id: id_text === undefined ? null : Number(id_text),
        text: rest,
        owner: null,
        entry: null,
        ticked_at: null,
    });
    const token = parse_entry_token(item.text);
    item.entry = token.entry;
    item.text = token.rest;
    return item;
}

/** Moves the trailing `(owner, HH:MM)` of `item.text` into `owner` and `ticked_at`. */
function parse_owner(item: MissionItem): MissionItem {
    const paren = TRAILING_PAREN.exec(item.text);
    if (paren === null) {
        return item;
    }
    const [, before, inside] = paren;
    assert.ok(before !== undefined && inside !== undefined);
    const parts = inside.split(",").map((part) => part.trim());
    const owner = parts[0] ?? "";
    if (!OWNER.test(owner) || parts.length > 3) {
        return item;
    }
    const time = parts.slice(1).find((part) => TIME.test(part)) ?? null;
    const extra = parts.slice(1).filter((part) => !TIME.test(part) && part.length > 0);
    item.owner = owner;
    item.ticked_at = time;
    item.text = extra.length === 0 ? before : `${before} (${extra.join(", ")})`;
    return item;
}

/**
 * The canonical line: `- [x] 3. [1.5] text (owner, 14:02)`, the token first; a ticked item
 * without an owner gets `?`.
 */
export function render_item(item: MissionItem): string {
    assert.ok(item.text.length > 0, "an item needs text");
    const mark = item.checked ? "x" : " ";
    const id = item.id === null ? "" : `${item.id}. `;
    const owner = item.owner ?? (item.ticked_at === null ? null : "?");
    let tail = "";
    if (owner !== null) {
        tail = item.ticked_at === null ? ` (${owner})` : ` (${owner}, ${item.ticked_at})`;
    }
    return `- [${mark}] ${id}${render_entry_token(item.entry, item.text)}${tail}`;
}

/** The items of a section body, in file order, with their line index. */
export function section_items(body: string): { line: number; item: MissionItem }[] {
    const items: { line: number; item: MissionItem }[] = [];
    for (const [line, text] of body.split("\n").entries()) {
        const item = parse_item(text);
        if (item !== null) {
            items.push({ line, item });
            assert.ok(items.length <= ITEMS_MAX, `more than ${ITEMS_MAX} items in a section`);
        }
    }
    return items;
}

/** Goal placeholders the templates write; the view shows an empty goal instead. */
const GOAL_PLACEHOLDERS = [
    "(One paragraph. Operator-owned.)",
    "(The lead agent writes this from the conversation.)",
];

/**
 * The structured mission (MISSION.md s014, Contracts "view"): derived from the text on every
 * read and never stored. Plan items without an id get `max + 1` in file order for display;
 * the writer makes those ids permanent on its next write to the section.
 */
export function mission_view(text: string): MissionView {
    const blocks = split_mission(text);
    const body = (heading: string): string =>
        blocks.find((block) => block.heading === heading)?.body ?? "";
    const roster = parse_roster(body("Roster"));
    return {
        title: parse_title(blocks[0]?.body ?? ""),
        goal: body("Goal")
            .split("\n")
            .filter((line) => !GOAL_PLACEHOLDERS.includes(line.trim()))
            .join("\n")
            .trim(),
        done_when: parse_done_when(body("Done when")),
        plan: parse_plan(body("Plan"), roster),
        roster,
        contracts: parse_lines(body("Contracts & decisions")),
        questions: parse_questions(body("Open questions")),
        log: parse_log(body("Log")),
    };
}

/** `# s14 \u00b7 Title` gives `Title`; a heading without the id gives its whole text. */
function parse_title(block: string): string {
    const heading = block.split("\n").find((line) => line.startsWith("# "));
    if (heading === undefined) {
        return "";
    }
    const text = heading.slice(2).trim();
    const separated = /^\S+\s+\u00b7\s+(.+)$/.exec(text);
    return separated?.[1] ?? text;
}

function parse_done_when(body: string): DoneWhenItem[] {
    return section_items(body).map(({ item }, index) => ({
        id: index + 1,
        text: item.text,
        owner: item.owner,
        state: item.checked ? "done" : "open",
        ticked_at: item.ticked_at,
    }));
}

/** Plan items with ids filled in for display, and the `doing` state from the Roster. */
function parse_plan(body: string, roster: readonly RosterRow[]): PlanItem[] {
    const items = with_ids(section_items(body).map(({ item }) => item));
    const named = new Set<number>();
    for (const item of items) {
        if (!item.checked && names_item(roster, item)) {
            named.add(item.id);
        }
    }
    // The fallback (the owner's lowest unticked item) applies to an owner whose Doing cell
    // names no item of its own; an explicit mention wins over position.
    const first_open = new Map<string, number>();
    for (const item of items) {
        if (item.checked || item.owner === null || first_open.has(item.owner)) {
            continue;
        }
        const row = roster.find((entry) => entry.agent === item.owner);
        const owns_named = items.some((other) => other.owner === item.owner && named.has(other.id));
        if (row !== undefined && !owns_named && is_active(row.doing)) {
            first_open.set(item.owner, item.id);
        }
    }
    return items.map((item) => ({
        id: item.id,
        text: item.text,
        owner: item.owner,
        entry: item.entry,
        state: item.checked
            ? "done"
            : named.has(item.id) || first_open.get(item.owner ?? "") === item.id
              ? "doing"
              : "next",
        ticked_at: item.ticked_at,
    }));
}

/** True when the owner's Roster `Doing` names `#id` or `item id`. */
function names_item(roster: readonly RosterRow[], item: MissionItem & { id: number }): boolean {
    const row = roster.find((entry) => entry.agent === item.owner);
    if (row === undefined) {
        return false;
    }
    return new RegExp(`(?:#|\\bitem )${item.id}\\b`).test(row.doing);
}

/** A Doing cell that says the agent works: not empty, `\u2014`, `-` or `done`. */
function is_active(doing: string): boolean {
    const text = doing.trim();
    return text.length > 0 && text !== "\u2014" && text !== "-" && text !== "done";
}

/** Items without an id get `max + 1` in file order, as the writer will make permanent. */
export function with_ids(items: readonly MissionItem[]): (MissionItem & { id: number })[] {
    let max = 0;
    for (const item of items) {
        if (item.id !== null) {
            max = Math.max(max, item.id);
        }
    }
    return items.map((item) => {
        if (item.id !== null) {
            return { ...item, id: item.id };
        }
        max += 1;
        return { ...item, id: max };
    });
}

function parse_roster(body: string): RosterRow[] {
    const rows: RosterRow[] = [];
    for (const line of body.split("\n")) {
        if (!line.startsWith("|")) {
            continue;
        }
        const cells = line
            .replace(/^\|/, "")
            .replace(/\|\s*$/, "")
            .split("|")
            .map((cell) => cell.trim());
        const agent = cells[0] ?? "";
        if (agent === "" || agent === "Agent" || /^-+$/.test(agent)) {
            continue;
        }
        rows.push({
            agent,
            owns: cells[1] ?? "",
            doing: cells[2] ?? "",
            blocked: cells[3] ?? "",
            updated: cells[4] ?? "",
        });
    }
    return rows;
}

/** `- ts author: text` or `- author: text`; the first token is a time, a date or a marker. */
const STAMPED = /^(\S+)\s+([^:]+?):\s*(.*)$/;
const AUTHORED = /^([^:\s][^:]*?):\s*(.*)$/;

/** Top-level `- ` entries; every other line belongs to the entry before it. */
function entries(body: string): { head: string; rest: string[] }[] {
    const out: { head: string; rest: string[] }[] = [];
    for (const line of body.split("\n")) {
        if (line.startsWith("- ")) {
            out.push({ head: line.slice(2).trim(), rest: [] });
            assert.ok(out.length <= ITEMS_MAX, `more than ${ITEMS_MAX} entries in a section`);
            continue;
        }
        const last = out[out.length - 1];
        if (last !== undefined && line.trim().length > 0) {
            last.rest.push(line.trim());
        }
    }
    return out;
}

function parse_lines(body: string): MissionLine[] {
    return entries(body).map(({ head, rest }, index) => {
        const tail = rest.length === 0 ? "" : `\n${rest.join("\n")}`;
        const stamped = STAMPED.exec(head);
        if (stamped !== null && stamped[1] !== undefined && stamped[2] !== undefined) {
            return {
                id: index + 1,
                ts: stamped[1],
                author: stamped[2],
                text: `${stamped[3] ?? ""}${tail}`,
            };
        }
        const authored = AUTHORED.exec(head);
        if (authored !== null && authored[1] !== undefined && !authored[1].includes(" ")) {
            return { id: index + 1, ts: null, author: authored[1], text: `${authored[2]}${tail}` };
        }
        return { id: index + 1, ts: null, author: null, text: `${head}${tail}` };
    });
}

/** `- author: question`, with the indented lines under it as the answer. */
function parse_questions(body: string): QuestionItem[] {
    return entries(body).map(({ head, rest }, index) => {
        const authored = AUTHORED.exec(head);
        const author =
            authored !== null && authored[1] !== undefined && !authored[1].includes(" ")
                ? authored[1]
                : null;
        const text = author === null ? head : (authored?.[2] ?? "");
        const answer = rest.map((line) => line.replace(/^-\s+/, "")).join("\n");
        return { id: index + 1, author, text, answer: answer.length === 0 ? null : answer };
    });
}

function parse_log(body: string): LogLine[] {
    const lines: LogLine[] = [];
    for (const { head } of entries(body)) {
        const stamped = STAMPED.exec(head);
        if (stamped === null || stamped[1] === undefined || stamped[2] === undefined) {
            continue;
        }
        lines.push({ ts: stamped[1], author: stamped[2], text: stamped[3] ?? "" });
    }
    return lines;
}

/**
 * `reset`: moves the Log and the Roster's Doing cells of the round that ended under
 * `## Previous rounds` and starts a fresh Log. Goal, Done when, Plan, Contracts and Open
 * questions stay, because the next round continues the same mission.
 */
export function archive_round(text: string, round: number, summary: string): string {
    assert.ok(round >= 1, "round must be at least 1");
    const blocks = split_mission(text);
    const log = blocks.find((entry) => entry.heading === "Log");
    const old_log = log === undefined ? "" : log.body.trim();
    const history = `### Round ${round} · ${summary}\n${old_log}\n\n`;
    const previous = blocks.find((entry) => entry.heading === "Previous rounds");
    if (previous === undefined) {
        blocks.push({ heading: "Previous rounds", body: `${history}` });
    } else {
        previous.body = `${previous.body.replace(/\n+$/, "")}\n\n${history}`;
    }
    if (log !== undefined) {
        log.body = "\n";
    }
    return join_mission(blocks);
}
