// The daemon's HTTP and WebSocket surface, API v1. The daemon binds to loopback only; there is
// no authentication in v1. Request and response bodies are JSON. Reads return a `SessionView`,
// the one shape the UI renders; writes return `202 { job }` at once and report progress as
// `job.log` and `job.finished` events (MISSION.md s003, Contracts: "actions are jobs").

import type { SpinnerEvent } from "./events.js";
import type { PrFacts, StageResult } from "./pipeline.js";
import type { HostProcess, SessionSummary, StackStateName } from "./session.js";

export const DAEMON_HOST = "127.0.0.1";
export const DAEMON_PORT = 7777;
export const DAEMON_URL = `http://localhost:${DAEMON_PORT}`;
export const EVENTS_WS_URL = `ws://localhost:${DAEMON_PORT}/events`;

/** REST routes. The key is `METHOD path`; the value documents the response body. */
export const ROUTES = {
    /** Liveness probe. */
    "GET /health": "HealthResponse",
    /** The projects a session can be created from: every `spinner.yaml` the daemon can find. */
    "GET /projects": "ProjectsResponse",
    /** Every session under `~/.spinner/sessions`, as the daemon currently sees it. */
    "GET /sessions": "SessionsResponse",
    /** One session by directory name. 404 when it does not exist. */
    "GET /sessions/:dir": "SessionResponse",
    /** The raw MISSION.md of a session. Content-Type text/markdown. */
    "GET /sessions/:dir/mission": "text/markdown",
    /** Create a session. Body: NewSessionRequest. The job creates it and attaches the project. */
    "POST /sessions": "JobResponse",
    /** Adopt PRs opened outside Spinner. Body: AdoptRequest. The job creates the session. */
    "POST /sessions/adopt": "JobResponse",
    /** Bring the stack up. Body: UpRequest (optional). */
    "POST /sessions/:dir/up": "JobResponse",
    /** Stop the stack; volumes and the database stay. */
    "POST /sessions/:dir/down": "JobResponse",
    /** Remove containers, database and worktrees; archive the session. */
    "POST /sessions/:dir/close": "JobResponse",
    /** Record the operator's local test of the session's PRs. Body: VerifyRequest (optional). */
    "POST /sessions/:dir/verify": "JobResponse",
    /** Add an agent from a brief and start it. Body: AddAgentRequest. 201 when the brief exists. */
    "POST /sessions/:dir/agents": "AgentResponse",
    /** Send a prompt to a running agent. Body: AgentMessageRequest. */
    "POST /sessions/:dir/agents/:name/prompt": "AgentCommandResponse",
    /** Queue a steer message; it enters after the current turn and tool calls. */
    "POST /sessions/:dir/agents/:name/steer": "AgentCommandResponse",
    /** Abort the agent's current run. */
    "POST /sessions/:dir/agents/:name/abort": "AgentCommandResponse",
    /** Stop the agent's process. Its transcript stays and `resume` picks it up. */
    "POST /sessions/:dir/agents/:name/stop": "AgentCommandResponse",
    /** The models pi can run, for the agent tab's model picker. */
    "GET /models": "ModelsResponse",
    /** One job by id. 404 when the daemon never ran it (jobs live in memory only). */
    "GET /jobs/:id": "JobResponse",
} as const;

export type Route = keyof typeof ROUTES;

/** WebSocket path. Each message is one `SpinnerEvent` as JSON. */
export const EVENTS_PATH = "/events";

export interface HealthResponse {
    ok: true;
    /** Absolute path of the Spinner home the daemon reads, normally `~/.spinner`. */
    home: string;
    /** Process start time, ISO 8601. */
    started: string;
}

/** A `spinner.yaml` the daemon found: in `<home>/projects`, `local/` or `examples/`. */
export interface ProjectView {
    /** `name:` of the spec. */
    name: string;
    /** Absolute path of the spec file. `NewSessionRequest.project` accepts it. */
    path: string;
    /** Where the spec was found. `home` is `<home>/projects/<name>`. */
    source: "home" | "local" | "examples";
    repos: string[];
    services: string[];
}

export interface ProjectsResponse {
    projects: ProjectView[];
}

/** Where a service runs. */
export type ServiceWhere = "container" | "host";

