// The chat's pure half (docs/designs/talk-change-ship.md, 5.2 to 5.5): what a tool row says,
// which entries are drawn, what Enter does in the message box, and the text of a message
// with its attached images. `AgentChat.tsx` draws them.
import { PENDING_PROMPT_SEPARATOR } from "@spinner/protocol";

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

/**
 * True when a drag carries files (a screenshot, a document) and not only text or a link:
 * the chat then takes the drop anywhere on it. `types` is the drag's `dataTransfer.types`.
 */
export function dragsFiles(types: readonly string[]): boolean {
    return types.includes("Files");
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
      }
    | HandledBlock;

/**
 * A turn the operator did not ask for: a message from Spinner or from another agent started
 * it. The chat folds it to that message's one line and the agent's brief, so the operator's
 * own conversation is not buried under it (s039: a quarter of the lead's answer text).
 */
export interface HandledBlock {
    kind: "handled";
    key: number;
    /** Who sent the message that started the turn: `SPINNER_SENDER`, or an agent's name. */
    from: string;
    /** The message's one line, and its whole text. */
    line: string;
    text: string;
    /** The turn's blocks: its work folded, then its answer. */
    blocks: ChatBlock[];
    /** The start of the agent's last words in the turn, its brief for the operator; "" without. */
    brief: string;
    /** True when `brief` is not the whole of those words. */
    clipped: boolean;
    /** Tool calls in the turn. */
    steps: number;
    /** True while the turn runs and has no answer yet. */
    live: boolean;
}

/** The characters of a handled turn's answer that show without opening the turn. */
export const BRIEF_CHARS_MAX = 320;

/**
 * The blocks of a transcript. Within a turn (the entries after one operator message), the
 * agent's last text with no tool call after it is the answer; every thought, earlier remark
 * and tool call before it is the turn's work, one folded block. A turn that still runs and
 * has no such text yet is work alone.
 */
export function chatBlocks(entries: readonly Entry[], running: boolean): ChatBlock[] {
    const blocks: ChatBlock[] = [];
    let start = 0;
    // The message from Spinner or an agent that started the turn being collected, if one did.
    let opener: Opener | null = null;
    for (let index = 0; index <= entries.length; index += 1) {
        const entry = entries[index];
        if (index < entries.length && entry?.kind !== "user") {
            continue;
        }
        const live = running && index === entries.length;
        const turn = index > start ? turnBlocks(entries, start, index, live) : [];
        if (opener === null) {
            blocks.push(...turn);
        } else {
            blocks.push(handledBlock(opener, turn, live));
        }
        opener = entry?.kind === "user" ? turnOpener(entries, index) : null;
        if (entry?.kind === "user" && opener === null) {
            blocks.push({ kind: "user", key: index, entry });
        }
        start = index + 1;
    }
    return blocks;
}

interface Opener {
    key: number;
    from: string;
    line: string;
    text: string;
}

/**
 * The user entry at `index` as the start of a turn the operator did not ask for, or null.
 * It is one when the whole message is Spinner's or another agent's, and no turn ran when it
 * came. pi delivers a message into a running turn after that turn's tool calls, so such a
 * message follows a tool entry: the turn then stays whose it was, and the message shows as
 * its one line inside it.
 */
function turnOpener(entries: readonly Entry[], index: number): Opener | null {
    const entry = entries[index];
    if (entry?.kind !== "user" || entries[index - 1]?.kind === "tool") {
        return null;
    }
    const notice = noticeOf(entry.text);
    if (notice === null || splitPendingNotices(entry.text).operator !== null) {
        return null;
    }
    return { key: index, from: notice.from, line: notice.line, text: entry.text.trim() };
}

function handledBlock(opener: Opener, blocks: ChatBlock[], running: boolean): HandledBlock {
    const answer = blocks.findLast((block) => block.kind === "answer");
    // Blank lines go: the brief shows as three lines at most, and each one must say something.
    const whole = answer?.kind === "answer" ? answer.entry.text.trim() : "";
    const said = whole.replace(/\n\s*\n/g, "\n");
    const steps = blocks.reduce((sum, block) => sum + (block.kind === "work" ? block.steps : 0), 0);
    return {
        kind: "handled",
        ...opener,
        blocks,
        brief: said.slice(0, BRIEF_CHARS_MAX),
        clipped: said.length > BRIEF_CHARS_MAX,
        steps,
        live: running && said === "",
    };
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

/**
 * The first line of an inbox message as the daemon delivers it to an agent:
 * `Message from bot (inbox/154824-bot-lead.md): the subject`.
 */
const INBOX_MESSAGE = /^Message from (\S+) \(inbox\/[^)]*\): ?(.*)$/;

/** The name an inbox message carries when the operator wrote it. */
const OPERATOR_SENDER = "operator";

/** The sender `noticeOf` names for a message Spinner itself wrote. */
export const SPINNER_SENDER = "Spinner";

/**
 * Who wrote a user message that is not the operator's, and its one line for the chat:
 * Spinner (a mission change, the autopilot), or another agent through the inbox. Null for
 * the operator's own words, an inbox message from the operator included. pi records all of
 * them as the user's; shown as the operator's bubbles, a worker's reports to the lead filled
 * the operator's chat with text that was not theirs and not for them (s039).
 *
 * The daemon may join the notices that waited for the agent's next prompt and the message
 * that then came, with `PENDING_PROMPT_SEPARATOR`. When that message is itself Spinner's or
 * an agent's (the autopilot waking an idle lead), it is the one named here: it started the
 * turn, and the notices before it only rode along.
 */
