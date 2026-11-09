// The daemon's event bus. Every event the UI renders is one of these, sent over the WebSocket
// at `/events` as one JSON object per message. The list follows docs/ARCHITECTURE.md,
// section "Event model". Events the walking skeleton does not emit yet still have a type so the
// fixture server and the UI can agree on the shape before the daemon fills it in.

import type { PiEvent } from "./agent-event.js";
import type {
    Job,
    MachineUsage,
    MissionView,
    OperatorView,
    ReviewFields,
    SessionUsage,
    SessionView,
} from "./api.js";
import type { CommentState, CommentWaitingOn } from "./comments.js";
import type { CostTotals, SessionCost } from "./costs.js";
import type { Settings } from "./theme.js";
import type { AgentProcessState, PullRequest, Stage, StackStateName } from "./session.js";

/** Fields every event carries. `ts` is an ISO 8601 timestamp set by the daemon. */
export interface EventBase {
    ts: string;
    /** Directory name of the session, for example `s17-refund-flow`. */
    session: string;
}

export interface SessionCreatedEvent extends EventBase {
    type: "session.created";
    data: SessionView;
}

/** The whole view again, on every change the daemon sees: a file write, a poll, a job step. */
export interface SessionUpdatedEvent extends EventBase {
    type: "session.updated";
    data: SessionView;
}

export interface SessionClosedEvent extends EventBase {
    type: "session.closed";
}

export interface PipelineUpdatedEvent extends EventBase {
    type: "pipeline.updated";
    stage: Stage;
    needs_human: string | null;
}

export interface PipelineTransitionEvent extends EventBase {
    type: "pipeline.transition";
    from: Stage;
    to: Stage;
    why: string;
}

export interface PrUpdatedEvent extends EventBase {
    type: "pr.updated";
    repo: string;
    pr: PullRequest;
}

/**
 * `threads/<repo>-<n>.md` was re-rendered. The lists carry thread labels (`T3`) that changed
 * state since the previous render; a first render lists every open thread as opened.
 */
export interface ThreadsUpdatedEvent extends EventBase {
    type: "threads.updated";
    repo: string;
    number: number;
    opened: string[];
    resolved: string[];
    /** Labels flagged since the previous render. */
    flagged: string[];
    /** The rendered file, relative to the session directory. */
    file: string;
}

export interface QueuePoppedEvent extends EventBase {
    type: "queue.popped";
    repo: string;
    number: number;
    reason: string;
}

export interface SlackActivityEvent extends EventBase {
    type: "slack.activity";
    post: string;
    author: string;
    kind: "reply" | "mention" | "reaction";
}

export interface AgentSpawnedEvent extends EventBase {
    type: "agent.spawned";
    agent: string;
    pid: number;
}

/** pi's own JSON event, forwarded untouched. The UI renders it as a pi TUI would. */
export interface AgentEventEvent extends EventBase {
    type: "agent.event";
    agent: string;
    event: PiEvent;
}

export interface AgentSettledEvent extends EventBase {
    type: "agent.settled";
    agent: string;
}

export interface AgentExitedEvent extends EventBase {
    type: "agent.exited";
    agent: string;
    process: AgentProcessState;
    code: number | null;
}

export type ServiceState = "starting" | "healthy" | "unhealthy" | "stopped";

export interface StackStateEvent extends EventBase {
    type: "stack.state";
    state: StackStateName;
    services: Record<string, ServiceState>;
}

export interface StackLogEvent extends EventBase {
    type: "stack.log";
    service: string;
    line: string;
}

/** Sections of MISSION.md, in file order. */
export type MissionSection =
    | "goal"
    | "done_when"
    | "plan"
    | "roster"
    | "contracts"
    | "open_questions"
    | "log";

export interface MissionChangedEvent extends EventBase {
    type: "mission.changed";
    /** Who made the change, when known; `unknown` when the file changed on disk without a tool. */
    author: string;
    sections: MissionSection[];
    /** The structured mission after the change (s014). Optional for fixtures written before. */
    view?: MissionView;
}

export interface InboxMessageEvent extends EventBase {
    type: "inbox.message";
    /** File name in `inbox/`, for example `114502-backend-api-admin-ui.md`. */
    file: string;
    from: string;
    to: string;
    subject: string;
}

/** How the daemon delivered an `inbox/` file or a mission-change notice to one agent. */
export type DeliveryKind =
    /** Sent as a pi steer to a running agent. */
    | "steer"
    /** Prepended to the next prompt of an idle agent. */
    | "prompt"
    /** Appended to the Log and shown in the UI: the recipient is `operator`. */
    | "log";

/** One delivery of an inbox message, or of the debounced "MISSION.md changed" steer. */
export interface MessageDeliveredEvent extends EventBase {
    type: "message.delivered";
    /** File name in `inbox/`, or null for a mission-change steer. */
    file: string | null;
    /** The agent the message went to, or `operator`. */
    agent: string;
    how: DeliveryKind;
}

/**
 * Job events carry the job's session, which is null for `adopt` until the job created it.
 * Every other event names an existing session.
 */
