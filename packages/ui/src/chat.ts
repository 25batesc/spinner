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
 * The message as the agent gets it: the text, then one line per attached image with its
 * absolute path, which the agent reads with its `read` tool (5.5).
 */
export function messageWithImages(text: string, paths: readonly string[]): string {
    const body = text.trim();
    if (paths.length === 0) {
        return body;
    }
    const lines = paths.map((path) => `Attached image: ${path}`);
    return body === "" ? lines.join("\n") : [body, "", ...lines].join("\n");
}

/** `2 images`, `1 image`: the mark of a past message that carried images. */
export function imagesLabel(count: number): string {
    return count === 1 ? "1 image" : `${count} images`;
}
