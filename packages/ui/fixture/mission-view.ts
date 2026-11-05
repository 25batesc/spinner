// The fixture's structured mission: `GET /sessions/:dir/mission/view` and the `item` mode of
// the section route, in the daemon's format (`- [ ] 3. text (owner)`, `- [x] 3. text (owner,
// 14:02)`, `- [ ] 3. [1.5] text (owner)` with the entry token). A compact mirror of
// `packages/daemon/src/pipeline/mission-sections.ts`, enough for the UI drivers; the daemon's
// own tests cover the edge cases. The token rule is `@spinner/protocol`'s, as in the daemon.
// Open questions are stamped, answered and resolved in place (dogfood #43): `applyQuestion`.
import type {
    DoneWhenItem, LogLine, MissionItemRequest, MissionLine, MissionView, PlanItem,
    QuestionItem, RosterRow,
} from "@spinner/protocol";
import { parse_entry_token, render_entry_token } from "@spinner/protocol";

interface Item {
    checked: boolean;
    id: number | null;
    text: string;
    owner: string | null;
    entry: string | null;
    ticked_at: string | null;
}

const ITEM_LINE = /^- \[( |x)\]\s*(?:(\d+)\.\s*)?(.*?)\s*$/;
const TRAILING_PAREN = /^(.*?)\s*\(([^()]*)\)$/;
const TIME = /^\d\d:\d\d$/;
const OWNER = /^(?:the )?[A-Za-z0-9_.-]+$/;
const STAMPED = /^(\S+)\s+([^:]+?):\s*(.*)$/;
const AUTHORED = /^([^:\s][^:]*?):\s*(.*)$/;

export function parseItem(line: string): Item | null {
    const match = ITEM_LINE.exec(line);
    if (match === null || match[3] === undefined || match[3] === "") {
        return null;
    }
    const item: Item = {
        checked: match[1] === "x", id: match[2] === undefined ? null : Number(match[2]),
        text: match[3], owner: null, entry: null, ticked_at: null,
    };
    const paren = TRAILING_PAREN.exec(item.text);
    const parts = paren?.[2]?.split(",").map((part) => part.trim()) ?? [];
    const owner = parts[0] ?? "";
    if (paren?.[1] !== undefined && OWNER.test(owner) && parts.length <= 3) {
        item.owner = owner;
        item.ticked_at = parts.slice(1).find((part) => TIME.test(part)) ?? null;
        item.text = paren[1];
    }
    const token = parse_entry_token(item.text);
    item.entry = token.entry;
    item.text = token.rest;
    return item;
}

export function renderItem(item: Item): string {
    const id = item.id === null ? "" : `${item.id}. `;
    const owner = item.owner ?? (item.ticked_at === null ? null : "?");
    let tail = "";
    if (owner !== null) {
        tail = item.ticked_at === null ? ` (${owner})` : ` (${owner}, ${item.ticked_at})`;
    }
    const text = render_entry_token(item.entry, item.text);
    return `- [${item.checked ? "x" : " "}] ${id}${text}${tail}`;
}

function sectionLines(text: string, heading: string): { start: number; end: number } | null {
    const lines = text.split("\n");
    const start = lines.indexOf(`## ${heading}`);
    if (start === -1) {
        return null;
    }
    const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
    return { start: start + 1, end: next === -1 ? lines.length : next };
}

function body(text: string, heading: string): string {
    const span = sectionLines(text, heading);
    return span === null ? "" : text.split("\n").slice(span.start, span.end).join("\n");
}

function items(bodyText: string): Item[] {
    return bodyText.split("\n").map(parseItem).filter((item): item is Item => item !== null);
}

/** Plan items without an id get `max + 1` in file order. */
function withIds(list: Item[]): (Item & { id: number })[] {
    let max = Math.max(0, ...list.map((item) => item.id ?? 0));
    return list.map((item) => {
        if (item.id !== null) {
            return { ...item, id: item.id };
        }
        max += 1;
        return { ...item, id: max };
    });
}

function parseRoster(bodyText: string): RosterRow[] {
    const rows: RosterRow[] = [];
    for (const line of bodyText.split("\n")) {
        if (!line.startsWith("|")) {
            continue;
        }
        const cells = line.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
        const agent = cells[0] ?? "";
        if (agent === "" || agent === "Agent" || /^-+$/.test(agent)) {
            continue;
        }
        rows.push({
            agent, owns: cells[1] ?? "", doing: cells[2] ?? "", blocked: cells[3] ?? "",
            updated: cells[4] ?? "",
        });
    }
    return rows;
}

