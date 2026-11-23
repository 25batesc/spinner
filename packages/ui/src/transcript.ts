// Folds pi's `agent.event` stream into what the agent tab shows: messages, tool calls, cost.
// It is a pure function of the events, so a reload that replays them gives the same tab.
import type {
    AgentPrompt,
    PiAssistantMessage,
    PiEvent,
    PiMessage,
    PiToolResultMessage,
} from "@spinner/protocol";

import { formatTokens } from "./costs.ts";

/**
 * The fold keeps this many entries. The daemon holds at most `TRANSCRIPT_EVENTS_MAX` events,
 * and one assistant message is an entry per tool call besides its own.
 */
export const ENTRIES_LIMIT = 6000;

type AssistantEntry = {
    kind: "assistant";
    text: string;
    thinking: string;
    done: boolean;
    /** The message's timestamp in ms, which matches it between the history and the live fold. */
    ts?: number;
    /** Why the message ended badly (pi's `errorMessage`, or `aborted`); absent when it did not. */
    error?: string;
};

export type Entry =
    | { kind: "user"; text: string; ts?: number; images?: number }
    | AssistantEntry
    | {
          kind: "tool";
          id: string;
          name: string;
          args: unknown;
          state: "running" | "ok" | "error";
          result?: unknown;
      }
    | { kind: "note"; text: string };

export interface Transcript {
    entries: Entry[];
    /** Sum of `usage.cost.total` over finished assistant messages, in dollars. */
    cost: number;
    /** True between `agent_start` and `agent_settled`. */
    running: boolean;
    /** Role of the message between `message_start` and `message_end`, else null. */
    open: "user" | "assistant" | null;
    /**
     * The question pi waits on (`ui_prompt_start` without its end): a damage-control
     * confirm, a select. Absent or null when none waits.
     */
    prompt?: AgentPrompt | null;
    /** True while pi compacts the agent's context; a message sent then is held, not lost. */
    compacting?: boolean;
}

export const emptyTranscript: Transcript = { entries: [], cost: 0, running: false, open: null };

function textOf(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }
    return content
        .map((part: { type?: string; text?: string }) =>
            part.type === "text" ? (part.text ?? "") : "",
        )
        .join("");
}

function assistantParts(message: PiAssistantMessage): { text: string; thinking: string } {
    const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    const thinking = message.content
        .map((part) => (part.type === "thinking" ? part.thinking : ""))
        .join("");
    return { text, thinking };
}

/** Changes the newest assistant entry; tool entries can come after it while it streams. */
function withLastAssistant(entries: Entry[], change: (last: AssistantEntry) => Entry): Entry[] {
    const index = entries.findLastIndex((entry) => entry.kind === "assistant");
    const found = entries[index];
    if (found === undefined || found.kind !== "assistant") {
        return entries;
    }
    return [...entries.slice(0, index), change(found), ...entries.slice(index + 1)];
}

/** The message's `timestamp` when it carries one (the three core roles do). */
function tsOf(message: PiMessage): { ts?: number } {
    const ts = (message as { timestamp?: unknown }).timestamp;
    return typeof ts === "number" ? { ts } : {};
}

/** How many images a user message carries; they are not shown inline. */
function imagesOf(content: unknown): { images?: number } {
    if (!Array.isArray(content)) {
        return {};
    }
    const count = content.filter((part: { type?: string }) => part.type === "image").length;
    return count === 0 ? {} : { images: count };
}

function userEntry(message: PiMessage): Entry {
    return {
        kind: "user",
        text: textOf(message.content),
        ...tsOf(message),
        ...imagesOf(message.content),
    };
}

/** The finished assistant message as an entry, with why it ended badly when it did. */
function assistantEntry(message: PiAssistantMessage): AssistantEntry {
    const failed = message.stopReason === "error" || message.stopReason === "aborted";
    const error = failed ? (message.errorMessage ?? message.stopReason) : undefined;
    return {
        kind: "assistant",
        ...assistantParts(message),
        done: true,
        ...tsOf(message),
        ...(error === undefined ? {} : { error }),
    };
}

