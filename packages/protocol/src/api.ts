// The daemon's HTTP and WebSocket surface, API v1. The daemon binds to loopback only; there is
// no authentication in v1. Request and response bodies are JSON. Reads return a `SessionView`,
// the one shape the UI renders; writes return `202 { job }` at once and report progress as
// `job.log` and `job.finished` events (MISSION.md s003, Contracts: "actions are jobs").

import type { SpinnerEvent } from "./events.js";
import type { PrFacts, StageResult } from "./pipeline.js";
import type { PiEvent } from "./agent-event.js";
import type {
    AgentProcessState,
    CheckState,
    HostProcess,
    PrState,
    ReviewDecision,
    SessionKind,
    SessionSummary,
    StackLastJob,
    StackStateName,
    SwarmState,
} from "./session.js";
import type { DiffView } from "./diff.js";
import type { OperatorCost, SessionCost } from "./costs.js";
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
    /**
     * Create a session. Body: NewSessionRequest. With `title`, the job attaches the project.
     * With `text` (s014, chat first), the job attaches the project, adopts the `adopt` PRs,
     * starts the agent `lead` and prompts it with the text.
     */
    "POST /sessions": "JobResponse",
    /** The PR references in a paste, looked up on GitHub. Body: ExtractRequest. Synchronous. */
    "POST /sessions/extract": "ExtractResponse",
    /** Adopt PR references into an existing session. Body: SessionAdoptRequest. */
    "POST /sessions/:dir/adopt": "JobResponse",
    /** Set the title in `session.yaml` and the mission heading. Body: SessionTitleRequest. */
    "PUT /sessions/:dir/title": "SessionResponse",
    /** The structured mission (s014): the sections of MISSION.md parsed, derived on each read. */
    "GET /sessions/:dir/mission/view": "MissionViewResponse",
    /** Adopt PRs opened outside Spinner. Body: AdoptRequest. The job creates the session. */
    "POST /sessions/adopt": "JobResponse",
    /**
     * Reviews (s015): one session of `kind: review` per PR reference in `text`, any repository
     * the operator's `gh` can read. Body: ReviewsRequest. The job clones or fetches each
     * repository under `<home>/reviews/` and checks the PR head out detached under the
     * session, then (s016) starts the agent `lead` with the review lead's brief and the
     * swarm. 409 when no reference resolves.
     */
    "POST /reviews": "JobResponse",
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
    /**
     * Start the review swarm (s015) on each open PR, or the one `pr` names: one tty agent per
     * model in `settings.review.models`, each with the review brief, bounded by the
     * running-agents cap. Body: ReviewRequest. 409 without an open PR, while a reviewer of
     * the PR still reads, or when the PR's repo has no worktree.
     */
    "POST /sessions/:dir/review": "JobResponse",
    /** The lead's briefing (s016), `text/markdown`. 404 before `artifacts/briefing.md` exists. */
    "GET /sessions/:dir/review/briefing": "text/markdown",
    /** The lead's `review_briefing` tool (s016) writes `artifacts/briefing.md`. Body: markdown. */
    "PUT /sessions/:dir/review/briefing": "OkResponse",
    /**
     * The lead's `review_draft` tool and the operator's edits (s016): validates the draft (the
     * event, one severity label first in each comment, each `path:line` on the right side of
     * the PR diff) and writes `artifacts/review-draft.json`; `needs_human` asks to post or
     * drop. Body: ReviewDraft. 400 with every fault listed; nothing is written then.
     */
    "PUT /sessions/:dir/review/draft": "ReviewDraftResponse",
    /** Drop the draft (s016). 404 without one. */
    "DELETE /sessions/:dir/review/draft": "OkResponse",
    /**
     * Post the draft as one PR review at the head SHA through the operator's `gh` (s016).
     * `APPROVE` GitHub refuses for the author's own PR is reposted as `COMMENT`. 409 without
     * a draft; 502 when GitHub refuses. The URL lands in `session.yaml` and the Log.
     */
    "POST /sessions/:dir/review/post": "ReviewPostResponse",
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
    /**
     * Start the diff viewer of one repo, or of every repo. Body: DiffRepoRequest. The job
     * fetches the viewer's sources first when `diff.fetch` is not `ready`, then starts each
     * viewer and waits for it to serve `GET /`. 404 for an unknown repo.
     */
    "POST /sessions/:dir/diff/start": "JobResponse",
    /** Stop the diff viewer of one repo, or of every repo. Body: DiffRepoRequest. */
    "POST /sessions/:dir/diff/stop": "SessionResponse",
    /**
     * Run `diffview comments <command>` in the agent's worktree, as the agent. Body:
     * DiffCommentsRequest. 409 when `diffview` is not installed; 404 for an agent without a
     * repo. The CLI's exit code comes back in the body, not as the HTTP status.
     */
    "POST /sessions/:dir/agents/:name/diff/comments": "DiffCommentsResponse",
    /** A service's last log lines: a host service's file or `docker logs`. Query: `lines` */
    "GET /sessions/:dir/stack/logs/:service": "StackLogsResponse",
    /** The machine's memory, cpu and load, and each up stack's share. */
    "GET /usage": "UsageResponse",
    /** Costs over a span of days by period, session, model and agent. Query: from, to, group. */
    "GET /costs": "CostsResponse",
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
    /** The operator agent's extension reports pid and slash commands. Body: AgentHelloRequest. */
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
    /**
     * `review` for a review session (s015), `session` otherwise. The daemon always sets it;
     * optional so a fixture written before s015 still type-checks.
     */
    kind?: SessionKind;
    /** Null when the session has no PR yet; the stage is then in `summary.session.stage`. */
    board: BoardView | null;
    stack: StackView;
    /** Names of agents whose pi process the daemon currently hosts. */
    agents_running: string[];
    /** True while the stack is up: the operator can test and tick `verify`. */
    can_verify: boolean;
    /**
     * The diff viewers (s012). The daemon always sets it; optional so a fixture written
     * before s012 still type-checks.
     */
    diff?: DiffView;
    /**
     * What the session's agents have spent (s013), from their transcripts. The daemon always
     * sets it; optional so a fixture written before s013 still type-checks.
     */
    cost?: SessionCost;
    /**
     * The review facts (s015): set for a review session, and for an ordinary session once
     * its swarm ran. Absent otherwise.
     */
    review?: ReviewFields;
}