function entries(bodyText: string): { head: string; rest: string[] }[] {
    const out: { head: string; rest: string[] }[] = [];
    for (const line of bodyText.split("\n")) {
        if (line.startsWith("- ")) {
            out.push({ head: line.slice(2).trim(), rest: [] });
        } else if (line.trim() !== "" && out.length > 0) {
            out[out.length - 1]?.rest.push(line.trim());
        }
    }
    return out;
}

function parseLines(bodyText: string): MissionLine[] {
    return entries(bodyText).map(({ head, rest }, index) => {
        const tail = rest.length === 0 ? "" : `\n${rest.join("\n")}`;
        const stamped = STAMPED.exec(head);
        if (stamped !== null) {
            const [, ts = "", author = "", text = ""] = stamped;
            return { id: index + 1, ts, author, text: `${text}${tail}` };
        }
        const authored = AUTHORED.exec(head);
        if (authored !== null && authored[1] !== undefined && !authored[1].includes(" ")) {
            const text = `${authored[2] ?? ""}${tail}`;
            return { id: index + 1, ts: null, author: authored[1], text };
        }
        return { id: index + 1, ts: null, author: null, text: `${head}${tail}` };
    });
}

/** `HH:MM author: text`, the stamped question and answer form (#43). */
const QUESTION_STAMPED = /^(\d\d:\d\d)\s+([^:\s]+):\s*(.*)$/;
/** `HH:MM author: [resolved] reason` under a question; the time is optional. */
const RESOLVED = /^(?:(\d\d:\d\d)\s+)?([^:\s]+):\s*\[resolved\]\s*(.*)$/;

function parseQuestions(bodyText: string): QuestionItem[] {
    return entries(bodyText).map(({ head, rest }, index) => {
        const stamped = QUESTION_STAMPED.exec(head);
        const authored = stamped === null ? AUTHORED.exec(head) : null;
        const named = authored?.[1] !== undefined && !authored[1].includes(" ");
        const author = stamped?.[2] ?? (named ? (authored?.[1] ?? null) : null);
        const text = stamped?.[3] ?? (named ? (authored?.[2] ?? "") : head);
        const lines = rest.map((line) => line.replace(/^-\s+/, ""));
        let resolved: QuestionItem["resolved"] = null;
        const answers: string[] = [];
        for (const line of lines) {
            const match = RESOLVED.exec(line);
            if (match !== null && resolved === null) {
                const [, ts = null, by = null, reason = ""] = match;
                resolved = { ts, author: by, reason };
            } else {
                answers.push(line);
            }
        }
        return {
            id: index + 1, ts: stamped?.[1] ?? null, author, text,
            answer: answers.length === 0 ? null : answers.join("\n"), resolved,
        };
    });
}

/**
 * The `item` mode on `open_questions` (#43), as the daemon does it: `answer` writes
 * `  - HH:MM author: text` under question `id`, `resolve` writes `  - HH:MM author:
 * [resolved] text`. Only `lead` and `operator` resolve, once. Returns the new text or an error.
 */
export function applyQuestion(
    text: string, author: string, request: MissionItemRequest, now = clock(),
): { text: string } | { error: string } {
    if (request.command !== "answer" && request.command !== "resolve") {
        return { error: `item.command must be answer or resolve on open_questions` };
    }
    const reply = (request.text ?? "").trim();
    if (reply === "" || reply.includes("\n")) {
        return { error: `item.text must be one non-empty line for ${request.command}` };
    }
    if (request.command === "resolve" && author !== "lead" && author !== "operator") {
        return { error: "only the lead or the operator resolves a question" };
    }
    const span = sectionLines(text, "Open questions");
    const lines = text.split("\n");
    const heads = span === null ? [] : lines.slice(span.start, span.end)
        .map((line, index) => ({ line, at: span.start + index }))
        .filter(({ line }) => line.startsWith("- "));
    const target = heads[(request.id ?? 0) - 1];
    if (span === null || target === undefined) {
        return { error: `no item ${String(request.id)} in open_questions` };
    }
    const question = parseQuestions(body(text, "Open questions"))[(request.id ?? 0) - 1];
    if (request.command === "resolve" && question?.resolved !== null) {
        return { error: `question ${String(request.id)} is resolved already` };
    }
    // The new line goes after the question's last non-blank line under it.
    const next = heads.find(({ at }) => at > target.at)?.at ?? span.end;
    let last = target.at;
    for (let at = target.at + 1; at < next; at += 1) {
        if ((lines[at] ?? "").trim() !== "") {
            last = at;
        }
    }
    const mark = request.command === "resolve" ? "[resolved] " : "";
    lines.splice(last + 1, 0, `  - ${now} ${author}: ${mark}${reply}`);
    return { text: lines.join("\n") };
}

