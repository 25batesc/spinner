// The daemon's HTTP and WebSocket surface, API v1. The daemon binds to loopback only; there is
// no authentication in v1. Request and response bodies are JSON. Reads return a `SessionView`,
// the one shape the UI renders; writes return `202 { job }` at once and report progress as
// `job.log` and `job.finished` events (MISSION.md s003, Contracts: "actions are jobs").

import type { SpinnerEvent } from "./events.js";
import type { PrFacts, StageResult } from "./pipeline.js";
import type { PiEvent } from "./agent-event.js";
import type {
    AgentProcessState,
    HostProcess,
    PrState,
    SessionSummary,
    StackLastJob,
    StackStateName,
} from "./session.js";
import type { PreviewMode } from "./stack-spec.js";
import type { ThreadView, ThreadsView } from "./threads.js";

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
    /** Attach a project to an adopted session: worktrees on the PR branches. Body: AttachRequest */
    "POST /sessions/:dir/attach": "JobResponse",
    /** Bring the stack up. Body: UpRequest (optional). */
    "POST /sessions/:dir/up": "JobResponse",
    /** Stop the stack; volumes and the database stay. */
    "POST /sessions/:dir/down": "JobResponse",
    /** Remove containers, database and worktrees; archive the session. */
    "POST /sessions/:dir/close": "JobResponse",
    /** Record the operator's local test of the session's PRs. Body: VerifyRequest (optional). */
    "POST /sessions/:dir/verify": "JobResponse",
    /** Clear the tick; the stage asks for the test again. Synchronous: the new view answers. */
    "DELETE /sessions/:dir/verify": "SessionResponse",
    /** Push every changed repo and open one PR per repo as the operator. Body: PrRequest. */
    "POST /sessions/:dir/pr": "JobResponse",
    /** Render `threads/` from GitHub, then start or steer the fixer agent. Body: FixRequest. */
    "POST /sessions/:dir/fix": "JobResponse",
    /** The review threads of every PR, from the last render. 404 without a session. */
    "GET /sessions/:dir/threads": "ThreadsResponse",
    /** Re-render `threads/` from GitHub now and return it. */
    "POST /sessions/:dir/threads/refresh": "ThreadsResponse",
    /** Reply in a thread as the operator. Body: ThreadReplyRequest. */
    "POST /sessions/:dir/threads/:id/reply": "ThreadResponse",
    /** Resolve a thread. 409 without a reply, or for a human thread when `resolve_human` is off. */
    "POST /sessions/:dir/threads/:id/resolve": "ThreadResponse",
    /** Flag a thread for the operator. Body: ThreadFlagRequest. */
    "POST /sessions/:dir/threads/:id/flag": "ThreadResponse",
    /** The composed Slack message, before anything is sent. */
    "GET /sessions/:dir/post": "PostResponse",
    /** Post the composed message. Body: PostRequest with `confirm: true`; 400 otherwise. */
    "POST /sessions/:dir/post": "JobResponse",
    /** What `approve` would submit: head, diff stat and open threads per PR. */
    "GET /sessions/:dir/approve": "ApproveResponse",
    /** Submit the operator's approving review. Body: ApproveRequest with `confirm: true`. */
    "POST /sessions/:dir/approve": "JobResponse",
    /** Enqueue every PR with its head, watch, rebase and re-enqueue on a pop-out. */
    "POST /sessions/:dir/land": "JobResponse",
    /** Start the next round: new branch from fresh base, facts cleared, mission history kept. */
    "POST /sessions/:dir/reset": "JobResponse",
    /** Write one section of MISSION.md. Body: MissionSectionRequest. The daemon serializes. */
    "PUT /sessions/:dir/mission/section": "MissionSectionResponse",
    /** Write an `inbox/` message and deliver it. Body: InboxMessageRequest. */
    "POST /sessions/:dir/inbox": "InboxMessageResponse",
    /** The agent's context-file chain and loaded commands. */
    "GET /sessions/:dir/agents/:name/context": "ContextResponse",
    /** Write one context file of the chain. Body: ContextFileRequest. */
    "PUT /sessions/:dir/agents/:name/context": "ContextFileResponse",
    /** The brief the daemon writes for an agent without one. Query: `name=`, `repo=`, optional. */
    "GET /sessions/:dir/agents/default-brief": "DefaultBriefResponse",
    /** Add an agent and start it. Body: AddAgentRequest. 201 once a brief exists or is written. */
    "POST /sessions/:dir/agents": "AgentResponse",
    /** Send a prompt to a running agent. Body: AgentMessageRequest. */
    "POST /sessions/:dir/agents/:name/prompt": "AgentCommandResponse",
    /** Queue a steer message; it enters after the current turn and tool calls. */
    "POST /sessions/:dir/agents/:name/steer": "AgentCommandResponse",
    /** Abort the agent's current run. */
    "POST /sessions/:dir/agents/:name/abort": "AgentCommandResponse",
    /** Stop the agent's process. Its transcript stays and `resume` picks it up. */
    "POST /sessions/:dir/agents/:name/stop": "AgentCommandResponse",
    /** The agent's past turns from its pi transcript, for a tab that loads after the fact. */
    "GET /sessions/:dir/agents/:name/events": "AgentEventsResponse",
    /** A tty agent's extension reports pi's pid and slash commands. Body: AgentHelloRequest. */
    "POST /sessions/:dir/agents/:name/hello": "AgentCommandResponse",
    /** Long-poll (30 s) for the next command to a tty agent's extension. Query: ack, disposition */
    "GET /sessions/:dir/agents/:name/commands": "AgentCommandPollResponse",
    /** The extension of a tty agent posts pi's lifecycle events. Body: AgentEventsRequest. 202. */
    "POST /sessions/:dir/agents/:name/events": "AgentCommandResponse",
    /** WebSocket upgrade to a tty agent's pty; see `TTY_PATH` and `TtyClientMessage`. */
    "GET /sessions/:dir/agents/:name/tty": "websocket",
    /** A service's last log lines: a host service's file or `docker logs`. Query: `lines` */
    "GET /sessions/:dir/stack/logs/:service": "StackLogsResponse",
    /** The machine's memory, cpu and load, and each up stack's share. */
    "GET /usage": "UsageResponse",
    /** The operator's settings from `~/.spinner/settings.yaml`, defaults when absent. */
    "GET /settings": "SettingsResponse",
    /** Replace the settings. Body: the whole `Settings` document; 400 names the first problem. */
    "PUT /settings": "SettingsResponse",
    /** The built-in themes and every valid `~/.spinner/themes/<name>.json`; invalid ones named. */
    "GET /themes": "ThemesResponse",
    /** Overwrite `agents/:name/BRIEF.md`. Body: AgentBriefRequest. Creates the directory. */
    "PUT /sessions/:dir/agents/:name/brief": "AgentBriefResponse",
    /** The operator agent of this home: process state, pid, model, notices (MISSION.md s013). */
    "GET /operator": "OperatorResponse",
    /** Start the operator agent, or resume it on its transcript. 409 while it runs. */
    "POST /operator/start": "OperatorResponse",
    /** Stop the operator agent's process. Its transcript stays. 409 when it does not run. */
    "POST /operator/stop": "OperatorResponse",
    /** Send a prompt to the operator agent. Body: AgentMessageRequest. 409 when not running. */
    "POST /operator/prompt": "AgentCommandResponse",
    /** Queue a steer for the operator agent. Body: AgentMessageRequest. 409 when not running. */
    "POST /operator/steer": "AgentCommandResponse",
    /** WebSocket upgrade to the operator agent's pty; the frames of `GET .../agents/:name/tty`. */
    "GET /operator/tty": "websocket",
    /** The operator agent's extension reports pi's pid and slash commands. Body: AgentHelloRequest. */
    "POST /operator/hello": "AgentCommandResponse",
    /** Long-poll (30 s) for the next command to the operator agent's extension. */
    "GET /operator/commands": "AgentCommandPollResponse",
    /** The operator agent's extension posts pi's lifecycle events. Body: AgentEventsRequest. */
    "POST /operator/events": "AgentCommandResponse",
    /** The models pi can run, for the agent tab's model picker. */
    "GET /models": "ModelsResponse",
    /** Running jobs plus the last finished ones, oldest first, for a page that loads mid-job. */
    "GET /jobs": "JobsResponse",
    /** One job by id. 404 when the daemon never ran it (jobs live in memory only). */
    "GET /jobs/:id": "JobResponse",
} as const;

