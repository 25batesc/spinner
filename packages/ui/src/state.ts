// The UI's whole model. It is a pure function of the daemon's snapshot and event stream:
// nothing here is invented by the UI. View choices (which session, tab or job is selected, pane
// widths) live in components, not in this state, because the daemon never sends them.
// A session changes only through `session.created` and `session.updated`, which carry the whole
// `SessionView`; partial events such as `stack.state` show up in the feed but do not edit it.
import type { Job, SessionView, SpinnerEvent } from "@spinner/protocol";

import { describeEvent } from "./describe.ts";
import { emptyTranscript, foldEvent, type Transcript } from "./transcript.ts";

export const FEED_LIMIT = 100;
export const JOB_LOG_LIMIT = 500;

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface FeedLine {
    ts: string;
    session: string;
    text: string;
}

export interface UiState {
    sessions: Record<string, SessionView>;
    /** Jobs by id, from `job.*` events and the jobs snapshot. */
    jobs: Record<string, Job>;
    feed: FeedLine[];
    /** What each agent tab shows, folded from `agent.event`, per `<session dir>/<agent>`. */
    transcripts: Record<string, Transcript>;
    connection: ConnectionStatus;
}

export type Action =
    | { kind: "snapshot"; sessions: SessionView[] }
    | { kind: "jobs"; jobs: Job[] }
    | { kind: "event"; event: SpinnerEvent }
    | { kind: "connection"; status: ConnectionStatus };

export const initialState: UiState = {
    sessions: {},
    jobs: {},
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

function applyJobEvent(state: UiState, event: SpinnerEvent): UiState {
    switch (event.type) {
        case "job.started":
            return { ...state, jobs: { ...state.jobs, [event.job]: event.data } };
        case "job.log": {
            const job = state.jobs[event.job];
            if (job === undefined) {
                return state;
            }
            const log = keepLast([...job.log, event.line], JOB_LOG_LIMIT);
            return { ...state, jobs: { ...state.jobs, [event.job]: { ...job, log } } };
        }
        case "job.finished":
            return { ...state, jobs: { ...state.jobs, [event.job]: event.data } };
        default:
            return state;
    }
}

function applyEvent(state: UiState, event: SpinnerEvent): UiState {
    switch (event.type) {
        case "session.created":
        case "session.updated":
            return { ...state, sessions: { ...state.sessions, [event.session]: event.data } };
        case "session.closed": {
            const sessions = { ...state.sessions };
            delete sessions[event.session];
            return { ...state, sessions };
        }
        case "job.started":
        case "job.log":
        case "job.finished":
            return applyJobEvent(state, event);
        case "agent.event": {
            const key = transcriptKey(event.session, event.agent);
            const earlier = state.transcripts[key] ?? emptyTranscript;
            const folded = foldEvent(earlier, event.event);
            return { ...state, transcripts: { ...state.transcripts, [key]: folded } };
        }
        default:
            return state;
    }
}

function appendFeed(state: UiState, event: SpinnerEvent): UiState {
    const text = describeEvent(event);
    if (text === null || event.session === null) {
        return state;
    }
    const line: FeedLine = { ts: event.ts, session: event.session, text };
    return { ...state, feed: keepLast([...state.feed, line], FEED_LIMIT) };
}

/** Adds what the stream has not told us about yet; an event is never older than a snapshot. */
function applySnapshot(state: UiState, views: SessionView[]): UiState {
    const sessions = { ...state.sessions };
    for (const view of views) {
        sessions[view.summary.dir] ??= view;
    }
    return { ...state, sessions };
}

function applyJobs(state: UiState, jobs: Job[]): UiState {
    const merged = { ...state.jobs };
    for (const job of jobs) {
        merged[job.id] ??= job;
    }
    return { ...state, jobs: merged };
}

export function reduce(state: UiState, action: Action): UiState {
    switch (action.kind) {
        case "snapshot":
            return applySnapshot(state, action.sessions);
        case "jobs":
            return applyJobs(state, action.jobs);
        case "event":
            return appendFeed(applyEvent(state, action.event), action.event);
        case "connection":
            return { ...state, connection: action.status };
    }
}

/** The stage the board shows: the tracker's when there is a PR, else the stored one. */
export function stageOf(view: SessionView): string {
    return view.board?.stage ?? view.summary.session.stage;
}

export function needsHuman(view: SessionView): string | null {
    return view.board === null ? view.summary.session.needs_human : view.board.needs_human;
}

/** Sessions waiting on the operator first, then newest first. Returns `[dir, view]` pairs. */
export function sortedSessions(state: UiState): [string, SessionView][] {
    const waiting = (view: SessionView) => (needsHuman(view) === null ? 1 : 0);
    return Object.entries(state.sessions).sort(
        ([, a], [, b]) =>
            waiting(a) - waiting(b) ||
            b.summary.session.created.localeCompare(a.summary.session.created),
    );
}

/** The job that is running on a session, if any. Used to disable that session's buttons. */
export function runningJob(state: UiState, dir: string): Job | undefined {
    return Object.values(state.jobs).find((job) => job.session === dir && job.state === "running");
}
