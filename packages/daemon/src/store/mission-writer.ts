// The daemon's serialized writer for MISSION.md (docs/SESSION_PROTOCOL.md, "Editing rules").
// `apply_mission_write` is pure: the file text, one `MissionSectionRequest` and the time give
// the new text and the sections it changed. `MissionWriter` runs one write at a time per
// session through a promise chain, so two agents' tool calls never interleave a
// read-modify-write, and publishes `mission.changed` with the author. The time is the
// daemon's clock (lesson 1 of s001: agents guess the time). A hand edit still works for an
// agent without the extension; the watcher reports it as `author: unknown`.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EventBus } from "../event-bus.js";
import type { SpinnerHome } from "../home.js";
import type {
    MissionItemRequest,
    MissionSection,
    MissionSectionRequest,
    MissionSectionResponse,
    MissionView,
} from "@spinner/protocol";
import {
    LEAD_NAME,
    MISSION_ITEM_COMMANDS,
    QUESTION_ITEM_COMMANDS,
    is_entry_id,
    parse_entry_token,
} from "@spinner/protocol";
import {
    join_mission,
    mission_view,
    parse_questions,
    render_item,
    section_items,
    split_mission,
    with_ids,
    type MissionBlock,
    type MissionItem,
} from "../pipeline/mission-sections.js";
import { read_session } from "./session-store.js";

/** Heading of each section, as the template writes it. */
export const SECTION_HEADINGS: Record<MissionSection, string> = {
    goal: "Goal",
    done_when: "Done when",
    plan: "Plan",
    roster: "Roster",
    contracts: "Contracts & decisions",
    open_questions: "Open questions",
    log: "Log",
};

/** The daemon's own author: the one that writes Goal and Done when on the design track. */
export const SPEC_AUTHOR = "spinner";

/** Sections the operator owns; `replace` is allowed there and nowhere else. */
const REPLACEABLE: readonly MissionSection[] = ["goal", "done_when"];

/** Sections that take one appended line. The Roster takes rows, Goal and Done when bodies. */
const APPENDABLE: readonly MissionSection[] = ["plan", "contracts", "open_questions", "log"];

/** Sections the `item` mode works on: checklists (s014) and Open questions (dogfood #43). */
const ITEM_SECTIONS: readonly MissionSection[] = ["plan", "done_when", "open_questions"];

/** The authors that may resolve an Open question; anyone may ask and answer. */
const QUESTION_RESOLVERS: readonly string[] = [LEAD_NAME, "operator"];

/** Upper bound on one appended line or roster cell. Longer text belongs in NOTES.md. */
const TEXT_LENGTH_MAX = 4_000;

/** Upper bound on Roster rows; a session has at most three agents plus a fixer. */
const ROSTER_ROWS_MAX = 50;

const ROSTER_HEADER = "| Agent | Owns | Doing | Blocked? | Updated |";
const ROSTER_RULE = "|-------|------|-------|----------|---------|";

export interface MissionWriteResult {
    text: string;
    sections: MissionSection[];
}

/** Checks the request against the editing rules. Returns the reason when it is refused. */
export function validate_mission_write(request: MissionSectionRequest): string | null {
    if (!(request.section in SECTION_HEADINGS)) {
        return `unknown section "${String(request.section)}"`;
    }
    if (request.author.length === 0 || /[\s|]/.test(request.author)) {
        return "author must be one word";
    }
    if (request.text.length > TEXT_LENGTH_MAX) {
        return `text longer than ${TEXT_LENGTH_MAX} characters`;
    }
    if (request.mode === "replace" && !REPLACEABLE.includes(request.section)) {
        return `replace is allowed on goal and done_when only, not ${request.section}`;
    }
    if (request.mode === "append" && !APPENDABLE.includes(request.section)) {
        return `append is allowed on plan, contracts, open_questions and log, not ${
            request.section
        }`;
    }
    if (request.mode === "roster_row" && request.section !== "roster") {
        return "roster_row is allowed on roster only";
    }
    if (request.mode === "append" && request.text.trim().length === 0) {
        return "an appended line must not be empty";
    }
    if (request.mode !== "replace" && request.text.includes("\n")) {
        return "one line only; newlines are not allowed in this mode";
    }
    if (request.mode === "item") {
        return validate_item(request);
    }
    return null;
}