/** One reviewer of the swarm, as the chips show it: a tty agent of the session. */
export interface SwarmMember {
    /** The agent name, `review-<model-slug>`. */
    name: string;
    model: string;
    state: SwarmState;
    /** What the reviewer spent, from `SessionView.cost.agents[name]`. */
    usd: number;
    /** Repo key of the PR the reviewer reads. */
    pr: string;
}

/** The review fields of a `SessionView` (s015, s016); the `review.updated` payload. */
export interface ReviewFields {
    /** The PR's checks, rolled up, and the names of the failing ones. */
    checks: CheckState;
    failing: string[];
    review_decision: ReviewDecision;
    /** The PR's review threads, open and resolved. */
    threads: number;
    swarm: SwarmMember[];
    /** True once `artifacts/briefing.md` exists (s016). */
    briefing: boolean;
    /** The lead's draft (s016); null before it is written and after `drop` or `post`. */
    draft: ReviewDraft | null;
    /** The posted review's URL (s016), null until `post`. */
    posted_url: string | null;
}

/** The review events of a PR review, as GitHub names them (s016). */
export type ReviewEvent = "APPROVE" | "COMMENT";

export const REVIEW_EVENTS: readonly ReviewEvent[] = ["APPROVE", "COMMENT"];

/** One line comment of the draft: the file, the line on the right side of the diff, the body. */
export interface ReviewDraftComment {
    path: string;
    line: number;
    /** Starts with one of `REVIEW_SEVERITY_LABELS`. */
    body: string;
}

