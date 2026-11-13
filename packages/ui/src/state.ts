// The UI's whole model. It is a pure function of the daemon's snapshot and event stream:
// nothing here is invented by the UI. View choices (which session, tab or job is selected, pane
// widths) live in components, not in this state, because the daemon never sends them.
// A session changes only through `session.created` and `session.updated`, which carry the whole
// `SessionView`; partial events such as `stack.state` show up in the feed but do not edit it.
import type {
    CostsEvent,
    Job,
    MissionView,
    OperatorView,
    SessionView,
    Settings,
    SpinnerEvent,
} from "@spinner/protocol";

import { describeEvent } from "./describe.ts";
import { emptyTranscript, foldEvent, type Transcript } from "./transcript.ts";
import type { UsageSample } from "./usage.ts";
import { otherChangeNeeds } from "./changes.ts";

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
    /**
     * Per session, how many events of each kind arrived. A view that loads a route on demand
     * (mission, threads) reloads when its counter moves; the counter holds no data of its own.
     */
    revisions: Record<string, Revisions>;
    /** The last usage sample: `GET /usage` at load, then every `usage` event. */
    usage: UsageSample | null;
    /** The operator's settings: `GET /settings` at load, then every `settings` event. */
    settings: Settings | null;
    /**
     * The operator agent: `GET /operator` at load, then every `operator.updated` event. Null
     * until the load answers, and from a daemon without the route.
     */
    operator: OperatorView | null;
    /**
     * The running cost figures from the last `costs` event (s013), with a counter so the
     * Usage section reloads its report when the ledger changed. Null until the first event.
     */
    costs: CostFigures | null;
    /**
     * The structured mission per session, from `mission.changed` (s014). The workspace loads
     * the view route once and then reads here, so an edit by an agent shows without a fetch.
     */
    missions: Record<string, MissionView>;
}

/** What the `costs` event carries for the Usage section's three figures. */
export interface CostFigures {
    today: CostsEvent["today"];
    week: CostsEvent["week"];
    month: CostsEvent["month"];
    /** Counts the events, so a loader keyed on it refetches the report. */
    revision: number;
}

export interface Revisions {
    mission: number;
    threads: number;
    pipeline: number;
    inbox: number;
    /** Moves on `comment.updated`: the preview comments (s054). */
    comments: number;
}

const NO_REVISIONS: Revisions = { mission: 0, threads: 0, pipeline: 0, inbox: 0, comments: 0 };

export type Action =
    | { kind: "snapshot"; sessions: SessionView[] }
    | { kind: "jobs"; jobs: Job[] }
    | { kind: "event"; event: SpinnerEvent }
    | { kind: "connection"; status: ConnectionStatus }
    | { kind: "usage"; usage: UsageSample }
    | { kind: "settings"; settings: Settings }
    | { kind: "operator"; operator: OperatorView };

export const initialState: UiState = {
    sessions: {},
    jobs: {},
    feed: [],
    transcripts: {},
    connection: "connecting",
    revisions: {},
    usage: null,
    settings: null,
    operator: null,
    costs: null,
    missions: {},
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

/** The figures move; each changed session gets its new `cost` without waiting for a view. */
function applyCosts(state: UiState, event: CostsEvent): UiState {
    const sessions = { ...state.sessions };
    for (const [dir, cost] of Object.entries(event.changed)) {
        const view = sessions[dir];
        if (view !== undefined) {
            sessions[dir] = { ...view, cost };
        }
    }
    const revision = (state.costs?.revision ?? 0) + 1;
    const { today, week, month } = event;
    return { ...state, sessions, costs: { today, week, month, revision } };
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
        case "usage":
            return { ...state, usage: { machine: event.machine, sessions: event.sessions } };
        case "costs":
            return applyCosts(state, event);
        case "settings":
            return { ...state, settings: event.settings };
        case "operator.updated":
            return { ...state, operator: event.data };
        case "mission.changed":
            if (event.view === undefined) {
                return state;
            }
            return { ...state, missions: { ...state.missions, [event.session]: event.view } };
        case "review.updated": {
            // The review fields alone (s015); the cards and the chips move without a view.
            const view = state.sessions[event.session];
            if (view === undefined) {
                return state;
            }
            const next = { ...view, review: event.data };
            return { ...state, sessions: { ...state.sessions, [event.session]: next } };
        }
        default:
            return state;
    }
}