export function noticeOf(text: string): { from: string; line: string } | null {
    const first = partNotice(text);
    if (first === null) {
        return null;
    }
    const at = text.indexOf(PENDING_PROMPT_SEPARATOR);
    const last = at < 0 ? null : partNotice(text.slice(at + PENDING_PROMPT_SEPARATOR.length));
    return last ?? first;
}

/** `noticeOf` for one part of a message: the notices before the separator, or what follows. */
function partNotice(text: string): { from: string; line: string } | null {
    const start = text.trimStart();
    const first = start.split("\n")[0] ?? "";
    const inbox = INBOX_MESSAGE.exec(first);
    if (inbox !== null) {
        const from = inbox[1] ?? "";
        return from === OPERATOR_SENDER ? null : { from, line: inbox[2] ?? "" };
    }
    if (SPINNER_STARTS.some((prefix) => start.startsWith(prefix))) {
        // The chat names the sender itself: `Spinner autopilot: …` reads `autopilot: …`.
        return { from: SPINNER_SENDER, line: first.replace(/^Spinner:?\s+/, "") };
    }
    return null;
}

/** True for a user message that Spinner or another agent wrote, not the operator. */
export function isSpinnerNotice(text: string): boolean {
    return noticeOf(text) !== null;
}

/**
 * A user message as its parts: the notices queued for the agent's next prompt (Spinner's, or
 * another agent's inbox message), and the operator's own words after
 * `PENDING_PROMPT_SEPARATOR`. The daemon joins them into one
 * prompt when a notice could not be steered in while the agent ran; shown whole, the message
 * read as one notice and the operator's words were lost (s039). A message that starts with
 * a notice and has no separator is one notice; so is one whose part after the separator is
 * Spinner's or an agent's too. One that starts with the operator's words is theirs, whole.
 */
export function splitPendingNotices(
    text: string,
): { notice: string | null; operator: string | null } {
    if (!isSpinnerNotice(text)) {
        return { notice: null, operator: text };
    }
    const at = text.indexOf(PENDING_PROMPT_SEPARATOR);
    if (at < 0) {
        return { notice: text, operator: null };
    }
    const rest = text.slice(at + PENDING_PROMPT_SEPARATOR.length);
    // What follows the queued notices is not always the operator's: the autopilot, or an
    // agent's message, can be the prompt they were joined to. Then none of it is his.
    if (rest.trim() === "" || partNotice(rest) !== null) {
        return { notice: text, operator: null };
    }
    return { notice: text.slice(0, at), operator: rest };
}

/** A message the operator sent that the transcript has not shown yet. */
export interface SentMessage {
    text: string;
    /** When the box sent it, in ms. */
    ts: number;
    images?: number;
}

/**
 * The sent messages the transcript does not hold yet. The box shows a message the moment
 * it is sent: pi records a prompt only after its start hooks ran, and a steer only when the
 * running tool call ends, seconds later (s039: 1 to 13 s). A sent message is confirmed by a
 * user entry at or after its time whose operator text starts with it (the daemon may put
 * queued notices before it, and pi may add an image hint after it).
 */
export function unconfirmedSent(
    sent: readonly SentMessage[],
    entries: readonly Entry[],
): SentMessage[] {
    const users = entries.filter((entry) => entry.kind === "user");
    return sent.filter((message) => {
        const wanted = message.text.trim();
        return !users.some((entry) => {
            const recorded = (entry.ts ?? 0) >= message.ts - SENT_CLOCK_SLACK_MS;
            const text = (splitPendingNotices(entry.text).operator ?? "").trim();
            return recorded && text.startsWith(wanted);
        });
    });
}

/** pi stamps the message on its own clock; this much earlier than the box still counts. */
const SENT_CLOCK_SLACK_MS = 5_000;

/** A sent message the transcript still lacks after this long is dropped from the box. */
export const SENT_SHOWN_MS_MAX = 10 * 60_000;

/** After this long without an event from its pi, the chat says a working agent is quiet. */
export const QUIET_HINT_MS = 3 * 60_000;

/**
 * How long a turn has shown no sign of life: the time since the agent's last event, which
 * the daemon stamps (a long answer streams events the whole time). 0 without that time, or
 * when the clocks disagree.
 */
export function quietMs(now: number, active: string | null): number {
    const time = active === null ? Number.NaN : Date.parse(active);
    return Number.isNaN(time) ? 0 : Math.max(0, now - time);
}

/** `12 min`, `2 h 14 min`: a quiet time in the status line. */
export function quietText(ms: number): string {
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) {
        return `${minutes} min`;
    }
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The tool call that still runs, for the status line: `bash node play.mjs`; "" without. */
export function runningTool(entries: readonly Entry[]): string {
    const running = entries.findLast((entry) => entry.kind === "tool" && entry.state === "running");
    if (running?.kind !== "tool") {
        return "";
    }
    const subject = toolSummary(running);
    return subject === "" ? running.name : `${running.name} ${subject}`;
}