export interface JobEventBase {
    ts: string;
    session: string | null;
    job: string;
}

export interface JobStartedEvent extends JobEventBase {
    type: "job.started";
    data: Job;
}

/** One log line of a running job; the same line the CLI prints. */
export interface JobLogEvent extends JobEventBase {
    type: "job.log";
    line: string;
}

export interface JobFinishedEvent extends JobEventBase {
    type: "job.finished";
    ok: boolean;
    error?: string;
    data: Job;
}

/**
 * One usage sample, every `USAGE_INTERVAL_MS` while a stack is up: the machine and each up
 * stack's total and services, so a services table refreshes on the sample alone, without a
 * `session.updated`. Not tied to one session, so `session` is null.
 */
export interface UsageEvent {
    type: "usage";
    ts: string;
    session: null;
    machine: MachineUsage;
    sessions: Record<string, SessionUsage>;
}

/** `PUT /settings` wrote `~/.spinner/settings.yaml`; the whole document follows. */
export interface SettingsEvent {
    type: "settings";
    ts: string;
    session: null;
    settings: Settings;
}

/**
 * The operator agent started, stopped, exited, began or ended a turn, or received a notice.
 * The whole view follows, as `session.updated` carries the session. Not tied to a session.
 */
export interface OperatorUpdatedEvent {
    type: "operator.updated";
    ts: string;
    session: null;
    data: OperatorView;
}

/**
 * The ledger refolded and something changed (s013): the running figures for the Usage page
 * and the cost of each session whose total moved, so a card updates without a view. Not
 * tied to one session, so `session` is null.
 */
export interface CostsEvent {
    type: "costs";
    ts: string;
    session: null;
    /** Local-zone today, the week from Monday, and the calendar month, up to now. */
    today: CostTotals;
    week: CostTotals;
    month: CostTotals;
    /** Session directories whose cost changed in this refold, with their new cost. */
    changed: Record<string, SessionCost>;
}

/**
 * The review facts of a session changed (s015): a reviewer was queued, started, posted or
 * failed, or the poller moved the PR's checks, decision or thread count. The whole
 * `ReviewFields` follows, as `session.updated` carries the view.
 */
export interface ReviewUpdatedEvent extends EventBase {
    type: "review.updated";
    data: ReviewFields;
}

/**
 * A preview comment (s054) was created, answered, suggested for resolution or resolved. The
 * UI reloads `GET /sessions/:dir/comments`; the event carries what the feed line needs.
 */
export interface CommentUpdatedEvent extends EventBase {
    type: "comment.updated";
    id: string;
    state: CommentState;
    waiting_on: CommentWaitingOn;
    /** Who made the change: `operator` or an agent name. */
    author: string;
}

/**
 * One local notification: a pipeline transition or a landed PR (#12). The desktop app posts it
 * as its own banner, so macOS shows Spinner's name and icon and a click opens the session.
 * The daemon runs its `osascript` banner only while no desktop client is connected to
 * `/events` (`?client=desktop`). `session` is the session directory, or null when the
 * notification belongs to no session.
 */
export interface NotifyEvent {
    type: "notify";
    ts: string;
    session: string | null;
    title: string;
    message: string;
}

/**
 * The query the desktop app's main process adds to the `/events` URL. The daemon counts the
 * sockets that carry it: while one is open, a notification is the `notify` event alone.
 */
export const EVENTS_CLIENT_PARAM = "client";
export const EVENTS_CLIENT_DESKTOP = "desktop";

export type SpinnerEvent =
    | JobStartedEvent
    | JobLogEvent
    | JobFinishedEvent
    | SessionCreatedEvent
    | SessionUpdatedEvent
    | SessionClosedEvent
    | PipelineUpdatedEvent
    | PipelineTransitionEvent
    | PrUpdatedEvent
    | ThreadsUpdatedEvent
    | QueuePoppedEvent
    | SlackActivityEvent
    | AgentSpawnedEvent
    | AgentEventEvent
    | AgentSettledEvent
    | AgentExitedEvent
    | StackStateEvent
    | StackLogEvent
    | MissionChangedEvent
    | InboxMessageEvent
    | MessageDeliveredEvent
    | UsageEvent
    | SettingsEvent
    | OperatorUpdatedEvent
    | CostsEvent
    | ReviewUpdatedEvent
    | CommentUpdatedEvent
    | NotifyEvent;

export type SpinnerEventType = SpinnerEvent["type"];

/** Every event type, for exhaustiveness checks and for the fixture server. */
export const EVENT_TYPES: readonly SpinnerEventType[] = [
    "session.created",
    "session.updated",
    "session.closed",
    "pipeline.updated",
    "pipeline.transition",
    "pr.updated",
    "threads.updated",
    "queue.popped",
    "slack.activity",
    "agent.spawned",
    "agent.event",
    "agent.settled",
    "agent.exited",
    "stack.state",
    "stack.log",
    "mission.changed",
    "inbox.message",
    "message.delivered",
    "job.started",
    "job.log",
    "job.finished",
    "usage",
    "settings",
    "operator.updated",
    "costs",
    "review.updated",
    "comment.updated",
    "notify",
];
