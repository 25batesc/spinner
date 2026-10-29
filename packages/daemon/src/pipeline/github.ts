// Collects the per-PR facts of docs/ARCHITECTURE.md, section "Pipeline tracker", from one
// `gh api graphql` call per PR (the query is `test/fixtures/github/pr-facts.graphql`). The
// network call is behind a `GhRunner` so tests feed saved responses through the same code.
// `pr_facts_from_response` is pure: response plus configuration in, `PullRequest` out.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
    ApprovalCheckState,
    CheckState,
    GithubConfig,
    PrState,
    PullRequest,
    QueueState,
    ReviewDecision,
} from "@spinner/protocol";

/** Runs `gh` with the given arguments and resolves with its stdout. */
export type GhRunner = (args: string[]) => Promise<string>;

const exec_file = promisify(execFile);

/** Upper bound on bytes `gh` may print for one query; a PR with 100 threads is far below. */
const GH_OUTPUT_BYTES_MAX = 16 * 1024 * 1024;

export const gh_runner: GhRunner = async (args) => {
    assert.ok(args.length > 0, "gh needs arguments");
    assert.ok(!is_write_call(args), `refusing gh write call: ${args.join(" ")}`);
    const { stdout } = await exec_file("gh", args, { maxBuffer: GH_OUTPUT_BYTES_MAX });
    return stdout;
};

/** The board is read-only; every `gh` call goes through this guard. */
export function is_write_call(args: string[]): boolean {
    const [command, sub] = args;
    if (command === "pr" && sub !== "view" && sub !== "list" && sub !== "checks") {
        return true;
    }
    const method_index = args.findIndex((arg) => arg === "-X" || arg === "--method");
    if (method_index >= 0 && args[method_index + 1] !== "GET") {
        return true;
    }
    return args.some((arg) => /^query=\s*mutation\b/.test(arg) || /^\s*mutation\b/.test(arg));
}

const here = dirname(fileURLToPath(import.meta.url));
const QUERY_PATH = resolve(here, "..", "..", "test", "fixtures", "github", "pr-facts.graphql");

/** The query text, read once. It is kept next to the fixtures it produced. */
export const PR_FACTS_QUERY = readFileSync(QUERY_PATH, "utf8");

export interface PrRef {
    owner: string;
    name: string;
    number: number;
}

/** Parses `https://github.com/<owner>/<name>/pull/<n>`; null for anything else. */
export function parse_pr_url(url: string): PrRef | null {
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.trim());
    if (match === null) {
        return null;
    }
    const [, owner, name, number_text] = match;
    assert.ok(owner !== undefined && name !== undefined && number_text !== undefined);
    return { owner, name, number: Number.parseInt(number_text, 10) };
}

/** Fetches the raw GraphQL response for one PR. */
export async function fetch_pr_response(gh: GhRunner, ref: PrRef): Promise<PrResponse> {
    assert.ok(ref.number > 0, "PR number must be positive");
    const stdout = await gh([
        "api",
        "graphql",
        "-F",
        `owner=${ref.owner}`,
        "-F",
        `name=${ref.name}`,
        "-F",
        `number=${ref.number}`,
        "-f",
        `query=${PR_FACTS_QUERY}`,
    ]);
    const parsed = JSON.parse(stdout) as PrResponse;
    const node = parsed.data?.repository?.pullRequest;
    assert.ok(node, `no pullRequest in gh output for #${ref.number}`);
    return parsed;
}

/** The operator's login, which `approvals.owner` is measured against. */
export async function fetch_owner_login(gh: GhRunner): Promise<string> {
    const stdout = await gh(["api", "user", "--jq", ".login"]);
    const login = stdout.trim();
    assert.ok(login.length > 0, "gh api user returned no login");
    return login;
}

// The subset of the GraphQL response the collector reads. Fields the query returns but the
// collector ignores (titles, URLs of checks) are left out on purpose.
export interface PrResponse {
    data: {
        repository: {
            pullRequest: PrNode;
        };
    };
}