export type Route = keyof typeof ROUTES;

/** WebSocket path. Each message is one `SpinnerEvent` as JSON. */
export const EVENTS_PATH = "/events";

/**
 * The pty WebSocket of a tty agent. Binary frames are the pty's bytes in both directions.
 * Server to client: first one binary frame with the scrollback (0 to `TTY_SCROLLBACK_BYTES`
 * bytes), then one per pty chunk, then one text frame `TtyServerMessage` `exit` and close 1000.
 * Client to server: binary frames are keystrokes; the one text frame is `TtyClientMessage`.
 * Before the upgrade a problem is plain HTTP: 404 when the agent is not running, 409 for an
 * `rpc` agent or when `TTY_ATTACHMENTS_MAX` clients are attached.
 */
export function tty_path(dir: string, name: string): string {
    return `/sessions/${encodeURIComponent(dir)}/agents/${encodeURIComponent(name)}/tty`;
}

/** The operator agent's pty WebSocket: the same frames as `tty_path`, 404 while it is stopped. */
export const OPERATOR_TTY_PATH = "/operator/tty";

export const TTY_SCROLLBACK_BYTES = 64 * 1024;
export const TTY_ATTACHMENTS_MAX = 8;
/** The pty size before any client sent a resize. */
export const TTY_SIZE_DEFAULT = { cols: 120, rows: 40 } as const;
/** Upper bound on one `resize` dimension; a frame outside it closes the socket with 1008. */
export const TTY_DIMENSION_MAX = 1000;

