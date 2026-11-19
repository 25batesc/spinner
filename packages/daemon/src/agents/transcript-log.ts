// The chat transcript of one hosted agent, as the daemon holds it: the one source the chat
// renders. Before this the browser merged two sources by timestamp, the live events and a
// re-read of pi's whole transcript file at every turn edge (14.7 MB for one lead), and every
// chat bug of that week sat between the two.
//
// The log numbers each event the chat folds (`seq`, from 1, no gap) and holds the ones that
// make up the transcript, bounded in count and bytes. A finished message is held as its
// `message_end` alone; its `message_start` and deltas go when it ends, and a tool call's
// start and end go when its result message arrives. Deltas of one text block are joined
// while the message is open, so a long answer cannot push the user's message out. A page is
// the whole of what is held, or the events after `since` when nothing between was dropped.
// The run state and the open prompt travel with the page, not as held events, so the caps
// cannot lose them.
import assert from "node:assert/strict";
import type {
    AgentPrompt,
    AgentTranscriptResponse,
    PiEvent,
    PiMessage,
} from "@spinner/protocol";
import {
    TRANSCRIPT_BYTES_MAX,
    TRANSCRIPT_EVENTS_MAX,
    TRANSCRIPT_TEXT_CHARS_MAX,
} from "@spinner/protocol";

/** Upper bound on one held event as JSON; a larger one keeps its shape and loses its body. */
const EVENT_BYTES_MAX = 4 * TRANSCRIPT_TEXT_CHARS_MAX;

interface Held {
    /** The event's number; 0 for a message that came from the transcript file. */
    seq: number;
    /** The number of the first delta joined into this one; `seq` for any other event. */
    first: number;
    event: PiEvent;
    bytes: number;
}

type Update = Extract<PiEvent, { type: "message_update" }>;

export class TranscriptLog {
    private held: Held[] = [];
    private bytes = 0;
    /** The number of the newest event; 0 before the first. */
    private next = 0;
    /** The newest number the caps dropped: a page for an older `since` is the whole log. */
    private floor = 0;
    private running = false;
    private prompt: AgentPrompt | null = null;

    /** The past messages (`message_end` events from pi's transcript file), before any event. */
    seed(events: readonly PiEvent[]): void {
        assert.equal(this.next, 0, "a transcript log is seeded before its first event");
        assert.equal(this.held.length, 0, "a transcript log is seeded once");
        for (const event of events) {
            const chat = chat_event(event);
            if (chat !== null) {
                this.hold(0, chat);
            }
        }
        this.enforce_caps();
    }

    /**
     * Numbers `event` and returns it as the chat gets it, or null for an event the chat does
     * not fold (`turn_end`, `agent_end`, a tool's partial output, a system message).
     */
    append(event: PiEvent): { seq: number; event: PiEvent } | null {
        const chat = chat_event(event);
        if (chat === null) {
            return null;
        }
        this.next += 1;
        const seq = this.next;
        switch (chat.type) {
            case "agent_start":
                this.running = true;
                break;
            case "agent_settled":
                // A prompt cannot outlive the run; a pi that died mid-prompt sends no end.
                this.running = false;
                this.prompt = null;
                break;
            case "ui_prompt_start":
                this.prompt = chat.prompt;
                break;
            case "ui_prompt_end":
                if (this.prompt?.id === chat.id) {
                    this.prompt = null;
                }
                break;
            case "message_update":
                this.hold_update(seq, chat);
                break;
            case "message_end":
                this.drop_subsumed(chat.message);
                this.hold(seq, chat);
                break;
            default:
                this.hold(seq, chat);
        }
        this.enforce_caps();
        return { seq, event: chat };
    }

    /**
     * The events after `since`, or the whole log with `reset` when `since` is 0, is ahead of
     * the log, or names a point the log can no longer continue from: the caps dropped a later
     * event, or `since` falls inside a run of joined deltas.
     */
    page(since: number, active: string | null): AgentTranscriptResponse {
        assert.ok(Number.isInteger(since) && since >= 0, "since must be a non-negative integer");
        const inside_joined = this.held.some((entry) => entry.first <= since && since < entry.seq);
        const continues = since > 0 && since <= this.next && since >= this.floor && !inside_joined;
        const entries = continues ? this.held.filter((entry) => entry.seq > since) : this.held;
        return {
            reset: !continues,
            next: this.next,
            events: entries.map((entry) => entry.event),
            running: this.running,
            prompt: this.prompt,
            active,
        };
    }

    private hold(seq: number, event: PiEvent): void {
        const bytes = JSON.stringify(event).length;
        this.held.push({ seq, first: seq, event, bytes });
        this.bytes += bytes;
    }

    /** A delta that follows a delta of the same block joins it; any other one is held. */
    private hold_update(seq: number, event: Update): void {
        const last = this.held[this.held.length - 1];
        const joined = last === undefined ? null : join_deltas(last.event, event);
        if (last === undefined || joined === null) {
            this.hold(seq, event);
            return;
        }
        const bytes = JSON.stringify(joined).length;
        this.bytes += bytes - last.bytes;
        this.held[this.held.length - 1] = { seq, first: last.first, event: joined, bytes };
    }

