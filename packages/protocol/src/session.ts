// Types for `session.yaml`, the machine state of one session. The daemon is the only writer;
// the CLI writes the initial file at `spinner new`. The shape follows
// docs/SESSION_PROTOCOL.md, section "session.yaml". The JSON schema in `schema/session.json`
// is generated from this file; run `pnpm --filter @spinner/protocol schema` after an edit.

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
    /** ISO 8601 timestamp of the last activity on the PR. */
    last_activity: string;
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
    slack_post: string | null;
    reviewer?: string | null;
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
}

export type AgentProcessState = "running" | "idle" | "exited";

/** One agent of a session: how it runs and whether its process is alive. */
export interface AgentSpec {
    harness: "pi";
    model: string;
    process: AgentProcessState;
    pid?: number;
}

/** The whole of `session.yaml`. */
export interface Session {
    version: typeof SESSION_VERSION;
    /** Short id, for example `s17`. */
    id: string;
    /** URL-safe slug; the directory is `<id>-<slug>`. */
    slug: string;
    title: string;
    /** ISO 8601 date or timestamp. */
    created: string;
    stage: Stage;
    /** The single next action for the operator, or null. */
    needs_human: string | null;
    branch: string;
    base: string;
    repos: Record<string, SessionRepo>;
    pipeline?: Pipeline;
    stack: StackState;
    agents: Record<string, AgentSpec>;
}

/** What the daemon reports about a session: the parsed file plus where it lives. */
export interface SessionSummary {
    /** Directory name under `~/.spinner/sessions`, for example `s17-refund-flow`. */
    dir: string;
    /** Absolute path of the session directory. */
    path: string;
    session: Session;
}