export interface TtyResize {
    cols: number;
    rows: number;
}

/** The only text frame a client sends. */
export interface TtyClientMessage {
    resize: TtyResize;
}

/** The only text frame the daemon sends: the pty child is gone; close 1000 follows. */
export interface TtyServerMessage {
    exit: { code: number | null };
}

export interface HealthResponse {
    ok: true;
    /** Absolute path of the Spinner home the daemon reads, normally `~/.spinner`. */
    home: string;
    /** Process start time, ISO 8601. */
    started: string;
    /** What runs: for `spinner daemon status` and for telling a stale build from a fresh one. */
    build: BuildInfo;
    /**
     * The UI snapshot the daemon serves, named by the checkout's commit at start, or
     * `unversioned` outside a git checkout. Null when the daemon serves no UI.
     */
    ui_commit: string | null;
}

export interface BuildInfo {
    /** `@spinner/daemon`'s package version. */
    version: string;
    /** Short commit of the checkout the daemon runs from, or null outside a git checkout. */
    commit: string | null;
    /** Modification time of the daemon's `dist/main.js`, ISO 8601, or null when not built. */
    built: string | null;
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
    /** `services.<name>.preview` of the spec, `frame` when the spec leaves it out. */
    preview: PreviewMode;
    /** The last usage sample for this service, or null when the stack is down or unsampled. */
    usage?: ServiceUsage | null;
}

/**
 * What one service takes of the machine, from `docker stats` for a container and from `ps`
 * (the process and its descendants) for a host service. Bytes for memory and I/O, and cpu as
 * a percentage of one core, as docker and ps report it (200 means two cores busy).
 */