/**
 * A service's health as the daemon last observed it. `unknown` is a service with no
 * healthcheck that is running; `stopped` covers a stack that is down or a missing container.
 */
export type ServiceStatus = "starting" | "healthy" | "unhealthy" | "stopped" | "unknown";

export interface ServiceView {
    name: string;
    where: ServiceWhere;
    status: ServiceStatus;
    /** `<host>.<id>.localhost`, or null for an internal service. */
    host: string | null;
    /** Full URL of the service through the proxy, or null for an internal service. */
    url: string | null;
    /** For `where: host`: the process `spinner up` started, while the stack is up. */
    process: HostProcess | null;
}

/** Stack state assembled from `session.yaml` and the daemon's last docker observation. */
export interface StackView {
    state: StackStateName;
    /** Docker compose project name, or null when the session has no stack. */
    project: string | null;
    /** Per-session database name, or null when the session has no stack. */
    database: string | null;
    /** Every service of the spec, in spec order. Empty when the session has no stack. */
    services: ServiceView[];
    /** ISO 8601 time of the last docker observation, or null before the first one. */
    observed: string | null;
}

/** The pipeline tracker's view of a session: the derived stage and the PR facts behind it. */
export interface BoardView extends StageResult {
    /** One entry per repo with a PR, in `session.yaml` order. */
    prs: PrFacts[];
}

/**
 * Everything the UI renders for one session. `GET /sessions` returns one per session and
 * `session.updated` carries a fresh one on every change, so the UI never polls.
 */
export interface SessionView {
    summary: SessionSummary;
    /** Null when the session has no PR yet; the stage is then in `summary.session.stage`. */
    board: BoardView | null;
    stack: StackView;
    /** Names of agents whose pi process the daemon currently hosts. */
    agents_running: string[];
}

export interface SessionsResponse {
    sessions: SessionView[];
}

export interface SessionResponse {
    session: SessionView;
}

/** The actions the daemon runs as jobs. */
export type JobAction = "new" | "adopt" | "up" | "down" | "close" | "verify";

export const JOB_ACTIONS: readonly JobAction[] = ["new", "adopt", "up", "down", "close", "verify"];

export type JobState = "running" | "ok" | "failed";

export interface Job {
    /** Unique within one daemon process, for example `j-17`. */
    id: string;
    action: JobAction;
    /**
     * Session directory name. Null for `adopt` until the job created the session; the
     * `job.finished` event then names it.
     */
    session: string | null;
    state: JobState;
    /** ISO 8601 timestamps. */
    started: string;
    finished: string | null;
    /** The log lines so far, bounded; the same lines the CLI prints. */
    log: string[];
    /** The failure message when `state` is `failed`. */
    error: string | null;
}

export interface JobResponse {
    job: Job;
}

export interface NewSessionRequest {
    title: string;
    /** Optional slug. Derived from the title when absent. */
    slug?: string;
    /** Project name or spec path (`ProjectView.path`). Without it, the session has no stack. */
    project?: string;
}

export interface AdoptRequest {
    /** GitHub pull request URLs, at least one. */
    urls: string[];
    project?: string;
    title?: string;
}

export interface UpRequest {
    /** Rebuild dev images even when they exist. */
    build?: boolean;
}

export interface VerifyRequest {
    /** Who ticked. Defaults to the daemon's user. */
    by?: string;
}

export interface AddAgentRequest {
    /** Agent name; `agents/<name>/BRIEF.md` must exist in the session. */
    name: string;
    /** pi model id as `provider/model`. The harness default when absent. */
    model?: string;
    /** Repo key of `session.repos`; the agent runs in its worktree. The session dir when absent. */
    repo?: string;
}

export interface AgentMessageRequest {
    text: string;
}

export interface AgentResponse {
    name: string;
    /** pi's session id for the agent's transcript, for resume. */
    pi_session_id: string | null;
}

export interface AgentCommandResponse {
    ok: true;
    /** pi's answer to a `prompt` or `steer`, for example `started` or `queued`. */
    disposition?: string;
}

export interface ModelView {
    provider: string;
    id: string;
    contextWindow: number;
    reasoning: boolean;
}

export interface ModelsResponse {
    models: ModelView[];
}

export interface ErrorResponse {
    error: string;
}

/** What the client receives on the `/events` socket, in case the message shape grows. */
export type EventsMessage = SpinnerEvent;