export interface PrNode {
    number: number;
    url: string;
    title: string;
    isDraft: boolean;
    state: "OPEN" | "MERGED" | "CLOSED";
    reviewDecision: "REVIEW_REQUIRED" | "CHANGES_REQUESTED" | "APPROVED" | null;
    author: { login: string } | null;
    baseRefName: string;
    headRefName: string;
    headRefOid: string;
    updatedAt: string;
    mergeQueueEntry: { state: string; position: number | null } | null;
    commits: { nodes: { commit: { oid: string; statusCheckRollup: Rollup | null } }[] };
    reviews: { nodes: ReviewNode[] };
    reviewThreads: { totalCount: number; nodes: ThreadNode[] };
    timelineItems: { nodes: TimelineNode[] };
}

interface Rollup {
    state: string;
    contexts: { nodes: CheckNode[] };
}

type CheckNode =
    | { __typename: "CheckRun"; name: string; status: string; conclusion: string | null }
    | { __typename: "StatusContext"; context: string; state: string };

interface ReviewNode {
    author: { login: string } | null;
    state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
    submittedAt: string;
    commit: { oid: string } | null;
}

export interface ThreadCommentNode {
    id: string;
    author: { login: string } | null;
    body: string;
    createdAt: string;
}

export interface ThreadNode {
    id: string;
    isResolved: boolean;
    isOutdated: boolean;
    /** Absent in fixtures saved before s005; the renderer treats both as "no location". */
    path?: string | null;
    line?: number | null;
    comments: { nodes: ThreadCommentNode[] };
}

type TimelineNode =
    | { __typename: "AddedToMergeQueueEvent"; createdAt: string }
    | {
          __typename: "RemovedFromMergeQueueEvent";
          createdAt: string;
          reason: string | null;
          beforeCommit: { oid: string } | null;
      }
    | { __typename: "MergedEvent"; createdAt: string }
    | { __typename: "ReviewRequestedEvent"; createdAt: string };

/** A login matches a configured bot in either its REST (`x[bot]`) or GraphQL (`x`) form. */
export function is_bot_login(login: string, bot_logins: readonly string[]): boolean {
    const bare = login.replace(/\[bot\]$/, "");
    return bot_logins.some((bot) => bot.replace(/\[bot\]$/, "") === bare);
}

export interface FactsContext {
    config: GithubConfig;
    owner_login: string;
}

/** Pure: one GraphQL response plus the configuration becomes the `pr:` block of a repo. */
export function pr_facts_from_response(response: PrResponse, context: FactsContext): PullRequest {
    const node = response.data.repository.pullRequest;
    assert.ok(node.number > 0);
    assert.ok(node.headRefOid.length >= 7, "head SHA must be a full or short SHA");
    const author = node.author?.login ?? "ghost";
    const author_is_bot = is_bot_login(author, context.config.bot_logins);
    const rollup = node.commits.nodes[0]?.commit.statusCheckRollup ?? null;
    const checks = split_checks(rollup, context.config.approval_check);
    const approvals = collect_approvals(node, context);
    const queue = derive_queue(node);
    return {
        number: node.number,
        url: node.url,
        author,
        state: derive_state(node),
        head: node.headRefOid,
        checks: checks.rollup,
        approval_check: checks.approval,
        approvals: {
            required: author_is_bot
                ? [...context.config.approval_policy.bot_author]
                : [...context.config.approval_policy.human_author],
            ...approvals,
        },
        threads: bucket_threads(node.reviewThreads.nodes, context.config.bot_logins),
        review: derive_review(node.reviewDecision),
        bot_reviewed_head: bot_reviewed_head(node.reviews.nodes, context.config.bot_logins),
        queue: queue.state,
        queue_reason: queue.reason,
        last_activity: node.updatedAt,
        // The Slack post and the approval dialog show the title; without it here, the first
        // poll after `pr` dropped the title `pr` had set (live loop, s007).
        title: node.title,
    };
}

function derive_state(node: PrNode): PrState {
    if (node.state === "MERGED") {
        return "merged";
    }
    if (node.state === "CLOSED") {
        return "closed";
    }
    return node.isDraft ? "draft" : "open";
}

function derive_review(decision: PrNode["reviewDecision"]): ReviewDecision {
    if (decision === "APPROVED") {
        return "approved";
    }
    if (decision === "CHANGES_REQUESTED") {
        return "changes_requested";
    }
    return "none";
}

interface SplitChecks {
    rollup: CheckState;
    approval: ApprovalCheckState;
}

/**
 * Rolls up every check except the approval check. A re-run adds a second node with the same
 * name, so the last node per name is the one that counts. A rollup with no checks is green:
 * a repo without CI has nothing to wait for.
 */