/** The lead's draft, `artifacts/review-draft.json` (s016): the operator edits it, then posts. */
export interface ReviewDraft {
    event: ReviewEvent;
    /** The summary only; the line comments are not repeated here. */
    body: string;
    comments: ReviewDraftComment[];
}

/** The labels a line comment starts with, as the `pr-review` skill names them. */
export const REVIEW_SEVERITY_LABELS = ["BLOCKING:", "BUG:", "NIT:", "SUPER NIT:"] as const;

/** `needs_human` while a draft waits (s016); it wins over the pipeline's own text. */
export const REVIEW_DRAFT_NEEDS_HUMAN = "post or drop the review draft";

/** The agent that leads a session (s014) and reconciles its review (s016). */
export const LEAD_NAME = "lead";

/** Body of `PUT /sessions/:dir/review/briefing`. */
export interface ReviewBriefingRequest {
    markdown: string;
}

/** `PUT .../review/briefing` and `DELETE .../review/draft` answer this. */
export interface OkResponse {
    ok: true;
}

export interface ReviewDraftResponse {
    draft: ReviewDraft;
}

export interface ReviewPostResponse {
    /** The posted review's `html_url`. */
    url: string;
    /** The event GitHub took. */
    event: ReviewEvent;
    /** True when `APPROVE` was refused for the author's own PR and `COMMENT` was posted. */
    fell_back: boolean;
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
    | "review"
    | "reviews"
    | "post"
    | "approve"
    | "land"
    | "reset"
    | "diff";

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
    "review",
    "reviews",
    "post",
    "approve",
    "land",
    "reset",
    "diff",
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

/**
 * `POST /sessions`. One of `title` and `text` is required. With `text` (s014, chat first)
 * the title is provisional: the first non-empty line of the text without its PR references,
 * else the first adopted PR's title, else `New session`. The lead agent sets the real one.
 */
export interface NewSessionRequest {
    title?: string;
    /** What the session is about, as pasted. Becomes the lead agent's first message. */
    text?: string;
    /** Optional slug. Derived from the title when absent. */
    slug?: string;
    /** Project name or spec path (`ProjectView.path`). Without it, the session has no stack. */
    project?: string;
    /** PR URLs from `ExtractResponse.prs` to adopt: a worktree on each PR's head branch. */
    adopt?: string[];
}

/** `POST /sessions/extract`: the PR references in `text`, resolved against `project`'s repos. */
export interface ExtractRequest {
    text: string;
    /** Project name or spec path; without it only full URLs resolve and none is adoptable. */
    project?: string;
}

/** Upper bound on references one extract resolves; the rest are ignored. */
export const EXTRACT_REFS_MAX = 20;

/**
 * One PR reference found in a paste. `ref` is the text as written (`owner/repo#12`, a URL,
 * `#12`). The GitHub fields are null when the reference did not resolve to a repo (an
 * ambiguous bare `#N`) or the lookup failed; `reason` then says why.
 */
export interface ExtractedPr {
    ref: string;
    url: string | null;
    /** GitHub `owner/name`. */
    repo: string | null;
    /** The project's repo key when the repo is one of the project's; null otherwise. */
    key: string | null;
    number: number;
    title: string | null;
    /** The PR's head branch. */
    branch: string | null;
    base: string | null;
    /** True when `POST /sessions` can make a worktree for it: the repo is in the project. */
    adoptable: boolean;
    reason?: string;
}

export interface ExtractResponse {
    prs: ExtractedPr[];
    /** The text with every reference removed, lines trimmed, blank runs collapsed to one. */
    rest: string;
}

/** `POST /sessions/:dir/adopt`: PR references, in any form `POST /sessions/extract` takes. */
export interface SessionAdoptRequest {
    refs: string[];
}

/** `PUT /sessions/:dir/title`. */
export interface SessionTitleRequest {
    title: string;
}

/** Upper bound on a session title; the provisional one from a paste is cut to this. */
export const SESSION_TITLE_MAX = 80;

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

/** `POST /sessions/:dir/review`: the review swarm on the open PRs (s015). */
export interface ReviewRequest {
    /** Repo key of one PR. Every open PR when absent. */
    pr?: string;
}

/** `POST /reviews`: PR references in any form `POST /sessions/extract` takes. */
export interface ReviewsRequest {
    text: string;
}

/** `settings.review` when absent: the models of the swarm and how many of them run. */
export const REVIEW_MODELS_DEFAULT: readonly string[] = [
    "x-ai/grok-4.6",
    "anthropic/claude-opus-5-5",
    "openai/gpt-6-luna",
];
export const REVIEW_N_DEFAULT = 3;

/** The agent name of a reviewer: `review-` and the model id as a name. */
export const REVIEW_AGENT_PREFIX = "review-";

/** `x-ai/grok-4.6` becomes `x-ai-grok-4-6`: lower case, one dash per run of other characters. */
export function model_slug(model: string): string {
    return model
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/**
 * The first line of a reviewer's verdict block (s016, the `reviewer` role's contract); the
 * daemon saves the settled turn's last assistant text that carries it as the verdict file.
 */
export const REVIEW_VERDICT_PREFIX = "VERDICT:";

/** Where the verdict files go, under the session directory: `<model-slug>.md` in it. */
export const REVIEW_VERDICTS_DIR = "artifacts/reviews";
export const REVIEW_BRIEFING_FILE = "artifacts/briefing.md";
export const REVIEW_DRAFT_FILE = "artifacts/review-draft.json";
export const REVIEW_POSTED_FILE = "artifacts/review-posted.json";

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
    /** True once the extension inside pi posted `hello`: a prompt or a notice reaches it. */
    ready: boolean;
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
    /** What the operator agent has spent (s013). Optional for fixtures written before s013. */
    cost?: OperatorCost;
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

/** A Plan item, from `- [ ] 3. text (owner)` or `- [x] 3. text (owner, 14:02)`. */
export interface PlanItem {
    id: number;
    text: string;
    owner: string | null;
    /**
     * `done` when ticked. `doing` when unticked and the owner's Roster `Doing` names `#id` or
     * `item id`, or is active (not `—`, empty or `done`) and this is that owner's lowest
     * unticked id. `next` otherwise.
     */
    state: "next" | "doing" | "done";
    /** `HH:MM` from the tick, or null. */
    ticked_at: string | null;
}

/** A Done when item, from `- [ ] text` or `- [x] text (owner, 14:02)`. `id` is its position. */
export interface DoneWhenItem {
    id: number;
    text: string;
    owner: string | null;
    state: "open" | "done";
    ticked_at: string | null;
}

/** One Roster row; the cells as written. */
export interface RosterRow {
    agent: string;
    owns: string;
    doing: string;
    blocked: string;
    updated: string;
}

/** A Contracts line, `- HH:MM author: text` or `- YYYY-MM-DD author: text`; `id`: position. */
export interface MissionLine {
    id: number;
    ts: string | null;
    author: string | null;
    text: string;
}

/** An Open questions line `- author: text`; `answer` is the indented lines under it, if any. */
export interface QuestionItem {
    id: number;
    author: string | null;
    text: string;
    answer: string | null;
}

/** A Log line `- HH:MM author: text`. */
export interface LogLine {
    ts: string;
    author: string;
    text: string;
}

/**
 * The structured mission (s014): MISSION.md parsed, derived on every read and never stored.
 * `log` is in file order, oldest first. The markdown file stays the source of truth; the
 * workspace writes through `PUT /sessions/:dir/mission/section`.
 */
export interface MissionView {
    title: string;
    goal: string;
    done_when: DoneWhenItem[];
    plan: PlanItem[];
    roster: RosterRow[];
    contracts: MissionLine[];
    questions: QuestionItem[];
    log: LogLine[];
}

export interface MissionViewResponse {
    view: MissionView;
}

export interface ErrorResponse {
    error: string;
}

/** What the client receives on the `/events` socket, in case the message shape grows. */
export type EventsMessage = SpinnerEvent;
