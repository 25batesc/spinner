// Types for `session.yaml`, the machine state of one session. The daemon is the only writer;
// the CLI writes the initial file at `spinner new`. The shape follows
// docs/SESSION_PROTOCOL.md, section "session.yaml". The JSON schema in `schema/session.json`
// is generated from this file; run `pnpm --filter @spinner/protocol schema` after an edit.

import type { DesignState } from "./egm.js";

/** The schema version this package understands. The daemon migrates older files forward. */
export const SESSION_VERSION = 1 as const;

/** Pipeline stages, in order. The daemon derives the stage; nobody sets it by hand. */
export const STAGES = [
    "planned",
    "building",
    "bot-review",
    "fixing",
    "verifying",
    "peer-review",
    "addressing",
    "approving",
    "queued",
    "merged",
    "closed",
] as const;

export type Stage = (typeof STAGES)[number];

export type PrState = "draft" | "open" | "merged" | "closed";
export type CheckState = "pending" | "green" | "red";
export type ApprovalCheckState = "pending" | "pass" | "fail";
export type ReviewDecision = "none" | "changes_requested" | "approved";
export type QueueState = "none" | "queued" | "popped" | "merging";
export type ApprovalRole = "peer" | "owner";

export interface PrApprovals {
    required: ApprovalRole[];
    /** Logins of peers who approved the current head. */
    peer: string[];
    /** Whether the owner (the person named in `github.owner_login`) approved the current head. */
    owner: boolean;
}

export interface PrThreads {
    bots_open: number;
    humans_open: number;
    resolved: number;
    /** Open threads the fixer flagged for the operator. Absent in files written before s005. */
    flagged?: number;
}

export interface PullRequest {
    number: number;
    url: string;
    author: string;
    state: PrState;
    head: string;
    checks: CheckState;
    approval_check: ApprovalCheckState;
    approvals: PrApprovals;
    threads: PrThreads;
    review: ReviewDecision;
    /** Head SHA of the latest bot review, or null before the first one. */
    bot_reviewed_head: string | null;
    queue: QueueState;
    /** Why the merge queue removed the PR, from `RemovedFromMergeQueueEvent.reason`. */
    queue_reason?: string | null;
    /** ISO 8601 timestamp of the last activity on the PR. */
    last_activity: string;
    /** PR title, as `gh pr create` set it or GitHub reports it. Absent before s005. */
    title?: string;
    /** Names of the checks that are red, for the CI pill's tooltip (s015). Absent before s015. */
    checks_failing?: string[];
}

export interface SessionRepo {
    /** Path of the repo on this machine. May start with `~` or be relative to the session. */
    path: string;
    /** Worktree path relative to the session directory. Absent for the bootstrap session. */
    worktree?: string;
    /** True when the session's branch has commits ahead of `base` in this repo. */
    changed: boolean;
    /** The PR for this repo, or null when none has been opened. */
    pr?: PullRequest | null;
}

/**
 * Pipeline facts. Hand-written files may omit `verified_heads` and `reviewer`; the daemon
 * treats an absent field as empty and fills it in when it first writes the file.
 */
export interface Pipeline {
    verified_locally: boolean;
    /** Repo name to head SHA that the operator verified. */
    verified_heads?: Record<string, string>;
    /** When and by whom `spinner verify` recorded the tick. Absent until the first tick. */
    verified_at?: string;
    verified_by?: string;
    slack_post: string | null;
    reviewer?: string | null;
    /** When `spinner post` sent the message. Absent until then. */
    posted_at?: string;
    /** Repo name to head SHA the operator approved through `spinner approve`. */
    approved_heads?: Record<string, string>;
    /** Replies and reactions under the Slack post, as the daemon last polled them. */
    slack_activity?: SlackActivity;
}

/** What the daemon reads under the session's Slack post. Read-only; counts drive the board. */
export interface SlackActivity {
    replies: number;
    reactions: number;
    /** ISO 8601 time of the latest reply or reaction, or null when there is none. */
    last_activity: string | null;
    /** ISO 8601 time of the poll that produced these counts. */
    polled_at: string;
}