/** The `item` mode's own checks: the section, the command and the arguments it needs. */
function validate_item(request: MissionSectionRequest): string | null {
    if (!ITEM_SECTIONS.includes(request.section)) {
        return `item is allowed on plan, done_when and open_questions only, not ${
            request.section
        }`;
    }
    const item = request.item;
    if (item === undefined) {
        return "item mode needs `item`: the command and its arguments";
    }
    if (request.section === "open_questions") {
        return validate_question_item(item, request.author);
    }
    if (!(MISSION_ITEM_COMMANDS as readonly string[]).includes(item.command)) {
        return `item.command must be one of ${MISSION_ITEM_COMMANDS.join(", ")}`;
    }
    const needs_id = item.command !== "add" && item.command !== "reorder";
    if (needs_id && (item.id === undefined || !Number.isInteger(item.id) || item.id < 1)) {
        return `item.id must be a positive integer for ${item.command}`;
    }
    const needs_text = item.command === "add" || item.command === "edit";
    if (needs_text && (item.text === undefined || item.text.trim().length === 0)) {
        return `item.text must not be empty for ${item.command}`;
    }
    if (item.text !== undefined && item.text.includes("\n")) {
        return "item.text is one line";
    }
    if (item.text !== undefined && item.text.length > TEXT_LENGTH_MAX) {
        return `item.text longer than ${TEXT_LENGTH_MAX} characters`;
    }
    if (item.command === "assign" && (item.owner === undefined || /[\s|()]/.test(item.owner))) {
        return "item.owner must be one name for assign";
    }
    if (item.owner !== undefined && /[|()\n]/.test(item.owner)) {
        return "item.owner must be one name";
    }
    if (item.entry !== undefined && item.command !== "add") {
        return `item.entry is for add only, not ${item.command}`;
    }
    if (item.entry !== undefined && !is_entry_id(item.entry)) {
        return "item.entry must be an entry id such as `2.3`";
    }
    if (item.command === "reorder") {
        const order = item.order;
        if (!Array.isArray(order) || order.length === 0) {
            return "item.order must be a non-empty array of ids for reorder";
        }
        if (!order.every((id) => Number.isInteger(id) && id >= 1)) {
            return "item.order must hold positive integers";
        }
    }
    return null;
}

/** The checks of `answer` and `resolve` on `open_questions` (dogfood #43). */
function validate_question_item(item: MissionItemRequest, author: string): string | null {
    if (!(QUESTION_ITEM_COMMANDS as readonly string[]).includes(item.command)) {
        return `item.command must be one of ${QUESTION_ITEM_COMMANDS.join(", ")} on open_questions`;
    }
    if (item.id === undefined || !Number.isInteger(item.id) || item.id < 1) {
        return `item.id must be a positive integer for ${item.command}`;
    }
    const text = item.text ?? "";
    if (text.trim().length === 0 || text.includes("\n")) {
        return `item.text must be one non-empty line for ${item.command}`;
    }
    if (text.length > TEXT_LENGTH_MAX) {
        return `item.text longer than ${TEXT_LENGTH_MAX} characters`;
    }
    if (item.command === "resolve" && !QUESTION_RESOLVERS.includes(author)) {
        return "only the lead or the operator resolves a question";
    }
    return null;
}

/** Applies one validated write. `time` is `HH:MM` from the daemon's clock. */
export function apply_mission_write(
    text: string,
    request: MissionSectionRequest,
    time: string,
): MissionWriteResult {
    assert.equal(validate_mission_write(request), null, "request must be validated first");
    assert.ok(/^\d\d:\d\d$/.test(time), `time must be HH:MM, got "${time}"`);
    const blocks = split_mission(text);
    const block = block_for(blocks, request.section);
    if (request.mode === "replace") {
        block.body = `${request.text.replace(/\n+$/, "")}\n\n`;
    } else if (request.mode === "append") {
        append_line(block, append_text(request, time));
    } else if (request.mode === "item" && request.section === "open_questions") {
        assert.ok(request.item !== undefined);
        apply_question(block, request.item, request.author, time);
    } else if (request.mode === "item") {
        assert.ok(request.item !== undefined);
        apply_item(block, request.section, request.item, request.author, time);
    } else {
        upsert_roster_row(block, request, time);
    }
    return { text: join_mission(blocks), sections: [request.section] };
}