    /**
     * A message that ended stands for its own start and deltas, and a tool result for the
     * call's start and end events: the chat folds the same entries from `message_end` alone.
     */
    private drop_subsumed(message: PiMessage): void {
        const call = message.role === "toolResult" ? (message as { toolCallId?: unknown }) : null;
        const kept = this.held.filter((entry) => {
            const event = entry.event;
            if (event.type === "message_start" || event.type === "message_update") {
                return false;
            }
            const of_call =
                event.type === "tool_execution_start" || event.type === "tool_execution_end";
            return !(of_call && call !== null && event.toolCallId === call.toolCallId);
        });
        this.set_held(kept);
    }

    private enforce_caps(): void {
        let drop = 0;
        let bytes = this.bytes;
        const count = this.held.length;
        // The newest event always stays, whatever its size.
        while (
            drop < count - 1 &&
            (count - drop > TRANSCRIPT_EVENTS_MAX || bytes > TRANSCRIPT_BYTES_MAX)
        ) {
            const entry = this.held[drop];
            assert.ok(entry !== undefined);
            bytes -= entry.bytes;
            this.floor = Math.max(this.floor, entry.seq);
            drop += 1;
        }
        if (drop > 0) {
            this.set_held(this.held.slice(drop));
        }
    }

    private set_held(held: Held[]): void {
        this.held = held;
        this.bytes = held.reduce((sum, entry) => sum + entry.bytes, 0);
    }
}

/** `next` joined onto `held` when both are deltas of the same kind and block, else null. */
function join_deltas(held: PiEvent, next: Update): Update | null {
    if (held.type !== "message_update") {
        return null;
    }
    const a = held.assistantMessageEvent;
    const b = next.assistantMessageEvent;
    const text = a.type === "text_delta" && b.type === "text_delta";
    const thinking = a.type === "thinking_delta" && b.type === "thinking_delta";
    if ((!text && !thinking) || a.contentIndex !== b.contentIndex) {
        return null;
    }
    assert.ok("delta" in a && "delta" in b);
    return { ...next, assistantMessageEvent: { ...b, delta: a.delta + b.delta } };
}

const CHAT_ROLES = ["user", "assistant", "toolResult"];

/**
 * The event as the chat gets it, or null for one the chat does not fold. Long texts are cut
 * and image bytes left out (the chat shows a count, not the image), so one tool result
 * cannot fill the log or a browser's socket.
 */
export function chat_event(event: PiEvent): PiEvent | null {
    switch (event.type) {
        case "agent_start":
        case "agent_settled":
        case "ui_prompt_start":
        case "ui_prompt_end":
        case "ui_notify":
            return event;
        case "message_update": {
            const kind = event.assistantMessageEvent.type;
            return kind === "text_delta" || kind === "thinking_delta" ? event : null;
        }
        case "message_start":
        case "message_end": {
            if (!CHAT_ROLES.includes(event.message.role)) {
                return null;
            }
            const slim = { type: event.type, message: slim_message(event.message) };
            return bounded(slim, () => ({
                type: event.type,
                message: { ...slim.message, content: [{ type: "text", text: too_big(slim) }] },
            }));
        }
        case "tool_execution_start": {
            const slim = { ...event, args: clip_fields(event.args) };
            return bounded(slim, () => ({ ...event, args: { note: too_big(slim) } }));
        }
        case "tool_execution_end": {
            const slim = { ...event, result: slim_result(event.result) };
            return bounded(slim, () => ({ ...event, result: too_big(slim) }));
        }
        default:
            return null;
    }
}

/** `event`, or `stub()` when it is over `EVENT_BYTES_MAX` after its texts were cut. */
function bounded(event: PiEvent, stub: () => PiEvent): PiEvent {
    return JSON.stringify(event).length > EVENT_BYTES_MAX ? stub() : event;
}

function too_big(event: PiEvent): string {
    return `[${JSON.stringify(event).length} bytes, not shown in the chat]`;
}

function clip(text: string): string {
    const over = text.length - TRANSCRIPT_TEXT_CHARS_MAX;
    if (over <= 0) {
        return text;
    }
    return `${text.slice(0, TRANSCRIPT_TEXT_CHARS_MAX)}\n… [${over} more characters not shown]`;
}

/** A string cut, or an object with its own string fields cut; anything else unchanged. */
function clip_fields(value: unknown): unknown {
    if (typeof value === "string") {
        return clip(value);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return value;
    }
    const fields = Object.entries(value).map(([key, field]) => [
        key,
        typeof field === "string" ? clip(field) : field,
    ]);
    return Object.fromEntries(fields) as unknown;
}

/** One content part with its text cut and its image bytes left out. */
function slim_part(part: unknown): unknown {
    if (typeof part !== "object" || part === null) {
        return part;
    }
    const fields = part as Record<string, unknown>;
    if (fields["type"] === "image") {
        return { ...fields, data: "" };
    }
    if (fields["type"] === "toolCall") {
        return { ...fields, arguments: clip_fields(fields["arguments"]) };
    }
    return clip_fields(fields);
}

function slim_content(content: unknown): unknown {
    return Array.isArray(content) ? content.map(slim_part) : clip_fields(content);
}

function slim_message(message: PiMessage): PiMessage {
    return { ...message, content: slim_content(message.content) } as PiMessage;
}

/** A tool's result: a string, or pi's `{ content, details }`. */
function slim_result(result: unknown): unknown {
    if (typeof result !== "object" || result === null || !("content" in result)) {
        return clip_fields(result);
    }
    return { ...result, content: slim_content((result as { content: unknown }).content) };
}