/** Stack state, as the daemon observes it. `none` means the session has no stack. */
export type StackStateName = "none" | "up" | "down" | "starting" | "failed";

export interface StackState {
    /** Docker compose project name, for example `spinner-s17`. */
    project?: string;
    state: StackStateName;
    /** Service name to hostname, for example `admin` to `admin.s17.localhost`. */
    hosts?: Record<string, string>;
    /** Database name cloned from the seed template. */
    db?: string;
    /**
     * The clone belongs to a previous round: `reset` ran while the stack was down and did not
     * touch the server. The next `up` drops it before it clones.
     */
    db_stale?: boolean;
    /** Services with `runtime: host`, by name: the process Spinner started for them. */
    processes?: Record<string, HostProcess>;
    /** The last `up`, `down` or `reset` job, so an agent can see why a stack failed. */
    last_job?: StackLastJob;
}

/** How the last stack job ended. Written by the daemon when the job finishes. */
export interface StackLastJob {
    action: "up" | "down" | "reset";
    state: "ok" | "failed";
    /** The error message of a failed job, else null. */
    error: string | null;
    /** ISO 8601 time the job finished. */
    finished: string;
    /** The last `STACK_JOB_TAIL_LINES` lines of the job's log. */
    tail: string[];
}

export const STACK_JOB_TAIL_LINES = 40;

/** A `runtime: host` service's process, as `spinner up` started it. */
export interface HostProcess {
    pid: number;
    /**
     * The process start time as `ps` prints it. A pid is reused once its process exits; the
     * start time tells Spinner's process from a stranger that inherited the number.
     */
    started?: string;
    /** The port the service listens on; the proxy routes its hostname here. */
    port: number;
    /** Log file, relative to the session directory. */
    log: string;
}

export type AgentProcessState = "running" | "idle" | "exited";

/**
 * How an agent's pi runs: `tty` is pi's own terminal UI in a pty, rendered by the agent tab
 * over `GET /sessions/:dir/agents/:name/tty`; `rpc` is `pi --mode rpc`, the headless path.
 * `pi` is the value files written before s009 carry; it reads as `rpc`.
 */
export type AgentHarnessName = "tty" | "rpc" | "pi";

/** One agent of a session: how it runs and whether its process is alive. */
export interface AgentSpec {
    harness: AgentHarnessName;
    model: string;
    process: AgentProcessState;
    pid?: number;
    /** The process start time as `ps -o lstart=` prints it, so a restart can tell a reused pid. */
    started?: string;
    /** Repo key of `repos` whose worktree is the agent's cwd; the session dir when absent. */
    repo?: string;
    /** Skill directories pi loads with `--skill`, beyond the session's `skills/` (s015). */
    skills?: string[];
}

/**
 * What a session is (s015). `review` is a place for a peer's PR: a detached worktree at the
 * PR head under `<home>/reviews/`, no project, no stack, and `review` as its one action.
 */
export type SessionKind = "session" | "review";

/**
 * A reviewer's state (s015, s016). `done`: its verdict is in `artifacts/reviews/` and its pi
 * is stopped. `failed`: it settled without a `VERDICT:` block, or exited.
 */
export type SwarmState = "queued" | "reading" | "done" | "failed";

/** One reviewer of the swarm (s015), as `session.yaml` records it under `review.swarm`. */
export interface SwarmRecord {
    /** `provider/model` the reviewer runs with. */
    model: string;
    state: SwarmState;
    /** Repo key of `repos` whose PR the reviewer reads. */
    pr: string;
    /** Why the reviewer is `failed` (s016): the start error, the last text, or the exit code. */
    error?: string;
}

