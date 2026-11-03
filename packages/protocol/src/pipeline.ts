// Types for the pipeline tracker: its configuration (the `pipeline:` block of `spinner.yaml`),
// the facts the daemon collects, and the result of the stage derivation. The shapes follow
// docs/ARCHITECTURE.md, section "Pipeline tracker", and the stage table in
// docs/SESSION_PROTOCOL.md. Nothing here is specific to one team: defaults describe a plain
// GitHub repo with no bots, no approval check and no merge queue.

import type { DesignStage } from "./egm.js";
import type { ApprovalRole, DiffThreadRecord, Pipeline, PullRequest, Stage } from "./session.js";

/** Who must approve, by PR author kind. Spinner-opened PRs fall under `human_author`. */
export interface ApprovalPolicy {
    human_author: ApprovalRole[];
    bot_author: ApprovalRole[];
}

export type MergeQueueKind = "github" | "none";

export interface GithubConfig {
    /** GitHub organisation every repo of the project belongs to. Informational in M1. */
    org?: string;
    /**
     * Logins that bucket a review thread as a bot thread. Both `name[bot]` (REST) and `name`
     * (GraphQL `author.login`) forms match. Empty means there is no bot-review stage.
     */
    bot_logins: string[];
    /** Name of the check that encodes the approval policy. Absent means no such check. */
    approval_check?: string;
    approval_policy: ApprovalPolicy;
    /** The operator's login. Read from `gh api user` at runtime when absent. */
    owner_login?: string;
    /**
     * Repositories Spinner may write to (`owner/name`): push, open a PR, reply, resolve,
     * approve, enqueue, merge. Every GitHub write checks this list first and refuses a repo
     * that is not on it. Empty by default, so a fresh install can only read.
     */
    write_repos: string[];
    merge_queue: MergeQueueKind;
    poll_seconds: number;
}

export type ThreadsAutofix = "all" | "bots" | "off";

export interface ThreadsConfig {
    autofix: ThreadsAutofix;
    resolve_human: boolean;
    /** Hours without reviewer activity after which a peer-review session is `stale`. */
    stale_after_hours: number;
}

export interface SlackConfig {
    channel?: string;
    post: "confirm" | "never";
}

/** The `pipeline:` block of `spinner.yaml`, with every field filled from the defaults. */
export interface PipelineConfig {
    github: GithubConfig;
    threads: ThreadsConfig;
    slack: SlackConfig;
}

export const PIPELINE_CONFIG_DEFAULTS: PipelineConfig = {
    github: {
        bot_logins: [],
        approval_policy: { human_author: ["peer"], bot_author: ["peer", "owner"] },
        write_repos: [],
        merge_queue: "none",
        poll_seconds: 60,
    },
    threads: { autofix: "off", resolve_human: false, stale_after_hours: 3 },
    slack: { post: "confirm" },
};

/** Facts about one PR, as stored in `session.yaml`, plus the repo key they belong to. */
export interface PrFacts extends PullRequest {
    repo: string;
}

/**
 * Everything the stage derivation needs. The collector builds it from `session.yaml` and
 * the configuration; the derivation never reads anything else, so a fixture is a full input.
 */
export interface PipelineFacts {
    /** ISO 8601 timestamp of the derivation, for the stale check. */
    now: string;
    /** True when any repo has commits ahead of `base`. */
    has_commits: boolean;
    /** True once `spinner close` archived the session. */
    closed: boolean;
    prs: PrFacts[];
    pipeline: Pipeline;
    /** True when `github.bot_logins` is non-empty: a bot review is expected before fixing. */
    bots_expected: boolean;
    stale_after_hours: number;
    /**
     * Diff comment threads waiting on the operator (s012), oldest first. When nothing in the
     * pipeline needs the operator, the first one becomes `needs_human`.
     */
    diff_waiting?: DiffThreadRecord[];
    /**
     * True while the review lead's draft waits in `artifacts/review-draft.json` (s016). It
     * wins over the pipeline's own `needs_human`: the operator posts or drops it first.
     */
    review_draft?: boolean;
    /**
     * The design facts (docs/designs/egm-adoption.md, T7), present only for the `design`
     * track once the tracker derived a stage. `needs` is the design stage's `needs_human`.
     */
    design?: { stage: DesignStage; needs: string | null };
}

/** The single next action for the operator, or null when nothing waits on them. */
export type NeedsHuman = string | null;

export interface StageResult {
    stage: Stage;
    needs_human: NeedsHuman;
    /** True in peer-review when no reviewer activity happened for `stale_after_hours`. */
    stale: boolean;
}