export interface ServiceUsage {
    cpu_pct: number;
    mem_bytes: number;
    /**
     * The limit `docker stats` prints: the container's own, or the engine's memory (Docker
     * Desktop's VM) for a container without one. Absent for a host service.
     */
    mem_limit_bytes?: number;
    /** Network and block I/O totals since the container started; containers only. */
    net_rx_bytes?: number;
    net_tx_bytes?: number;
    block_read_bytes?: number;
    block_write_bytes?: number;
    /** The host service's root pid. */
    pid?: number;
    /** The container's id. */
    container?: string;
}

/** The sum over a stack's services, from one sample. */
export interface StackUsage {
    cpu_pct: number;
    mem_bytes: number;
    /** ISO 8601 time of the sample. */
    sampled: string;
}

/** One session's sample: the stack total and each service, by service name. */
export interface SessionUsage {
    stack: StackUsage;
    services: Record<string, ServiceUsage>;
}

/** The machine around the stacks, from `os`: `GET /usage` and the `usage` event. */
export interface MachineUsage {
    mem_total_bytes: number;
    /**
     * Memory available to new work, not only "free" pages: on macOS free + inactive +
     * speculative pages from `vm_stat`, on linux `MemAvailable`, else `os.freemem()`.
     */
    mem_free_bytes: number;
    cpu_count: number;
    /** The 1-minute load average. */
    load_1m: number;
    /** Sessions whose stack is up and sampled. */
    stacks_up: number;
    /** The sum of every sampled stack's `mem_bytes`. */
    mem_sessions_bytes: number;
}

/** `GET /usage`: the last sample, or `machine` alone with no stack up. */
export interface UsageResponse {
    machine: MachineUsage;
    /** By session directory: the stack total and every service, so a table needs no view. */
    sessions: Record<string, SessionUsage>;
    /** ISO 8601 time of the last sample, or null before the first one. */
    sampled: string | null;
}

/** How often the sampler runs while at least one stack is up. */
export const USAGE_INTERVAL_MS = 5_000;

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
    /**
     * The last `up`, `down` or `reset` job, or null before the first one. The daemon always
     * sets it; optional so a fixture written before s011 still type-checks.
     */
    last_job?: StackLastJob | null;
    /** The last usage sample over the stack's services, or null when down or unsampled. */
    usage?: StackUsage | null;
}

/** `GET /sessions/:dir/stack/logs/:service`. */
export interface StackLogsResponse {
    service: string;
    where: ServiceWhere;
    /** The last `lines` lines, oldest first. */
    lines: string[];
}

/** Upper bound on `?lines=` of the stack logs route; the default is 100. */
export const STACK_LOGS_LINES_MAX = 2000;
export const STACK_LOGS_LINES_DEFAULT = 100;

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
    /** True while the stack is up: the operator can test and tick `verify`. */
    can_verify: boolean;
}

export interface SessionsResponse {
    sessions: SessionView[];
}

export interface SessionResponse {
    session: SessionView;
}

/** The actions the daemon runs as jobs. */
export type JobAction =
    | "new"
    | "adopt"
    | "attach"
    | "up"
    | "down"
    | "close"
    | "verify"
    | "pr"
    | "fix"
    | "post"
    | "approve"
    | "land"
    | "reset";

export const JOB_ACTIONS: readonly JobAction[] = [
    "new",
    "adopt",
    "attach",
    "up",
    "down",
    "close",
    "verify",
    "pr",
    "fix",
    "post",
    "approve",
    "land",
    "reset",
];

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

/** Every running job, plus the last `JOBS_RECENT_MAX` finished ones, oldest first. */
export interface JobsResponse {
    jobs: Job[];
}

export const JOBS_RECENT_MAX = 10;

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

export interface AttachRequest {
    /** Project name or spec path (`ProjectView.path`). */
    project: string;
}

export interface UpRequest {
    /** Rebuild dev images even when they exist. */
    build?: boolean;
}

export interface VerifyRequest {
    /** Who ticked. Defaults to the daemon's user. */
    by?: string;
}

export interface PrRequest {
    /** Repo keys to open PRs for. Every repo with commits ahead of its base when absent. */
    repos?: string[];
    /** Open as draft PRs; the stage then stays `building`. */
    draft?: boolean;
}

