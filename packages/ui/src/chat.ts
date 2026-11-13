// The chat's pure half (docs/designs/talk-change-ship.md, 5.2 to 5.5): what a tool row says,
// which entries are drawn, what Enter does in the message box, and the text of a message
// with its attached images. `AgentChat.tsx` draws them.
import type { Entry } from "./transcript.ts";

/** The entries drawn when the tab opens, and how many `show earlier` adds. */
export const CHAT_SHOWN_START = 150;
export const CHAT_SHOWN_STEP = 300;
/** A tool row's summary is cut at this many characters; the opened row shows it whole. */
export const TOOL_SUMMARY_MAX = 140;
/** An opened tool row shows this much of a result; `show all` lifts it. */
export const TOOL_RESULT_SHOWN = 4000;
/** The message box grows to this many lines, then scrolls. */
export const BOX_LINES_MAX = 12;

type ToolEntry = Extract<Entry, { kind: "tool" }>;

function oneLine(text: string): string {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > TOOL_SUMMARY_MAX ? `${line.slice(0, TOOL_SUMMARY_MAX)}…` : line;
}

/** The argument a tool acts on, by the names pi's tools and Spinner's use. */
const SUBJECT_KEYS = ["command", "path", "file_path", "pattern", "url", "text", "title", "name"];

/**
 * What a tool call acts on, in one line: the command of `bash`, the path of `read`, `edit`
 * and `write`, else the first of the usual arguments, else the arguments as JSON.
 */
export function toolSummary(entry: ToolEntry): string {
    const args = entry.args;
    if (typeof args !== "object" || args === null) {
        return typeof args === "string" ? oneLine(args) : "";
    }
    const record = args as Record<string, unknown>;
    for (const key of SUBJECT_KEYS) {
        const value = record[key];
        if (typeof value === "string" && value.length > 0) {
            // A command-style tool (`stack`, `pr`, `change`) reads better with its target.
            const target = key === "command" && entry.name !== "bash" ? subjectAfter(record) : "";
            return oneLine(`${value}${target}`);
        }
    }
    const json = JSON.stringify(record);
    return json === "{}" ? "" : oneLine(json);
}

/** ` · <value>` of the first other string argument of a command-style tool. */
function subjectAfter(record: Record<string, unknown>): string {
    for (const [key, value] of Object.entries(record)) {
        if (key !== "command" && typeof value === "string" && value.length > 0) {
            return ` · ${value}`;
        }
    }
    return "";
}