/**
 * One item command on a checklist section (MISSION.md s014, Contracts "item mode"). The
 * section's item lines are rewritten in canonical form; a Plan line without an id gets one
 * (`max + 1` in file order) on the way. Lines that are not items (notes under an item, the
 * blank line before the next heading) stay where they are, except that `reorder` keeps them
 * ahead of the items. Throws `MissionWriteError` for an id the section does not have.
 */
function apply_item(
    block: MissionBlock,
    section: MissionSection,
    request: MissionItemRequest,
    author: string,
    time: string,
): void {
    const lines = block.body.replace(/\n+$/, "").split("\n");
    const found = section_items(block.body).filter(
        ({ line }) => !PLAN_PLACEHOLDER.test(lines[line] ?? ""),
    );
    const is_plan = section === "plan";
    // Done when items are addressed by position; Plan items by the number in the file.
    const items: (MissionItem & { id: number })[] = is_plan
        ? with_ids(found.map(({ item }) => item))
        : found.map(({ item }, index) => ({ ...item, id: index + 1 }));
    const target = items.find((item) => item.id === request.id);
    if (request.command !== "add" && request.command !== "reorder" && target === undefined) {
        throw new MissionWriteError(`no item ${request.id} in ${section}`);
    }
    switch (request.command) {
        case "add": {
            const text = (request.text ?? "").trim();
            const owner = request.owner ?? (is_plan ? author : null);
            const id = is_plan ? items.reduce((max, item) => Math.max(max, item.id), 0) + 1 : null;
            const next = id ?? items.length + 1;
            const entry = request.entry ?? null;
            items.push({ checked: false, id: next, text, owner, entry, ticked_at: null });
            break;
        }
        case "tick":
            assert.ok(target !== undefined);
            target.checked = true;
            target.owner = is_plan ? (target.owner ?? author) : author;
            target.ticked_at = time;
            break;
        case "untick":
            assert.ok(target !== undefined);
            target.checked = false;
            target.ticked_at = null;
            break;
        case "edit": {
            // The entry link survives an edit (T3); a new text that starts with a token moves
            // the item to that entry.
            assert.ok(target !== undefined);
            const token = parse_entry_token((request.text ?? "").trim());
            target.text = token.rest;
            target.entry = token.entry ?? target.entry;
            break;
        }
        case "assign":
            assert.ok(target !== undefined);
            target.owner = request.owner ?? null;
            break;
        case "reorder": {
            const order = request.order ?? [];
            const missing = order.filter((id) => !items.some((item) => item.id === id));
            if (missing.length > 0) {
                throw new MissionWriteError(`no item ${missing.join(", ")} in ${section}`);
            }
            const listed = order.map((id) => items.find((item) => item.id === id));
            const rest = items.filter((item) => !order.includes(item.id));
            items.splice(0, items.length, ...(listed as typeof items), ...rest);
            break;
        }
    }
    write_items(block, lines, found, items, is_plan, request.command === "reorder");
}

/**
 * `answer` or `resolve` on question `request.id` (its 1-based position): writes
 * `  - HH:MM author: text`, with `[resolved] ` before a reason, after the question's last
 * non-blank line. Throws `MissionWriteError` for an unknown id or a second resolve.
 */
function apply_question(
    block: MissionBlock,
    request: MissionItemRequest,
    author: string,
    time: string,
): void {
    const id = request.id ?? 0;
    const question = parse_questions(block.body)[id - 1];
    if (question === undefined) {
        throw new MissionWriteError(`no item ${id} in open_questions`);
    }
    if (request.command === "resolve" && question.resolved !== null) {
        throw new MissionWriteError(`question ${id} is resolved already`);
    }
    const lines = block.body.replace(/\n+$/, "").split("\n");
    const heads = lines.flatMap((line, index) => (line.startsWith("- ") ? [index] : []));
    const head = heads[id - 1];
    assert.ok(head !== undefined, `question ${id} must have a line`);
    const next = heads[id] ?? lines.length;
    let last = head;
    for (let index = head + 1; index < next; index += 1) {
        if ((lines[index] ?? "").trim().length > 0) {
            last = index;
        }
    }
    const mark = request.command === "resolve" ? "[resolved] " : "";
    lines.splice(last + 1, 0, `  - ${time} ${author}: ${mark}${(request.text ?? "").trim()}`);
    block.body = `${lines.join("\n")}\n\n`;
    assert.equal(parse_questions(block.body).length, heads.length, "the count must not change");
}