export interface FixRequest {
    /** Repo key of one PR. Every PR with open threads when absent. */
    pr?: string;
}

export interface ThreadsResponse {
    threads: ThreadsView;
}

export interface ThreadReplyRequest {
    text: string;
}

export interface ThreadFlagRequest {
    reason: string;
}

/** The thread after a reply, resolve or flag, re-read from GitHub. */
export interface ThreadResponse {
    repo: string;
    number: number;
    thread: ThreadView;
}

/** One PR as the Slack post and the approval dialog list it. */
export interface PrLink {
    repo: string;
    number: number;
    url: string;
    title: string;
    state: PrState;
}

/** `GET /sessions/:dir/post`: the message `post` would send, and whether it may. */
export interface PostView {
    /** Slack channel id from `pipeline.slack.channel`, or null when none is configured. */
    channel: string | null;
    /** The composed message, Slack mrkdwn. */
    text: string;
    /** The reviewer the message tags, from `PostRequest.to` or `pipeline.reviewer`. */
    reviewer: string | null;
    prs: PrLink[];
    /** `slack` with `SLACK_USER_TOKEN` in the daemon's environment; `fixture` without it. */
    transport: "slack" | "fixture";
    /** Why `post` would refuse (no channel, no PR, not verified), or null when it may post. */
    blocked: string | null;
    /** The post already made this round, from `pipeline.slack_post`; null before `post`. */
    posted: string | null;
}

export interface PostResponse {
    post: PostView;
}

export interface PostRequest {
    /** The operator saw the composed message and said yes. The route refuses `false`. */
    confirm: true;
    /** Reviewer to tag, as a Slack user id or `@name`. */
    to?: string;
}

/** Lines changed by one PR, from `gh pr diff --stat`. */
export interface DiffStat {
    files: number;
    additions: number;
    deletions: number;
}

/** What the operator approves for one PR; `approvable` is false with a reason otherwise. */
export interface ApprovePrView extends PrLink {
    head: string;
    diff: DiffStat;
    open_threads: number;
    /** True when the operator already approved this head, so a second review is refused. */
    approved: boolean;
    /** Null when `approve` may submit; else why not (open threads, author is you, done). */
    blocked: string | null;
}

export interface ApproveView {
    prs: ApprovePrView[];
}

export interface ApproveResponse {
    approve: ApproveView;
}

export interface ApproveRequest {
    /** The operator saw head, diff stat and open-thread count and said yes. */
    confirm: true;
    /** Repo key of one PR. Every approvable PR when absent. */
    pr?: string;
}

export interface LandRequest {
    /** Repo key of one PR. Every PR when absent. */
    pr?: string;
}

export interface ResetRequest {
    /** Branch for the next round. `<branch>-r<round>` when absent. */
    branch?: string;
}

/** Where a context file sits in the chain, from least to most specific. */
export type ContextScope = "user" | "session" | "repo" | "directory";

export interface ContextFileView {
    /** Absolute path. */
    path: string;
    scope: ContextScope;
    /** False for a position in the chain where no file exists yet. */
    exists: boolean;
    /** True when a git repository tracks the file: an edit changes the branch. */
    tracked: boolean;
    content: string;
}

/** A command the agent loaded: a skill, a prompt template or an extension command. */
export interface AgentCommandView {
    name: string;
    kind: "skill" | "template" | "extension";
    /** Source file, when pi reports one. */
    path: string | null;
    description: string;
}

/** `GET /sessions/:dir/agents/:name/context`. */
export interface ContextResponse {
    files: ContextFileView[];
    /** Empty while the agent is not running: pi reports commands only through RPC. */
    commands: AgentCommandView[];
}

export interface ContextFileRequest {
    /** One of `ContextFileView.path`. */
    path: string;
    content: string;
}

export interface ContextFileResponse {
    file: ContextFileView;
    /** True when the daemon restarted the agent so the edit reaches its next turn. */
    reloaded: boolean;
}