/** A tool's arguments and result as text, for the opened row. */
export function toolText(value: unknown): string {
    if (value === undefined || value === null) {
        return "";
    }
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** The newest `shown` entries, and how many older ones are held back. */
export function windowed<T>(
    entries: readonly T[],
    shown: number,
): { entries: T[]; earlier: number } {
    const earlier = Math.max(0, entries.length - shown);
    return { entries: entries.slice(earlier), earlier };
}

/** The keys of a keydown in the message box that this file reads. */
export interface BoxKey {
    key: string;
    shiftKey: boolean;
    /** True while an input method composes a character; Enter then picks a candidate. */
    isComposing: boolean;
}

/** Enter sends; Shift+Enter makes a new line; Enter inside an input method does neither. */
export function sendsOnKey(event: BoxKey): boolean {
    return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

/** The lines the message box shows for `text`: its own lines, between 1 and the bound. */
export function boxRows(text: string): number {
    return Math.min(BOX_LINES_MAX, Math.max(1, text.split("\n").length));
}

/**
 * The message as the agent gets it: the text, then one line per attached file with its
 * absolute path. The agent reads a file with its `read` tool; an image goes to it as an
 * image too, and the line still names where it is (5.5).
 */
export function messageWithFiles(text: string, paths: readonly string[]): string {
    const body = text.trim();
    if (paths.length === 0) {
        return body;
    }
    const lines = paths.map((path) => `Attached file: ${path}`);
    return body === "" ? lines.join("\n") : [body, "", ...lines].join("\n");
}

/** `2 images`, `1 image`: the mark of a past message that carried images. */
export function imagesLabel(count: number): string {
    return count === 1 ? "1 image" : `${count} images`;
}

// The Devin-style reading of a transcript (the operator's request of 2026-11-13): a turn is
// the operator's message, then the agent's work folded to one line, then its answer.

type AssistantEntry = Extract<Entry, { kind: "assistant" }>;

/** One thing the agent did inside a turn's work: a thought, a remark, or a tool call. */
export type WorkItem =
    | { kind: "thinking"; text: string }
    | { kind: "remark"; text: string }
    | { kind: "tool"; entry: ToolEntry };

/** What the chat draws, top to bottom. `key` is the index of the block's first entry. */
export type ChatBlock =
    | { kind: "user"; key: number; entry: Extract<Entry, { kind: "user" }> }
    | { kind: "answer"; key: number; entry: AssistantEntry }
    | { kind: "note"; key: number; text: string }
    | {
          kind: "work";
          key: number;
          items: WorkItem[];
          /** Tool calls in the group, and how many of them failed. */
          steps: number;
          failed: number;
          /** From the turn's start to its answer, in seconds; null without timestamps. */
          seconds: number | null;
          /** True for the last group of a turn that still runs. */
          live: boolean;
      };

/**
 * The blocks of a transcript. Within a turn (the entries after one operator message), the
 * agent's last text with no tool call after it is the answer; every thought, earlier remark
 * and tool call before it is the turn's work, one folded block. A turn that still runs and
 * has no such text yet is work alone.
 */
export function chatBlocks(entries: readonly Entry[], running: boolean): ChatBlock[] {
    const blocks: ChatBlock[] = [];
    let start = 0;
    for (let index = 0; index <= entries.length; index += 1) {
        const entry = entries[index];
        if (index < entries.length && entry?.kind !== "user") {
            continue;
        }
        if (index > start) {
            const last = index === entries.length;
            blocks.push(...turnBlocks(entries, start, index, running && last));
        }
        if (entry?.kind === "user") {
            blocks.push({ kind: "user", key: index, entry });
        }
        start = index + 1;
    }
    return blocks;
}

/** The blocks of the entries `[from, to)`, which hold no operator message. */
function turnBlocks(
    entries: readonly Entry[],
    from: number,
    to: number,
    live: boolean,
): ChatBlock[] {
    let answer = -1;
    for (let index = to - 1; index >= from; index -= 1) {
        const entry = entries[index];
        if (entry?.kind === "tool") {
            break;
        }
        if (entry?.kind === "assistant" && entry.text.trim() !== "") {
            answer = index;
            break;
        }
    }
    const blocks: ChatBlock[] = [];
    const items: WorkItem[] = [];
    let first_ts: number | null = null;
    let last_ts: number | null = null;
    const work_end = answer === -1 ? to : answer + 1;
    for (let index = from; index < work_end; index += 1) {
        const entry = entries[index];
        if (entry === undefined) {
            continue;
        }
        if (entry.kind === "note") {
            blocks.push({ kind: "note", key: index, text: entry.text });
        } else if (entry.kind === "tool") {
            items.push({ kind: "tool", entry });
        } else if (entry.kind === "assistant") {
            first_ts ??= entry.ts ?? null;
            last_ts = entry.ts ?? last_ts;
            if (entry.thinking.trim() !== "") {
                items.push({ kind: "thinking", text: entry.thinking.trim() });
            }
            if (index !== answer && entry.text.trim() !== "") {
                items.push({ kind: "remark", text: entry.text.trim() });
            }
        }
    }
    const before = entries[from - 1];
    const began = before?.kind === "user" ? (before.ts ?? first_ts) : first_ts;
    if (items.length > 0) {
        const tools = items.filter((item) => item.kind === "tool");
        const seconds =
            began === null || last_ts === null ? null : Math.max(0, (last_ts - began) / 1000);
        blocks.push({
            kind: "work",
            key: from,
            items,
            steps: tools.length,
            failed: tools.filter((item) => item.kind === "tool" && item.entry.state === "error")
                .length,
            seconds,
            live: live && answer === -1,
        });
    }
    const answered = entries[answer];
    if (answered?.kind === "assistant") {
        blocks.push({ kind: "answer", key: answer, entry: answered });
    }
    for (let index = work_end; index < to; index += 1) {
        const entry = entries[index];
        if (entry?.kind === "note") {
            blocks.push({ kind: "note", key: index, text: entry.text });
        }
    }
    return blocks;
}

/** `8s`, `2m 29s`, `1h 4m`. */
export function durationText(seconds: number): string {
    const whole = Math.round(seconds);
    if (whole < 60) {
        return `${whole}s`;
    }
    if (whole < 3600) {
        return `${Math.floor(whole / 60)}m ${whole % 60}s`;
    }
    return `${Math.floor(whole / 3600)}h ${Math.floor((whole % 3600) / 60)}m`;
}

type WorkBlock = Extract<ChatBlock, { kind: "work" }>;

/**
 * The folded line of a turn's work: `Thought for 8s`, `Worked for 2m 29s · 14 steps`, and
 * while it runs `Working · <what the running tool acts on>`.
 */
export function workLabel(block: WorkBlock): string {
    if (block.live) {
        const running = block.items.findLast(
            (item) => item.kind === "tool" && item.entry.state === "running",
        );
        if (running?.kind === "tool") {
            const subject = toolSummary(running.entry);
            return `Working · ${running.entry.name}${subject === "" ? "" : ` ${subject}`}`;
        }
        return block.steps === 0 ? "Thinking" : "Working";
    }
    const verb = block.steps === 0 ? "Thought" : "Worked";
    const time = block.seconds === null ? "" : ` for ${durationText(block.seconds)}`;
    const steps =
        block.steps === 0 ? "" : ` · ${block.steps} step${block.steps === 1 ? "" : "s"}`;
    const failed = block.failed === 0 ? "" : ` · ${block.failed} failed`;
    return `${verb}${time}${steps}${failed}`;
}

/** A command the box can complete after `/`: a skill or a prompt template of the agent. */
export interface SlashCommand {
    /** What follows the slash: `skill:pr-review`, `plan`. */
    name: string;
    kind: string;
    description: string;
}

/** The commands at most shown in the menu. */
export const SLASH_SHOWN_MAX = 8;

/**
 * The part of the box's text the slash menu completes: the word after a `/` that starts the
 * text, while the caret is still in it. Null when the text is not a command being typed.
 */
export function slashQuery(text: string): string | null {
    const match = /^\/(\S*)$/.exec(text);
    return match === null ? null : (match[1] ?? "");
}

/**
 * The commands that match what was typed after the slash: a name that starts with it first,
 * then a name or a description that holds it. A skill matches without its `skill:` prefix.
 */
export function slashMatches(commands: readonly SlashCommand[], query: string): SlashCommand[] {
    const wanted = query.toLowerCase();
    const bare = (command: SlashCommand) => command.name.replace(/^skill:/, "").toLowerCase();
    const starts = commands.filter(
        (command) => bare(command).startsWith(wanted) || command.name.startsWith(wanted),
    );
    const holds = commands.filter(
        (command) =>
            !starts.includes(command) &&
            (command.name.toLowerCase().includes(wanted) ||
                command.description.toLowerCase().includes(wanted)),
    );
    return [...starts, ...holds].slice(0, SLASH_SHOWN_MAX);
}

/** `claude-opus-5-5` of `anthropic/claude-opus-5-5`: the model as the box shows it. */
export function modelLabel(model: string | undefined): string {
    if (model === undefined || model === "" || model === "default") {
        return "model";
    }
    return model.slice(model.lastIndexOf("/") + 1);
}

/** The thinking levels pi knows, lowest first. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The box's text with dictated words added: one space between, none at the start. */
export function withDictation(text: string, spoken: string): string {
    const words = spoken.trim();
    if (words === "") {
        return text;
    }
    return text === "" || /\s$/.test(text) ? `${text}${words}` : `${text} ${words}`;
}

/**
 * The starts of the messages Spinner itself sends to an agent as a user message: a mission
 * change, the autopilot, a plan to implement, a design notice, a preview comment. pi records
 * them as the user's; the chat shows them as Spinner's notes, not as the operator's words.
 */
const SPINNER_STARTS = [
    "MISSION.md changed by",
    "Spinner autopilot:",
    "Spinner:",
    "Note from Spinner",
    "Implement the plan \"",
    "The design is approved:",
    "The design doc changed",
    "A preview comment",
    "Preview comment",
];

/** True for a user message that Spinner wrote, not the operator. */
export function isSpinnerNotice(text: string): boolean {
    const start = text.trimStart();
    return SPINNER_STARTS.some((prefix) => start.startsWith(prefix));
}
