// The UI's whole model. It is a pure function of the daemon's snapshot and event stream:
// nothing here is invented by the UI. View choices (which tab is selected, pane widths) live
// in components, not in this state, because the daemon never sends them.
import type { AgentSpec, Session, SessionSummary, SpinnerEvent } from "@spinner/protocol";

import { describeEvent } from "./describe.ts";

export const FEED_LIMIT = 100;
export const TRANSCRIPT_LIMIT = 200;

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface FeedLine {
    ts: string;
    session: string;
    text: string;
}

export interface UiState {
    sessions: Record<string, Session>;
    feed: FeedLine[];
    /** Raw pi events per `<session dir>/<agent>`, newest last. */
    transcripts: Record<string, unknown[]>;
    connection: ConnectionStatus;
}

export type Action =
    | { kind: "snapshot"; sessions: SessionSummary[] }
    | { kind: "event"; event: SpinnerEvent }
    | { kind: "connection"; status: ConnectionStatus };

export const initialState: UiState = {
    sessions: {},
    feed: [],
    transcripts: {},
    connection: "connecting",
};

export function transcriptKey(dir: string, agent: string): string {
    return `${dir}/${agent}`;
}

function keepLast<T>(items: T[], limit: number): T[] {
    return items.length > limit ? items.slice(items.length - limit) : items;
}

function patchAgent(
    state: UiState,
    dir: string,
    agent: string,
    patch: Partial<AgentSpec>,
): UiState {
    const session = state.sessions[dir];
    const spec = session?.agents[agent];
    if (session === undefined || spec === undefined) {
        return state;
    }
    const agents = { ...session.agents, [agent]: { ...spec, ...patch } };
    const next: Session = { ...session, agents };
    return { ...state, sessions: { ...state.sessions, [dir]: next } };
}

function patchSession(state: UiState, dir: string, patch: Partial<Session>): UiState {
    const session = state.sessions[dir];
    if (session === undefined) {
        return state;
    }
    return { ...state, sessions: { ...state.sessions, [dir]: { ...session, ...patch } } };
}

function applyEvent(state: UiState, event: SpinnerEvent): UiState {
    const dir = event.session;
    switch (event.type) {
        case "session.created":
        case "session.updated":
            return { ...state, sessions: { ...state.sessions, [dir]: event.data } };
        case "session.closed": {
            const sessions = { ...state.sessions };
            delete sessions[dir];
            return { ...state, sessions };
        }
        case "pipeline.updated":
            return patchSession(state, dir, { stage: event.stage, needs_human: event.needs_human });
        case "pipeline.transition":
            return patchSession(state, dir, { stage: event.to });
        case "stack.state": {
            const stack = state.sessions[dir]?.stack;
            return stack === undefined
                ? state
                : patchSession(state, dir, { stack: { ...stack, state: event.state } });
        }
        case "agent.spawned":
            return patchAgent(state, dir, event.agent, { process: "running", pid: event.pid });
        case "agent.settled":
            return patchAgent(state, dir, event.agent, { process: "idle" });
        case "agent.exited":
            return patchAgent(state, dir, event.agent, { process: event.process });
        case "agent.event": {
            const key = transcriptKey(dir, event.agent);
            const earlier = state.transcripts[key] ?? [];
            const lines = keepLast([...earlier, event.event], TRANSCRIPT_LIMIT);
            return { ...state, transcripts: { ...state.transcripts, [key]: lines } };
        }
        default:
            return state;
    }
}

function appendFeed(state: UiState, event: SpinnerEvent): UiState {
    const text = describeEvent(event);
    if (text === null) {
        return state;
    }
    const line: FeedLine = { ts: event.ts, session: event.session, text };
    return { ...state, feed: keepLast([...state.feed, line], FEED_LIMIT) };
}

/** Adds sessions the stream has not told us about yet; an event is never older than a snapshot. */
function applySnapshot(state: UiState, summaries: SessionSummary[]): UiState {
    const sessions = { ...state.sessions };
    for (const summary of summaries) {
        sessions[summary.dir] ??= summary.session;
    }
    return { ...state, sessions };
}

export function reduce(state: UiState, action: Action): UiState {
    switch (action.kind) {
        case "snapshot":
            return applySnapshot(state, action.sessions);
        case "event":
            return appendFeed(applyEvent(state, action.event), action.event);
        case "connection":
            return { ...state, connection: action.status };
    }
}

/** Sessions waiting on the operator first, then newest first. Returns `[dir, session]` pairs. */
export function sortedSessions(state: UiState): [string, Session][] {
    const waiting = (session: Session) => (session.needs_human === null ? 1 : 0);
    return Object.entries(state.sessions).sort(
        ([, a], [, b]) => waiting(a) - waiting(b) || b.created.localeCompare(a.created),
    );
}