/** Puts the items back: in place for an edit, after the other lines for a reorder or an add. */
export function write_items(
    block: MissionBlock,
    lines: string[],
    found: { line: number; item: MissionItem }[],
    items: (MissionItem & { id: number })[],
    is_plan: boolean,
    reordered: boolean,
): void {
    const rendered = items.map((item) => render_item(is_plan ? item : { ...item, id: null }));
    const item_lines = new Set(found.map(({ line }) => line));
    const others = lines.filter(
        (line, index) => !item_lines.has(index) && !PLAN_PLACEHOLDER.test(line),
    );
    let out: string[];
    if (reordered || found.length === 0) {
        out = [...others.filter((line) => line.trim().length > 0), ...rendered];
    } else {
        out = [];
        let next = 0;
        for (const [index, line] of lines.entries()) {
            if (PLAN_PLACEHOLDER.test(line)) {
                continue;
            }
            if (!item_lines.has(index)) {
                out.push(line);
                continue;
            }
            if (next < found.length) {
                out.push(rendered[next] ?? "");
                next += 1;
            }
        }
        // An added item goes after the last one; its line is not in `found`.
        out.push(...rendered.slice(found.length));
    }
    block.body = `${out.join("\n").replace(/\n+$/, "")}\n\n`;
}

/** The block with the section's heading; a missing section is added at the end. */
function block_for(blocks: MissionBlock[], section: MissionSection): MissionBlock {
    const heading = SECTION_HEADINGS[section];
    const found = blocks.find((entry) => entry.heading === heading);
    if (found !== undefined) {
        return found;
    }
    const last = blocks[blocks.length - 1];
    if (last !== undefined && !last.body.endsWith("\n\n")) {
        last.body = `${last.body.replace(/\n+$/, "")}\n\n`;
    }
    const created: MissionBlock = { heading, body: "\n" };
    blocks.push(created);
    return created;
}

function append_text(request: MissionSectionRequest, time: string): string {
    const text = request.text.trim();
    switch (request.section) {
        case "log":
        case "contracts":
            return `- ${time} ${request.author}: ${text}`;
        case "open_questions":
            return `- ${time} ${request.author}: ${text}`;
        case "plan":
            return plan_item(text);
        default:
            return text.startsWith("- ") ? text : `- ${text}`;
    }
}

/** A Plan line is a checkbox item: `1. x` and `- 1. x` become `- [ ] 1. x`; `- [x] 1. x` stays. */
function plan_item(text: string): string {
    const bare = text.replace(/^-\s+/, "");
    return /^\[[ x]\]\s/.test(bare) ? `- ${bare}` : `- [ ] ${bare}`;
}

/** The template's empty item (`- [ ] 1. `) goes when the first real item arrives. */
export const PLAN_PLACEHOLDER = /^- \[ \] \d+\.\s*$/;

/** Appends `line` after the last non-blank line; the blank line before the next heading stays. */
function append_line(block: MissionBlock, line: string): void {
    const body = block.body
        .replace(/\n+$/, "")
        .split("\n")
        .filter((existing) => !PLAN_PLACEHOLDER.test(existing))
        .join("\n");
    block.body = body.length === 0 ? `${line}\n\n` : `${body}\n${line}\n\n`;
}

