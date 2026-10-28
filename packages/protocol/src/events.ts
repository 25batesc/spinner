// The daemon's event bus. Every event the UI renders is one of these, sent over the WebSocket
// at `/events` as one JSON object per message. The list follows docs/ARCHITECTURE.md,
// section "Event model". Events the walking skeleton does not emit yet still have a type so the
// fixture server and the UI can agree on the shape before the daemon fills it in.

import type { PiEvent } from "./agent-event.js";
import type { Job, SessionView } from "./api.js";
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

export interface ThreadsUpdatedEvent extends EventBase {
    type: "threads.updated";
    repo: string;
    number: number;
    opened: string[];
    resolved: string[];
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
}

export interface InboxMessageEvent extends EventBase {
    type: "inbox.message";
    /** File name in `inbox/`, for example `114502-backend-api-admin-ui.md`. */
    file: string;
    from: string;
    to: string;
    subject: string;
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
    | InboxMessageEvent;

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
    "job.started",
    "job.log",
    "job.finished",
];
