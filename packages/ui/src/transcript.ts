// Folds pi's `agent.event` stream into what the agent tab shows: messages, tool calls, cost.
// It is a pure function of the events, so a reload that replays them gives the same tab.
import type { PiAssistantMessage, PiEvent, PiMessage } from "@spinner/protocol";

export const ENTRIES_LIMIT = 500;

type AssistantEntry = { kind: "assistant"; text: string; thinking: string; done: boolean };

export type Entry =
    | { kind: "user"; text: string }
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
}

export const emptyTranscript: Transcript = { entries: [], cost: 0, running: false };

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

function startMessage(entries: Entry[], message: PiMessage): Entry[] {
    if (message.role === "user") {
        return [...entries, { kind: "user", text: textOf(message.content) }];
    }
    if (message.role === "assistant") {
        return [...entries, { kind: "assistant", text: "", thinking: "", done: false }];
    }
    return entries;
}

function endMessage(state: Transcript, message: PiMessage): Transcript {
    if (message.role !== "assistant") {
        return state;
    }
    const assistant = message as PiAssistantMessage;
    const parts = assistantParts(assistant);
    const entries = withLastAssistant(state.entries, () => ({
        kind: "assistant",
        ...parts,
        done: true,
    }));
    return { ...state, entries, cost: state.cost + (assistant.usage?.cost?.total ?? 0) };
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

function toolEnd(entries: Entry[], event: ToolEnd): Entry[] {
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
            next = { ...state, entries: startMessage(state.entries, event.message) };
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