function revisionKind(event: SpinnerEvent): keyof Revisions | null {
    switch (event.type) {
        case "mission.changed":
            return "mission";
        case "threads.updated":
            return "threads";
        case "pipeline.updated":
        case "pipeline.transition":
        case "pr.updated":
        case "slack.activity":
            return "pipeline";
        case "inbox.message":
        case "message.delivered":
            return "inbox";
        case "comment.updated":
            return "comments";
        default:
            return null;
    }
}

function bumpRevision(state: UiState, event: SpinnerEvent): UiState {
    const kind = revisionKind(event);
    if (kind === null || event.session === null) {
        return state;
    }
    const before = state.revisions[event.session] ?? NO_REVISIONS;
    const next = { ...before, [kind]: before[kind] + 1 };
    return { ...state, revisions: { ...state.revisions, [event.session]: next } };
}

export function revisionsOf(state: UiState, dir: string | undefined): Revisions {
    return (dir === undefined ? undefined : state.revisions[dir]) ?? NO_REVISIONS;
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
        case "usage":
            return { ...state, usage: action.usage };
        case "settings":
            return { ...state, settings: action.settings };
        case "operator":
            return { ...state, operator: action.operator };
        case "jobs":
            return applyJobs(state, action.jobs);
        case "event":
            return appendFeed(
                bumpRevision(applyEvent(state, action.event), action.event),
                action.event,
            );
        case "connection":
            return { ...state, connection: action.status };
    }
}

/** The stage the board shows: the tracker's when there is a PR, else the stored one. */
export function stageOf(view: SessionView): string {
    return view.board?.stage ?? view.summary.session.stage;
}

/**
 * What the session needs from the operator: the current change's line, else the line of
 * another open change with its title (docs/designs/talk-change-ship.md, 2.9).
 */
export function needsHuman(view: SessionView): string | null {
    const own = view.board === null ? view.summary.session.needs_human : view.board.needs_human;
    return own ?? otherChangeNeeds(view);
}

/** Sessions waiting on the operator first, then newest first. Returns `[dir, view]` pairs. */
/**
 * The session the operator spoke to last first (a prompt, a steer, Enter in its terminal, a
 * design answer); a session he never spoke to sorts by its creation. A session that needs
 * him keeps its line and the rail badge, not a place at the top (dogfooding, 2026-11-10).
 */
export function sortedSessions(state: UiState): [string, SessionView][] {
    const recency = (view: SessionView) =>
        view.summary.session.last_interaction ?? view.summary.session.created;
    return Object.entries(state.sessions).sort(([, a], [, b]) =>
        recency(b).localeCompare(recency(a)),
    );
}

/**
 * True while the session works: an agent in a turn (`process: running`), a Goldfish of the
 * lead still running, or a reviewer of the swarm. The lead settles while its Goldfish run,
 * so the agents alone would read idle during a brainstorm or a review.
 */
export function agentWorking(view: SessionView): boolean {
    const agents = Object.values(view.summary.session.agents ?? {});
    if (agents.some((agent) => agent.process === "running")) {
        return true;
    }
    if ((view.design?.goldfish_live ?? 0) > 0) {
        return true;
    }
    return (view.review?.swarm ?? []).some((member) => member.state === "reading");
}

/**
 * "just now", "5 min ago", "3 h ago", "2 d ago" for the card's last interaction; null when
 * the operator never spoke to the session or the stamp does not parse.
 */
export function agoText(iso: string | undefined, now: Date): string | null {
    if (iso === undefined) {
        return null;
    }
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) {
        return null;
    }
    const minutes = Math.floor((now.getTime() - then) / 60_000);
    if (minutes < 1) {
        return "just now";
    }
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours} h ago`;
    }
    return `${Math.floor(hours / 24)} d ago`;
}

/** The job that is running on a session, if any. Used to disable that session's buttons. */
export function runningJob(state: UiState, dir: string): Job | undefined {
    return Object.values(state.jobs).find((job) => job.session === dir && job.state === "running");
}