function split_checks(rollup: Rollup | null, approval_name: string | undefined): SplitChecks {
    const latest = new Map<string, CheckState>();
    let approval: ApprovalCheckState = "pending";
    const approval_key = approval_name?.toLowerCase();
    for (const node of rollup?.contexts.nodes ?? []) {
        const name = node.__typename === "CheckRun" ? node.name : node.context;
        const state = check_state(node);
        if (approval_key !== undefined && name.toLowerCase() === approval_key) {
            approval = state === "green" ? "pass" : state === "red" ? "fail" : "pending";
        } else {
            latest.set(name, state);
        }
    }
    const states = [...latest.values()];
    if (states.includes("red")) {
        return { rollup: "red", approval };
    }
    if (states.includes("pending")) {
        return { rollup: "pending", approval };
    }
    return { rollup: "green", approval };
}

function check_state(node: CheckNode): CheckState {
    if (node.__typename === "StatusContext") {
        return status_state(node.state);
    }
    if (node.status !== "COMPLETED") {
        return "pending";
    }
    const passed = ["SUCCESS", "SKIPPED", "NEUTRAL"];
    return node.conclusion !== null && passed.includes(node.conclusion) ? "green" : "red";
}

function status_state(state: string): CheckState {
    if (state === "SUCCESS") {
        return "green";
    }
    if (state === "PENDING" || state === "EXPECTED") {
        return "pending";
    }
    return "red";
}

/** Approvals count on the current head only, so a push asks for them again. */
function collect_approvals(
    node: PrNode,
    context: FactsContext,
): { peer: string[]; owner: boolean } {
    const peer: string[] = [];
    let owner = false;
    for (const review of node.reviews.nodes) {
        if (review.state !== "APPROVED" || review.commit?.oid !== node.headRefOid) {
            continue;
        }
        const login = review.author?.login ?? "ghost";
        if (login === context.owner_login) {
            owner = true;
        } else if (!peer.includes(login)) {
            peer.push(login);
        }
    }
    return { peer, owner };
}

/** A thread belongs to whoever wrote its first comment. */
export function bucket_threads(
    threads: readonly ThreadNode[],
    bot_logins: readonly string[],
): PullRequest["threads"] {
    const counts = { bots_open: 0, humans_open: 0, resolved: 0 };
    for (const thread of threads) {
        if (thread.isResolved) {
            counts.resolved += 1;
            continue;
        }
        const first = thread.comments.nodes[0]?.author?.login ?? "ghost";
        if (is_bot_login(first, bot_logins)) {
            counts.bots_open += 1;
        } else {
            counts.humans_open += 1;
        }
    }
    return counts;
}

/** The head SHA of the latest review a configured bot submitted, or null. */
function bot_reviewed_head(
    reviews: readonly ReviewNode[],
    bot_logins: readonly string[],
): string | null {
    let latest: ReviewNode | null = null;
    for (const review of reviews) {
        const login = review.author?.login ?? "ghost";
        if (!is_bot_login(login, bot_logins)) {
            continue;
        }
        if (latest === null || review.submittedAt > latest.submittedAt) {
            latest = review;
        }
    }
    return latest?.commit?.oid ?? null;
}

interface QueueFacts {
    state: QueueState;
    reason: string | null;
}

/**
 * `mergeQueueEntry` is present while queued. After a removal, the PR is `popped` only while
 * the head is still the one the queue rejected: a push after the pop-out puts the PR back on
 * the normal path, and `merged` is a removal reason too, not a pop-out.
 */
function derive_queue(node: PrNode): QueueFacts {
    if (node.mergeQueueEntry !== null) {
        const state = node.mergeQueueEntry.state === "LOCKED" ? "merging" : "queued";
        return { state, reason: null };
    }
    if (node.state !== "OPEN") {
        return { state: "none", reason: null };
    }
    const events = node.timelineItems.nodes.filter(
        (item) =>
            item.__typename === "AddedToMergeQueueEvent" ||
            item.__typename === "RemovedFromMergeQueueEvent",
    );
    const last = events[events.length - 1];
    if (last === undefined || last.__typename !== "RemovedFromMergeQueueEvent") {
        return { state: "none", reason: null };
    }
    if (last.reason === "merged" || last.beforeCommit?.oid !== node.headRefOid) {
        return { state: "none", reason: null };
    }
    return { state: "popped", reason: last.reason ?? "unknown" };
}