/** Replaces the row of `author`, or adds one; the header and rule are created when absent. */
function upsert_roster_row(
    block: MissionBlock,
    request: MissionSectionRequest,
    time: string,
): void {
    const lines = block.body.replace(/\n+$/, "").split("\n");
    const rows = lines.filter((line) => line.startsWith("|"));
    assert.ok(rows.length <= ROSTER_ROWS_MAX, `more than ${ROSTER_ROWS_MAX} roster rows`);
    const header_index = rows.length >= 2 ? 0 : -1;
    const table = header_index === -1 ? [ROSTER_HEADER, ROSTER_RULE] : rows;
    const doing = cell(request.text.trim().length === 0 ? "—" : request.text);
    const blocked_raw = request.blocked ?? "";
    const blocked = cell(blocked_raw === "" ? "no" : blocked_raw);
    let replaced = false;
    const next = table.map((row, index) => {
        if (index < 2) {
            return row;
        }
        const cells = split_row(row);
        if (cells[0] !== request.author) {
            return row;
        }
        replaced = true;
        return `| ${cells[0]} | ${cells[1] ?? ""} | ${doing} | ${blocked} | ${time} |`;
    });
    if (!replaced) {
        next.push(`| ${request.author} | — | ${doing} | ${blocked} | ${time} |`);
    }
    const other = lines.filter((line) => !line.startsWith("|") && line.trim().length > 0);
    block.body = `${[...other, ...next].join("\n")}\n\n`;
}

/** Cells of `| a | b | c |`, trimmed. */
export function split_row(row: string): string[] {
    return row
        .replace(/^\|/, "")
        .replace(/\|\s*$/, "")
        .split("|")
        .map((part) => part.trim());
}

/** A pipe inside a cell would split the row; it becomes a slash. */
function cell(text: string): string {
    return text.trim().replace(/\|/g, "/");
}

export interface MissionWriterOptions {
    now?: () => Date;
}

/** Who last wrote through the daemon and when, for the watcher's author attribution. */
export interface LastWrite {
    author: string;
    at: number;
    sections: MissionSection[];
}

export class MissionWriter {
    private readonly chains = new Map<string, Promise<unknown>>();
    private readonly last = new Map<string, LastWrite>();
    private readonly last_notes = new Map<string, number>();
    private readonly now: () => Date;

    constructor(
        private readonly home: SpinnerHome,
        private readonly bus: EventBus,
        options: MissionWriterOptions = {},
    ) {
        this.now = options.now ?? (() => new Date());
    }

    /**
     * Applies the write to `<sessions>/<dir>/MISSION.md` after every earlier write on that
     * session finished. Throws on a refused request or a missing file.
     */
    write(dir: string, request: MissionSectionRequest): Promise<MissionSectionResponse> {
        const previous = this.chains.get(dir) ?? Promise.resolve();
        const run = previous.then(() => this.write_now(dir, request));
        // A failed write must not poison the chain for the next writer.
        this.chains.set(
            dir,
            run.catch(() => undefined),
        );
        return run;
    }

    /** The last write through this writer on `dir`, for attributing a file change. */
    last_write(dir: string): LastWrite | null {
        return this.last.get(dir) ?? null;
    }

    /** When this writer last rewrote `agents/<agent>/NOTES.md`, in epoch ms; null if never. */
    last_notes_write(dir: string, agent: string): number | null {
        return this.last_notes.get(`${dir}/${agent}`) ?? null;
    }

    /**
     * On the design track the design doc is the spec (docs/designs/egm-adoption.md, D6, T11):
     * only `spinner` writes Goal and Done when. The session is read before each write, so a
     * track switch applies at the next write.
     */
    private design_refusal(dir: string, request: MissionSectionRequest): string | null {
        if (request.section !== "goal" && request.section !== "done_when") {
            return null;
        }
        if (request.author === SPEC_AUTHOR) {
            return null;
        }
        const read = read_session(this.home, dir);
        const design = read.ok ? read.summary.session.design : undefined;
        if (design?.track !== "design") {
            return null;
        }
        return `this session's spec is the design doc (${design.doc ?? "not named yet"})`;
    }