function startMessage(state: Transcript, message: PiMessage): Transcript {
    if (message.role === "user") {
        const entries = [...state.entries, userEntry(message)];
        return { ...state, entries, open: "user" };
    }
    if (message.role === "assistant") {
        const entry: Entry = {
            kind: "assistant", text: "", thinking: "", done: false, ...tsOf(message),
        };
        return { ...state, entries: [...state.entries, entry], open: "assistant" };
    }
    return state;
}

function toolEntry(id: string, name: string, args: unknown): Entry {
    return { kind: "tool", id, name, args, state: "running" };
}

/**
 * Handles `message_end`. A live message was opened by `message_start`. A message in the
 * daemon's history has only `message_end`, so it is appended whole, with its tool calls.
 */
function endMessage(state: Transcript, message: PiMessage): Transcript {
    const opened = state.open === message.role;
    const closed = { ...state, open: null };
    if (message.role === "user") {
        return opened ? closed : { ...closed, entries: [...state.entries, userEntry(message)] };
    }
    if (message.role === "toolResult") {
        const result = message as PiToolResultMessage;
        const entries = toolEnd(state.entries, {
            toolCallId: result.toolCallId,
            result: textOf(result.content),
            isError: result.isError,
        });
        return { ...closed, entries };
    }
    if (message.role !== "assistant") {
        return closed;
    }
    const assistant = message as PiAssistantMessage;
    const done: Entry = assistantEntry(assistant);
    const cost = state.cost + (assistant.usage?.cost?.total ?? 0);
    // The message's tool calls show from here, whether or not `tool_execution_start` comes:
    // the daemon's page holds a finished call as its messages alone. A call that shows
    // already (its start came first) is not added again.
    const ids = state.entries.flatMap((entry) => (entry.kind === "tool" ? [entry.id] : []));
    const shown = new Set(ids);
    const tools: Entry[] = assistant.content.flatMap((part) =>
        part.type === "toolCall" && !shown.has(part.id)
            ? [toolEntry(part.id, part.name, part.arguments)]
            : [],
    );
    const before = opened
        ? withLastAssistant(state.entries, () => done)
        : [...state.entries, done];
    return { ...closed, entries: [...before, ...tools], cost };
}

type Update = Extract<PiEvent, { type: "message_update" }>;
type ToolEnd = Extract<PiEvent, { type: "tool_execution_end" }>;

function updateMessage(entries: Entry[], event: Update): Entry[] {
    const delta = event.assistantMessageEvent;
    return withLastAssistant(entries, (last) => {
        if (delta.type === "text_delta") {
            return { ...last, text: last.text + delta.delta };
        }
        if (delta.type === "thinking_delta") {
            return { ...last, thinking: last.thinking + delta.delta };
        }
        return last;
    });
}

function toolEnd(
    entries: Entry[],
    event: Pick<ToolEnd, "toolCallId" | "result" | "isError">,
): Entry[] {
    return entries.map((entry) =>
        entry.kind === "tool" && entry.id === event.toolCallId
            ? { ...entry, state: event.isError ? "error" : "ok", result: event.result }
            : entry,
    );
}

type CompactionEnd = Extract<PiEvent, { type: "compaction_end" }>;

/** What a finished compaction says in the chat: the figures, or why it did not happen. */
export function compactionNote(event: CompactionEnd): string {
    if (event.aborted) {
        return "The compaction was stopped. The context is as it was.";
    }
    if (event.errorMessage !== undefined) {
        return `${event.errorMessage.replace(/\.$/, "")}. The context is as it was.`;
    }
    const figures = event.result as { tokensBefore?: unknown; estimatedTokensAfter?: unknown };
    const before = figures?.tokensBefore;
    const after = figures?.estimatedTokensAfter;
    if (typeof before !== "number" || typeof after !== "number") {
        return "Context compacted.";
    }
    return `Context compacted: ${formatTokens(before)} to about ${formatTokens(after)} tokens.`;
}

