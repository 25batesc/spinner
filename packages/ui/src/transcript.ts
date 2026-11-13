// Folds pi's `agent.event` stream into what the agent tab shows: messages, tool calls, cost.
// It is a pure function of the events, so a reload that replays them gives the same tab.
import type {
    PiAssistantMessage,
    PiEvent,
    PiMessage,
    PiToolResultMessage,
} from "@spinner/protocol";

/** The live fold keeps this many entries; the history holds more (`HISTORY_ENTRIES_MAX`). */
export const ENTRIES_LIMIT = 2000;
/** The entries a history holds; past it the oldest drop (talk-change-ship.md, 5.2). */
export const HISTORY_ENTRIES_MAX = 20_000;

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
    if (opened) {
        return { ...closed, entries: withLastAssistant(state.entries, () => done), cost };
    }
    const tools: Entry[] = assistant.content.flatMap((part) =>
        part.type === "toolCall"
            ? [toolEntry(part.id, part.name, part.arguments)]
            : [],
    );
    return { ...closed, entries: [...state.entries, done, ...tools], cost };
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

export function foldEvent(state: Transcript, event: PiEvent): Transcript {
    let next = state;
    switch (event.type) {
        case "agent_start":
            next = { ...state, running: true };
            break;
        case "agent_settled":
            next = { ...state, running: false };
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
        case "tool_execution_start":
            next = {
                ...state,
                entries: [
                    ...state.entries,
                    {
                        kind: "tool",
                        id: event.toolCallId,
                        name: event.toolName,
                        args: event.args,
                        state: "running",
                    },
                ],
            };
            break;
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
 * The agent's past turns as a transcript (5.2). The daemon sends them as `message_end`
 * events. This fold appends in place, so a history of thousands of messages costs one pass;
 * `foldEvent` copies the list per event, which suits the live stream only.
 */
export function foldHistory(events: readonly PiEvent[]): Transcript {
    const entries: Entry[] = [];
    const tools = new Map<string, number>();
    let cost = 0;
    for (const event of events) {
        if (event.type !== "message_end") {
            continue;
        }
        const message = event.message;
        if (message.role === "user") {
            entries.push(userEntry(message));
        } else if (message.role === "assistant") {
            const assistant = message as PiAssistantMessage;
            entries.push(assistantEntry(assistant));
            cost += assistant.usage?.cost?.total ?? 0;
            for (const part of assistant.content) {
                if (part.type === "toolCall") {
                    tools.set(part.id, entries.length);
                    entries.push(toolEntry(part.id, part.name, part.arguments));
                }
            }
        } else if (message.role === "toolResult") {
            const result = message as PiToolResultMessage;
            const index = tools.get(result.toolCallId);
            const entry = index === undefined ? undefined : entries[index];
            if (index !== undefined && entry?.kind === "tool") {
                entries[index] = {
                    ...entry,
                    state: result.isError ? "error" : "ok",
                    result: textOf(result.content),
                };
            }
        }
    }
    const over = entries.length - HISTORY_ENTRIES_MAX;
    return {
        entries: over > 0 ? entries.slice(over) : entries,
        cost,
        running: false,
        open: null,
    };
}

/**
 * One transcript from the history and the live fold (5.3). A message both hold shows once:
 * a live message at or before the history's newest timestamp is the history's; a live tool
 * call whose id the history holds is the history's, and gives it its result when the history
 * read it while it ran. The cost is the history's plus what the live messages past it cost;
 * the live fold cannot tell, so the history's cost stands when it is the larger.
 */
export function mergeTranscripts(history: Transcript, live: Transcript): Transcript {
    let newest = 0;
    const tool_at = new Map<string, number>();
    for (const [index, entry] of history.entries.entries()) {
        if (entry.kind === "tool") {
            tool_at.set(entry.id, index);
        } else if (entry.kind !== "note" && entry.ts !== undefined && entry.ts > newest) {
            newest = entry.ts;
        }
    }
    const entries = [...history.entries];
    for (const entry of live.entries) {
        if (entry.kind === "tool") {
            const index = tool_at.get(entry.id);
            if (index === undefined) {
                entries.push(entry);
            } else if (entry.state !== "running") {
                entries[index] = entry;
            }
            continue;
        }
        const old = entry.kind !== "note" && entry.ts !== undefined && entry.ts <= newest;
        if (!old) {
            entries.push(entry);
        }
    }
    return {
        entries,
        cost: Math.max(history.cost, live.cost),
        running: live.running,
        open: live.open,
    };
}
