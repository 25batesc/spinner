// One agent's chat as the UI holds it: the transcript, and where it stands against the
// daemon's numbered event stream. The daemon holds the transcript (`GET …/transcript`) and
// numbers each event it sends (`agent.event.seq`, from 1 at each start of the agent's pi).
// The chat takes one page, then folds the live events in order. An event ahead of the next
// number waits here while the chat fetches the events between; nothing is merged by
// timestamp and no file is read again.
import type { AgentTranscriptResponse, PiEvent } from "@spinner/protocol";

import { emptyTranscript, foldEvent, foldPage, type Transcript } from "./transcript.ts";

/** Upper bound on live events that wait for a page; past it the chat takes the whole page. */
export const WAITING_MAX = 2000;

export interface NumberedEvent {
    seq: number;
    event: PiEvent;
}

export interface ChatState {
    transcript: Transcript;
    /**
     * The number of the newest event folded. Null until a page applied: the transcript is
     * then only what arrived live since this window opened.
     */
    cursor: number | null;
    /** Live events ahead of `cursor + 1`, oldest first. Not empty means a page is needed. */
    waiting: readonly NumberedEvent[];
    /** ISO 8601 time of the agent's newest sign of life; null when none is known. */
    active: string | null;
}

export const emptyChat: ChatState = {
    transcript: emptyTranscript,
    cursor: null,
    waiting: [],
    active: null,
};

/** True when the chat must fetch a page: it has none yet, or live events wait behind a gap. */
export function needsPage(chat: ChatState): boolean {
    return chat.cursor === null || chat.waiting.length > 0;
}

/**
 * One live event. Before the first page it is folded as it comes, so a tab nobody opened
 * still knows the running tool. After it, the event must be the next number: an older one
 * is in the page already, a newer one waits.
 */
export function applyLive(chat: ChatState, seq: number, event: PiEvent, ts: string): ChatState {
    if (chat.cursor === null) {
        return { ...chat, transcript: foldEvent(chat.transcript, event), active: ts };
    }
    if (seq <= chat.cursor) {
        return chat;
    }
    if (seq === chat.cursor + 1 && chat.waiting.length === 0) {
        const transcript = foldEvent(chat.transcript, event);
        return { ...chat, transcript, cursor: seq, active: ts };
    }
    if (chat.waiting.length >= WAITING_MAX) {
        // Too far behind to catch up event by event: start over from a whole page.
        return { ...chat, cursor: null, waiting: [], active: ts };
    }
    return { ...chat, waiting: [...chat.waiting, { seq, event }], active: ts };
}

/**
 * A page from the daemon: the whole transcript, or the events after the cursor. The run
 * state, the open prompt and whether pi compacts are the page's. The waiting events the
 * page does not hold are folded after it, while they follow without a gap.
 */
export function applyPage(chat: ChatState, page: AgentTranscriptResponse): ChatState {
    const whole = page.reset || chat.cursor === null;
    const folded = whole
        ? foldPage(page.events)
        : page.events.reduce(foldEvent, chat.transcript);
    let transcript: Transcript = {
        ...folded,
        running: page.running,
        prompt: page.prompt,
        compacting: page.compacting,
    };
    let cursor = page.next;
    const waiting: NumberedEvent[] = [];
    for (const entry of chat.waiting) {
        if (entry.seq === cursor + 1 && waiting.length === 0) {
            transcript = foldEvent(transcript, entry.event);
            cursor = entry.seq;
        } else if (entry.seq > cursor) {
            waiting.push(entry);
        }
    }
    return { transcript, cursor, waiting, active: page.active ?? chat.active };
}

/**
 * The agent's pi started again, or the socket reconnected: the numbers start over or events
 * were missed. The transcript stays on screen until the next page replaces it.
 */
export function unsynced(chat: ChatState): ChatState {
    return { ...chat, cursor: null, waiting: [] };
}