/** The review swarm of a session (s015): the daemon writes it, `SessionView.review` reads it. */
export interface ReviewState {
    /** By agent name, `review-<model-slug>`. */
    swarm: Record<string, SwarmRecord>;
    /** True while `artifacts/review-draft.json` exists (s016); the tracker reads it. */
    draft?: boolean;
    /** The posted review's URL (s016), null until `post`. */
    posted_url?: string | null;
    /**
     * True after the operator's `cancel review` (dogfood #22), until the next start, draft,
     * approve or post. Absent means false.
     */
    cancelled?: boolean;
}

/** The whole of `session.yaml`. */
export interface Session {
    version: typeof SESSION_VERSION;
    /** `review` for a review session (s015); absent means an ordinary session. */
    kind?: SessionKind;
    /** Short id, for example `s17`. */
    id: string;
    /** URL-safe slug; the directory is `<id>-<slug>`. */
    slug: string;
    title: string;
    /**
     * True after the operator renamed the session (dogfood #27): the lead's `session_title`
     * is refused until the operator unpins it. Absent means false.
     */
    title_pinned?: boolean;
    /** Project name whose `spinner.yaml` configures the stack and the pipeline tracker. */
    project?: string;
    /** ISO 8601 date or timestamp. */
    created: string;
    stage: Stage;
    /** The single next action for the operator, or null. */
    needs_human: string | null;
    branch: string;
    base: string;
    /** Round number; 1 until the first `spinner reset`. Absent in files written before s005. */
    round?: number;
    repos: Record<string, SessionRepo>;
    pipeline?: Pipeline;
    stack: StackState;
    agents: Record<string, AgentSpec>;
    /** The diff viewers the daemon runs for this session (s012). Absent before the first start. */
    diff?: DiffState;
    /** The review swarm (s015). Absent until the first `review`. */
    review?: ReviewState;
    /** Absent means a session from before the EGM design. `SESSION_VERSION` stays 1. */
    design?: DesignState;
    /**
     * Earlier rounds, oldest first, appended by `reset` since the EGM design. Rounds before
     * that are only in `## Previous rounds` of MISSION.md.
     */
    rounds?: RoundRecord[];
    /** Absent in sessions created before EGM build session 6. */
    outcomes?: OutcomeCounts;
}

/**
 * The outcome counters (docs/designs/egm-adoption.md, 6.19 to 6.22): fixer rounds and the
 * operator's steers to the lead, counted per session across rounds.
 */
export interface OutcomeCounts {
    fix_rounds: number;
    operator_steers: number;
}

/** One PR of an earlier round. `merged_at` is the PR's `last_activity` when merged, else null. */
export interface RoundPr {
    repo: string;
    number: number;
    url: string | null;
    state: PrState;
    merged_at: string | null;
}

/** One earlier round of a session, as `reset` records it before it clears the PR facts. */
export interface RoundRecord {
    round: number;
    branch: string;
    prs: RoundPr[];
    /** ISO 8601 start and end of the round; null for a round read from MISSION.md. */
    started: string | null;
    ended: string | null;
}

/** `session.rounds` keeps at most this many records; past it the oldest drops. */
export const ROUNDS_MAX = 200;

/** One `diffview` process per repo, by repo key, while it runs. Reattached by pid identity. */
export interface DiffState {
    repos: Record<string, HostProcess>;
    /**
     * The unresolved comment threads of every running viewer, from the watcher's last
     * `diffview comments list --json`. The view counts them and the stage derivation turns
     * the ones waiting on the operator into `needs_human`.
     */
    threads?: DiffThreadRecord[];
}

/** One unresolved thread, as much of it as `needs_human` and the tab's badge need. */
export interface DiffThreadRecord {
    repo: string;
    thread: number;
    waiting_on: "agent" | "human";
    /** The file, or null for a thread on the whole branch or on a description. */
    path: string | null;
    start_line: number | null;
    end_line: number | null;
}

/** What the daemon reports about a session: the parsed file plus where it lives. */
export interface SessionSummary {
    /** Directory name under `~/.spinner/sessions`, for example `s17-refund-flow`. */
    dir: string;
    /** Absolute path of the session directory. */
    path: string;
    session: Session;
}