function parseLog(bodyText: string): LogLine[] {
    const lines: LogLine[] = [];
    for (const { head } of entries(bodyText)) {
        const stamped = STAMPED.exec(head);
        if (stamped !== null) {
            const [, ts = "", author = "", text = ""] = stamped;
            lines.push({ ts, author, text });
        }
    }
    return lines;
}

/** The structured mission of a MISSION.md text, as the daemon derives it on every read. */
export function missionView(text: string): MissionView {
    const roster = parseRoster(body(text, "Roster"));
    const heading = text.split("\n").find((line) => line.startsWith("# ")) ?? "";
    const title = /^\S+\s+·\s+(.+)$/.exec(heading.slice(2).trim())?.[1] ?? heading.slice(2).trim();
    const plan: PlanItem[] = withIds(items(body(text, "Plan"))).map((item) => {
        const row = roster.find((entry) => entry.agent === item.owner);
        const mention = new RegExp(`(?:#|\\bitem )${item.id}\\b`);
        const named = row !== undefined && mention.test(row.doing);
        return {
            id: item.id, text: item.text, owner: item.owner, entry: item.entry,
            ticked_at: item.ticked_at, state: item.checked ? "done" : named ? "doing" : "next",
        };
    });
    const doneWhen: DoneWhenItem[] = items(body(text, "Done when")).map((item, index) => ({
        id: index + 1, text: item.text, owner: item.owner, ticked_at: item.ticked_at,
        state: item.checked ? "done" : "open",
    }));
    return {
        title, goal: body(text, "Goal").trim(), done_when: doneWhen, plan, roster,
        contracts: parseLines(body(text, "Contracts & decisions")),
        questions: parseQuestions(body(text, "Open questions")),
        log: parseLog(body(text, "Log")),
    };
}

/** `HH:MM` local, as the daemon stamps a tick. */
export function clock(now = new Date()): string {
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
}

/**
 * The `item` mode on `plan` or `done_when`: returns the new text, or an error message. A
 * done_when item's id is its position; a Plan id is the number in the line.
 */
export function applyItem(
    text: string, section: "plan" | "done_when", author: string, request: MissionItemRequest,
    now = clock(),
): { text: string } | { error: string } {
    const heading = section === "plan" ? "Plan" : "Done when";
    const span = sectionLines(text, heading);
    if (span === null) {
        return { error: `no section ${heading}` };
    }
    const lines = text.split("\n");
    const list = lines.slice(span.start, span.end)
        .map((line, index) => ({ line: span.start + index, item: parseItem(line) }))
        .filter((entry): entry is { line: number; item: Item } => entry.item !== null);
    const withId = section === "plan"
        ? withIds(list.map((entry) => entry.item))
        : list.map((entry, index) => ({ ...entry.item, id: index + 1 }));
    const found = withId.findIndex((item) => item.id === request.id);
    const entry = list[found];
    if (request.command === "add") {
        if (request.text === undefined || request.text === "") {
            return { error: "add needs text" };
        }
        const id = section === "plan" ? Math.max(0, ...withId.map((i) => i.id)) + 1 : null;
        const owner = section === "plan" ? (request.owner ?? author) : null;
        const entry = section === "plan" ? (request.entry ?? null) : null;
        const line = renderItem({
            checked: false, id, text: request.text, owner, entry, ticked_at: null,
        });
        const at = list.length === 0 ? span.start : (list[list.length - 1]?.line ?? span.start) + 1;
        lines.splice(at, 0, line);
        return { text: lines.join("\n") };
    }
    if (entry === undefined) {
        return { error: `no item ${String(request.id)} in ${heading}` };
    }
    // A Plan item keeps the id the view gave it; a done_when id is a position, not written.
    const item: Item = {
        ...entry.item, id: section === "plan" ? (withId[found]?.id ?? null) : entry.item.id,
    };
    if (request.command === "tick") {
        item.checked = true;
        item.ticked_at = now;
        item.owner = section === "plan" ? (item.owner ?? author) : author;
    } else if (request.command === "untick") {
        item.checked = false;
        item.ticked_at = null;
    } else if (request.command === "edit") {
        if (request.text === undefined || request.text === "") {
            return { error: "edit needs text" };
        }
        // The entry link survives an edit; a new text that starts with a token moves the item.
        const token = parse_entry_token(request.text);
        item.text = token.rest;
        item.entry = token.entry ?? item.entry;
    } else if (request.command === "assign") {
        item.owner = request.owner ?? null;
    } else {
        return { error: `${request.command} is not supported by the fixture` };
    }
    lines[entry.line] = renderItem(item);
    return { text: lines.join("\n") };
}
