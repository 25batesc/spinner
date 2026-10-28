// The daemon's serialized writer for MISSION.md (docs/SESSION_PROTOCOL.md, "Editing rules").
// `apply_mission_write` is pure: the file text, one `MissionSectionRequest` and the time give
// the new text and the sections it changed. `MissionWriter` runs one write at a time per
// session through a promise chain, so two agents' tool calls never interleave a
// read-modify-write, and publishes `mission.changed` with the author. The time is the
// daemon's clock (lesson 1 of s001: agents guess the time). A hand edit still works for an
// agent without the extension; the watcher reports it as `author: unknown`.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventBus } from "../event-bus.js";
import type { SpinnerHome } from "../home.js";
import type {
    MissionSection,
    MissionSectionRequest,
    MissionSectionResponse,
} from "@spinner/protocol";
import { join_mission, split_mission, type MissionBlock } from "../pipeline/mission-sections.js";

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

/** Sections the operator owns; `replace` is allowed there and nowhere else. */
const REPLACEABLE: readonly MissionSection[] = ["goal", "done_when"];

/** Sections that take one appended line. The Roster takes rows, Goal and Done when bodies. */
const APPENDABLE: readonly MissionSection[] = ["plan", "contracts", "open_questions", "log"];

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
    } else {
        upsert_roster_row(block, request, time);
    }
    return { text: join_mission(blocks), sections: [request.section] };
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
            return `- ${request.author}: ${text}`;
        default:
            return text.startsWith("- ") ? text : `- ${text}`;
    }
}

/** Appends `line` after the last non-blank line; the blank line before the next heading stays. */
function append_line(block: MissionBlock, line: string): void {
    const body = block.body.replace(/\n+$/, "");
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

    private write_now(dir: string, request: MissionSectionRequest): MissionSectionResponse {
        const reason = validate_mission_write(request);
        if (reason !== null) {
            throw new MissionWriteError(reason);
        }
        const file = join(this.home.sessions, dir, "MISSION.md");
        const now = this.now();
        const result = apply_mission_write(readFileSync(file, "utf8"), request, hh_mm(now));
        writeFileSync(file, result.text);
        const sections = result.sections;
        this.last.set(dir, { author: request.author, at: now.getTime(), sections });
        this.bus.publish({
            type: "mission.changed",
            ts: now.toISOString(),
            session: dir,
            author: request.author,
            sections: result.sections,
        });
        return { ok: true, sections: result.sections };
    }
}

/** A refused request: the route answers 400 with the message. */
export class MissionWriteError extends Error {}

/** Local `HH:MM`, the form the Log uses. */
export function hh_mm(date: Date): string {
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
}