    private write_now(dir: string, request: MissionSectionRequest): MissionSectionResponse {
        const reason = validate_mission_write(request) ?? this.design_refusal(dir, request);
        if (reason !== null) {
            throw new MissionWriteError(reason);
        }
        const file = join(this.home.sessions, dir, "MISSION.md");
        const now = this.now();
        const result = apply_mission_write(readFileSync(file, "utf8"), request, hh_mm(now));
        writeFileSync(file, result.text);
        const sections = result.sections;
        this.last.set(dir, { author: request.author, at: now.getTime(), sections });
        if (request.mode === "roster_row") {
            const notes = join(this.home.sessions, dir, "agents", request.author, "NOTES.md");
            mkdirSync(dirname(notes), { recursive: true });
            writeFileSync(notes, render_notes(result.text, request.author, hh_mm(now)));
            this.last_notes.set(`${dir}/${request.author}`, now.getTime());
        }
        this.bus.publish({
            type: "mission.changed",
            ts: now.toISOString(),
            session: dir,
            author: request.author,
            sections: result.sections,
            view: mission_view(result.text),
        });
        return { ok: true, sections: result.sections };
    }

    /**
     * Runs `work` after every earlier write on the session and before the next one, for a
     * change to MISSION.md that is not a section write (the title line). Publishes
     * `mission.changed` as `author` with the view afterwards.
     */
    serialized<T>(dir: string, author: string, work: () => T): Promise<T> {
        const previous = this.chains.get(dir) ?? Promise.resolve();
        const run = previous.then(() => {
            const result = work();
            const now = this.now();
            this.last.set(dir, { author, at: now.getTime(), sections: [] });
            const file = join(this.home.sessions, dir, "MISSION.md");
            this.bus.publish({
                type: "mission.changed",
                ts: now.toISOString(),
                session: dir,
                author,
                sections: [],
                view: mission_view(readFileSync(file, "utf8")),
            });
            return result;
        });
        this.chains.set(
            dir,
            run.catch(() => undefined),
        );
        return run;
    }

    /**
     * Reads `MISSION.md`, applies `change` to its text and writes the result, after every
     * earlier write on the session and before the next one; publishes one `mission.changed`
     * as `author` with the whole view. The seed uses it (session-workspace T4).
     */
    rewrite(dir: string, author: string, change: (text: string) => string): Promise<void> {
        assert.ok(author.length > 0, "rewrite needs an author");
        return this.serialized(dir, author, () => {
            const file = join(this.home.sessions, dir, "MISSION.md");
            writeFileSync(file, change(readFileSync(file, "utf8")));
        });
    }

    /** The structured mission of `dir` as the file is now. */
    view(dir: string): MissionView {
        const file = join(this.home.sessions, dir, "MISSION.md");
        return mission_view(readFileSync(file, "utf8"));
    }
}

/** Upper bound on the agent's Log lines NOTES.md keeps. */
const NOTES_LOG_LINES_MAX = 20;

/**
 * `agents/<agent>/NOTES.md` (docs/SESSION_PROTOCOL.md, "Agent files"): the long form of the
 * Roster row, rewritten when the row changes: the row's cells and the agent's recent Log
 * lines, for the UI and the operator. An agent with more to say appends below the marker.
 */
export function render_notes(mission: string, agent: string, time: string): string {
    const blocks = split_mission(mission);
    const roster = blocks.find((block) => block.heading === SECTION_HEADINGS.roster)?.body ?? "";
    const row = roster
        .split("\n")
        .filter((line) => line.startsWith("|"))
        .map(split_row)
        .find((cells) => cells[0] === agent);
    const log = blocks.find((block) => block.heading === SECTION_HEADINGS.log)?.body ?? "";
    const own = log
        .split("\n")
        .filter((line) => new RegExp(`^- \\d\\d:\\d\\d ${agent}: `).test(line))
        .slice(-NOTES_LOG_LINES_MAX);
    return [
        `# ${agent}`,
        "",
        `Updated ${time} by the daemon from the Roster row.`,
        "",
        `- Doing: ${row?.[2] ?? "—"}`,
        `- Blocked?: ${row?.[3] ?? "no"}`,
        `- Owns: ${row?.[1] ?? "—"}`,
        "",
        "## Recent Log lines",
        ...(own.length === 0 ? ["(none yet)"] : own),
        "",
    ].join("\n");
}

/** A refused request: the route answers 400 with the message. */
export class MissionWriteError extends Error {}

/** Local `HH:MM`, the form the Log uses. */
export function hh_mm(date: Date): string {
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
}