export function foldEvent(state: Transcript, event: PiEvent): Transcript {
    let next = state;
    switch (event.type) {
        case "agent_start":
            next = { ...state, running: true };
            break;
        case "agent_settled":
            // A prompt cannot outlive the run; a pi that died mid-prompt sends no end.
            next = { ...state, running: false, prompt: null };
            break;
        case "ui_prompt_start":
            next = { ...state, prompt: event.prompt };
            break;
        case "ui_prompt_end":
            // The end of an older prompt must not close the one that opened after it.
            next = state.prompt?.id === event.id ? { ...state, prompt: null } : state;
            break;
        case "ui_notify":
            next = { ...state, entries: [...state.entries, { kind: "note", text: event.message }] };
            break;
        case "compaction_start":
            next = { ...state, compacting: true };
            break;
        case "compaction_end":
            next = {
                ...state,
                compacting: false,
                entries: [...state.entries, { kind: "note", text: compactionNote(event) }],
            };
            break;
        case "message_start":
            next = startMessage(state, event.message);
            break;
        case "message_update":
            next = { ...state, entries: updateMessage(state.entries, event) };
            break;
        case "message_end":
            next = endMessage(state, event.message);
            break;
        case "tool_execution_start": {
            // The assistant message that asked for the call shows it already.
            const shown = state.entries.some(
                (entry) => entry.kind === "tool" && entry.id === event.toolCallId,
            );
            const entry = toolEntry(event.toolCallId, event.toolName, event.args);
            next = shown ? state : { ...state, entries: [...state.entries, entry] };
            break;
        }
        case "tool_execution_end":
            next = { ...state, entries: toolEnd(state.entries, event) };
            break;
        default:
            return state;
    }
    const over = next.entries.length - ENTRIES_LIMIT;
    return over > 0 ? { ...next, entries: next.entries.slice(over) } : next;
}

/**
 * A page of the daemon's transcript, folded from nothing. Most of a page is finished
 * messages (`message_end`); this pass appends them in place, so thousands of messages cost
 * one pass, where `foldEvent` copies the list per event. The events of the open message at
 * the page's end go through `foldEvent`, so both paths give the same entries.
 */
export function foldPage(events: readonly PiEvent[]): Transcript {
    const entries: Entry[] = [];
    const tools = new Map<string, number>();
    let cost = 0;
    let index = 0;
    for (; index < events.length; index += 1) {
        const event = events[index];
        if (event?.type === "ui_notify") {
            entries.push({ kind: "note", text: event.message });
            continue;
        }
        if (event?.type === "compaction_end") {
            entries.push({ kind: "note", text: compactionNote(event) });
            continue;
        }
        if (event?.type !== "message_end") {
            break;
        }
        const message = event.message;
        if (message.role === "user") {
            entries.push(userEntry(message));
        } else if (message.role === "assistant") {
            const assistant = message as PiAssistantMessage;
            entries.push(assistantEntry(assistant));
            cost += assistant.usage?.cost?.total ?? 0;
            for (const part of assistant.content) {
                if (part.type === "toolCall" && !tools.has(part.id)) {
                    tools.set(part.id, entries.length);
                    entries.push(toolEntry(part.id, part.name, part.arguments));
                }
            }
        } else if (message.role === "toolResult") {
            const result = message as PiToolResultMessage;
            const at = tools.get(result.toolCallId);
            const entry = at === undefined ? undefined : entries[at];
            if (at !== undefined && entry?.kind === "tool") {
                entries[at] = {
                    ...entry,
                    state: result.isError ? "error" : "ok",
                    result: textOf(result.content),
                };
            }
        }
    }
    const over = entries.length - ENTRIES_LIMIT;
    const settled: Transcript = {
        entries: over > 0 ? entries.slice(over) : entries,
        cost,
        running: false,
        open: null,
    };
    return events.slice(index).reduce(foldEvent, settled);
}