export interface AddAgentRequest {
    /** Agent name; the brief is `agents/<name>/BRIEF.md` in the session. */
    name: string;
    /**
     * Brief text to write when the session has none for the agent. Without it, the daemon
     * writes its default brief. An existing brief is kept either way.
     */
    brief?: string;
    /** pi model id as `provider/model`. The harness default when absent. */
    model?: string;
    /** Repo key of `session.repos`; the agent runs in its worktree. The session dir when absent. */
    repo?: string;
}

export interface AgentMessageRequest {
    text: string;
}

/** `GET /sessions/:dir/agents/default-brief`. */
export interface DefaultBriefResponse {
    brief: string;
}

/** `PUT /sessions/:dir/agents/:name/brief`: the whole file. */
export interface AgentBriefRequest {
    brief: string;
}

export interface AgentBriefResponse {
    ok: true;
    /** Absolute path of the brief written. */
    path: string;
}

/**
 * The operator agent of a home (MISSION.md s013): one tty pi under `<home>/operator/`, no
 * session. `GET /operator` returns it and `operator.updated` carries it on every change.
 */
export interface OperatorView {
    /** `settings.operator.enabled`: the daemon starts the agent at boot when true. */
    enabled: boolean;
    /** `idle`: pi runs and waits; `running`: a turn is in progress; `exited`: no process. */
    process: AgentProcessState;
    pid: number | null;
    /** `provider/model` the agent runs with, or null for pi's own default. */
    model: string | null;
    /** `<home>/operator`: the transcript (`pi/`), `BRIEF.md` and `inbox/`. */
    dir: string;
    /** What the agent waits on: a person in its terminal, the model, or `start`. */
    waiting_on: "operator" | "model" | "start";
    /** The last notice the daemon delivered to the agent, or null. */
    last_notice: OperatorNotice | null;
    /** Notices batched or held (the agent is stopped) and not yet delivered. */
    notices_pending: number;
}

/** One batch of events the daemon turned into a `notify` for the operator agent. */
export interface OperatorNotice {
    ts: string;
    /** One line per event; each starts with the session directory. */
    text: string;
}

/** `GET /operator`, `POST /operator/start`, `POST /operator/stop`. */
export interface OperatorResponse {
    operator: OperatorView;
}

export interface AgentResponse {
    name: string;
    /** pi's session id for the agent's transcript, for resume. */
    pi_session_id: string | null;
}

/** The 409 body of `prompt` or `steer` on an agent the daemon does not host. */
export interface AgentNotRunningResponse extends ErrorResponse {
    process: AgentProcessState;
}

/** The agent's past turns, as the `message_end` events the UI folds, oldest first. */
export interface AgentEventsResponse {
    events: PiEvent[];
}

/** `POST /sessions/:dir/agents/:name/hello`: from the extension at pi's start and on reload. */
export interface AgentHelloRequest {
    pid: number;
    /** `pi.getCommands()`: the slash commands pi loaded, for the Context tab. */
    commands: PiCommandInfo[];
}

/** pi's `SlashCommandInfo`, the fields the Context tab shows. */
export interface PiCommandInfo {
    name: string;
    description?: string;
    source: "extension" | "prompt" | "skill";
    sourceInfo?: { path?: string };
}

/**
 * One command the daemon hands a tty agent's extension; `text` is absent for `abort`.
 * `notify` is a message from the daemon itself (a failed stack job), delivered as a custom
 * message that starts or steers a turn, so the agent reacts without being asked.
 */
export interface AgentExtensionCommand {
    id: string;
    type: "prompt" | "steer" | "abort" | "notify";
    text?: string;
}

/** `GET /sessions/:dir/agents/:name/commands`: 200 with one command, or 204 after 30 s. */
export interface AgentCommandPollResponse {
    command: AgentExtensionCommand;
}

/** `POST /sessions/:dir/agents/:name/events`, batched by the extension; body bound 8 MiB. */
export interface AgentEventsRequest {
    events: PiEvent[];
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
