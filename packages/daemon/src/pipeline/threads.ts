// Review threads per PR: rendered from the collector's GraphQL response into
// `threads/<repo>-<n>.md` (what the fixer reads) and `threads/<repo>-<n>.json` (the
// `PrThreadsView` the API serves, with the Spinner-local flags). Reply and resolve go to
// GitHub through `github_write`; flag is local. A thread is never resolved without a reply,
// and a human thread is never resolved while `threads.resolve_human` is off
// (docs/SESSION_PROTOCOL.md, "Threads").
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
    GithubConfig,
    PipelineConfig,
    PrThreadsView,
    PullRequest,
    Session,
    SessionSummary,
    ThreadComment,
    ThreadResponse,
    ThreadView,
    ThreadsView,
} from "@spinner/protocol";
import { THREADS_PER_PR_MAX } from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";
import { read_session, write_session } from "../store/session-store.js";
import {
    fetch_owner_login,
    fetch_pr_response,
    is_bot_login,
    parse_pr_url,
    pr_facts_from_response,
    type GhRunner,
    type PrResponse,
    type ThreadNode,
} from "./github.js";
import { github_write, type GithubWriter } from "./github-write.js";
import { apply_pr_facts, refresh_session, session_prs } from "./tracker.js";

export const THREADS_DIR = "threads";

export interface ThreadsContext {
    config: GithubConfig;
    owner_login: string;
}

/** What changed between two renders of one PR, by label; the `threads.updated` payload. */
export interface ThreadsDiff {
    repo: string;
    number: number;
    opened: string[];
    resolved: string[];
    flagged: string[];
    file: string;
}

/** Pure: one GraphQL response becomes the PR's view, keeping the flags of `previous`. */
export function threads_from_response(
    repo: string,
    response: PrResponse,
    context: ThreadsContext,
    previous: PrThreadsView | null,
): PrThreadsView {
    const node = response.data.repository.pullRequest;
    const facts = pr_facts_from_response(response, context);
    assert.ok(node.reviewThreads.nodes.length <= THREADS_PER_PR_MAX);
    const flags = new Map(
        (previous?.threads ?? [])
            .filter((thread) => thread.flagged !== null)
            .map((thread) => [thread.id, thread.flagged] as const),
    );
    const threads = node.reviewThreads.nodes.map((thread, index) =>
        thread_view(thread, index, context, flags.get(thread.id) ?? null),
    );
    const open = threads.filter((thread) => thread.state === "open");
    return {
        repo,
        number: node.number,
        url: node.url,
        head: node.headRefOid,
        checks: facts.checks,
        review: facts.review,
        open_bot: open.filter((thread) => thread.author_kind === "bot").length,
        open_human: open.filter((thread) => thread.author_kind === "human").length,
        resolved: threads.length - open.length,
        flagged: open.filter((thread) => thread.flagged !== null).length,
        threads: [...open, ...threads.filter((thread) => thread.state === "resolved")],
        file: thread_file(repo, node.number),
    };
}

function thread_view(
    node: ThreadNode,
    index: number,
    context: ThreadsContext,
    flagged: string | null,
): ThreadView {
    const [first, ...rest] = node.comments.nodes;
    const author = first?.author?.login ?? "ghost";
    const replies: ThreadComment[] = rest.map((comment) => ({
        id: comment.id,
        author: comment.author?.login ?? "ghost",
        body: comment.body,
        created: comment.createdAt,
    }));
    return {
        id: node.id,
        label: `T${index + 1}`,
        state: node.isResolved ? "resolved" : "open",
        outdated: node.isOutdated,
        author,
        author_kind: is_bot_login(author, context.config.bot_logins) ? "bot" : "human",
        path: node.path ?? null,
        line: node.line ?? null,
        body: first?.body ?? "",
        replies,
        replied: replies.some((reply) => reply.author === context.owner_login),
        flagged: node.isResolved ? null : flagged,
    };
}

export function thread_file(repo: string, number: number): string {
    return `${THREADS_DIR}/${repo}-${number}.md`;
}

/** The Markdown the fixer reads, in the shape docs/SESSION_PROTOCOL.md shows. */
export function render_threads_markdown(view: PrThreadsView, session_id: string): string {
    const open = view.threads.filter((thread) => thread.state === "open");
    const noun = open.length === 1 ? "thread" : "threads";
    const head = [
        `# ${view.repo} #${view.number} · ${open.length} open ${noun}`,
        `(${view.open_bot} bot, ${view.open_human} human)`,
        `· checks: ${view.checks} · review: ${view.review}`,
    ].join(" ");
    const lines = [head, ""];
    for (const thread of open) {
        lines.push(...render_thread(thread), "");
    }
    const resolved = view.threads.length - open.length;
    lines.push(`## Resolved (${resolved}) · collapsed · \`spinner threads ${session_id} --all\``);
    lines.push("");
    return lines.join("\n");
}

function render_thread(thread: ThreadView): string[] {
    const where = thread.path === null ? "(no file)" : `${thread.path}:${thread.line ?? "-"}`;
    const outdated = thread.outdated ? " · outdated" : "";
    const title = `${thread.label} · ${thread.state} · ${thread.author} · ${where}${outdated}`;
    const lines = [`## ${title}`];
    lines.push(`<!-- ${thread.id} -->`);
    lines.push(...quote(thread.body));
    for (const reply of thread.replies) {
        lines.push("", `> **${reply.author}** replied:`, ...quote(reply.body));
    }
    if (thread.flagged !== null) {
        lines.push("", `⚑ flagged: ${thread.flagged}`);
    }
    return lines;
}

function quote(body: string): string[] {
    return body.trimEnd().split("\n").map((line) => `> ${line}`);
}

/** Writes both files for one PR and reports what changed since the previous render. */
export function write_pr_threads(
    summary: SessionSummary,
    view: PrThreadsView,
    previous: PrThreadsView | null,
): ThreadsDiff {
    const dir = join(summary.path, THREADS_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(summary.path, view.file), render_threads_markdown(view, summary.session.id));
    writeFileSync(json_path(summary, view.repo, view.number), `${JSON.stringify(view, null, 2)}\n`);
    return diff_threads(view, previous);
}

function diff_threads(view: PrThreadsView, previous: PrThreadsView | null): ThreadsDiff {
    const before = new Map((previous?.threads ?? []).map((thread) => [thread.id, thread]));
    const diff: ThreadsDiff = {
        repo: view.repo,
        number: view.number,
        opened: [],
        resolved: [],
        flagged: [],
        file: view.file,
    };
    for (const thread of view.threads) {
        const old = before.get(thread.id);
        if (thread.state === "open" && old?.state !== "open") {
            diff.opened.push(thread.label);
        }
        if (thread.state === "resolved" && old !== undefined && old.state === "open") {
            diff.resolved.push(thread.label);
        }
        if (thread.flagged !== null && (old === undefined || old.flagged === null)) {
            diff.flagged.push(thread.label);
        }
    }
    return diff;
}

function json_path(summary: SessionSummary, repo: string, number: number): string {
    return join(summary.path, THREADS_DIR, `${repo}-${number}.json`);
}

export function read_pr_threads(
    summary: SessionSummary,
    repo: string,
    number: number,
): PrThreadsView | null {
    const path = json_path(summary, repo, number);
    if (!existsSync(path)) {
        return null;
    }
    return JSON.parse(readFileSync(path, "utf8")) as PrThreadsView;
}

/** The session's threads from the last render, one entry per PR in `session.yaml` order. */
export function read_threads(summary: SessionSummary): ThreadsView {
    const prs: PrThreadsView[] = [];
    let rendered: string | null = null;
    for (const pr of session_prs(summary.session)) {
        const view = read_pr_threads(summary, pr.repo, pr.number);
        if (view !== null) {
            prs.push(view);
        }
    }
    const dir = join(summary.path, THREADS_DIR);
    if (existsSync(dir) && readdirSync(dir).length > 0) {
        rendered = latest_mtime(dir);
    }
    return { session: summary.dir, prs, rendered };
}

function latest_mtime(dir: string): string | null {
    let latest = 0;
    for (const name of readdirSync(dir)) {
        latest = Math.max(latest, statSync(join(dir, name)).mtimeMs);
    }
    return latest === 0 ? null : new Date(latest).toISOString();
}

export interface ThreadsDeps {
    gh: GhRunner;
    writer: GithubWriter;
    config: PipelineConfig;
    log?: (line: string) => void;
    now?: () => Date;
}

export interface RefreshThreadsResult {
    summary: SessionSummary;
    view: ThreadsView;
    diffs: ThreadsDiff[];
}

/**
 * Re-renders `threads/` from GitHub for every open PR, applies the fresh facts (counts and
 * flags included) to `session.yaml` and re-derives the stage.
 */
export async function refresh_threads(
    home: SpinnerHome,
    summary: SessionSummary,
    deps: ThreadsDeps,
): Promise<RefreshThreadsResult> {
    const now = deps.now ?? (() => new Date());
    const owner_login = deps.config.github.owner_login ?? (await fetch_owner_login(deps.gh));
    const context: ThreadsContext = { config: deps.config.github, owner_login };
    let session: Session = summary.session;
    const diffs: ThreadsDiff[] = [];
    for (const pr of session_prs(session)) {
        if (pr.state === "merged" || pr.state === "closed") {
            continue;
        }
        const ref = parse_pr_url(pr.url);
        assert.ok(ref !== null, `${pr.repo}: PR URL ${pr.url} is not a GitHub URL`);
        const response = await fetch_pr_response(deps.gh, ref);
        const previous = read_pr_threads(summary, pr.repo, pr.number);
        const view = threads_from_response(pr.repo, response, context, previous);
        diffs.push(write_pr_threads(summary, view, previous));
        const facts = pr_facts_from_response(response, context);
        session = apply_pr_facts(session, pr.repo, with_flagged(facts, view.flagged));
        const open = view.open_bot + view.open_human;
        deps.log?.(`${view.file}: ${open} open, ${view.flagged} flagged`);
    }
    const refreshed = refresh_session(summary.session, session, deps.config, now());
    write_session({ ...summary, session: refreshed.session });
    const check = read_session(home, summary.dir);
    assert.ok(check.ok, "a refreshed session must read back");
    return { summary: check.summary, view: read_threads(check.summary), diffs };
}

export function with_flagged(facts: PullRequest, flagged: number): PullRequest {
    return { ...facts, threads: { ...facts.threads, flagged } };
}

/** Finds a thread by id or by label (`T3`, which needs `pr` when the session has several). */
export function find_thread(
    view: ThreadsView,
    thread: string,
    pr: string | undefined,
): { pr: PrThreadsView; thread: ThreadView } {
    const candidates = view.prs.filter((entry) => pr === undefined || entry.repo === pr);
    if (pr !== undefined && candidates.length === 0) {
        throw new Error(`no threads rendered for repo "${pr}"`);
    }
    const matches = [];
    for (const entry of candidates) {
        for (const candidate of entry.threads) {
            if (candidate.id === thread || candidate.label === thread) {
                matches.push({ pr: entry, thread: candidate });
            }
        }
    }
    if (matches.length === 0) {
        throw new Error(`no thread "${thread}"${pr === undefined ? "" : ` on ${pr}`}`);
    }
    if (matches.length > 1) {
        const repos = matches.map((match) => match.pr.repo).join(", ");
        throw new Error(`thread "${thread}" is ambiguous (${repos}); name the pr`);
    }
    const match = matches[0];
    assert.ok(match !== undefined);
    return match;
}

const REPLY_MUTATION =
    "mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: " +
    "{pullRequestReviewThreadId: $id, body: $body}) { comment { id } } }";

const RESOLVE_MUTATION =
    "mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) " +
    "{ thread { id isResolved } } }";

export interface ThreadActionInput {
    thread: string;
    pr?: string;
}

/** Replies as the operator, then re-renders the PR so `replied` is true. */
export async function reply_thread(
    home: SpinnerHome,
    summary: SessionSummary,
    input: ThreadActionInput & { text: string },
    deps: ThreadsDeps,
): Promise<ThreadResponse> {
    assert.ok(input.text.trim().length > 0, "a reply needs text");
    const found = find_thread(read_threads(summary), input.thread, input.pr);
    await github_write(deps.writer, deps.config.github.write_repos, repo_of(found.pr), {
        kind: "gh",
        args: [
            "api",
            "graphql",
            "-f",
            `query=${REPLY_MUTATION}`,
            "-F",
            `id=${found.thread.id}`,
            "-f",
            `body=${input.text}`,
        ],
    });
    deps.log?.(`${found.pr.repo}#${found.pr.number} ${found.thread.label}: replied`);
    return after_write(home, summary, found.pr.repo, found.thread.id, deps);
}

/** Resolves a replied-to thread; refuses otherwise, and refuses human threads when off. */
export async function resolve_thread(
    home: SpinnerHome,
    summary: SessionSummary,
    input: ThreadActionInput,
    deps: ThreadsDeps,
): Promise<ThreadResponse> {
    const found = find_thread(read_threads(summary), input.thread, input.pr);
    const label = `${found.pr.repo}#${found.pr.number} ${found.thread.label}`;
    if (found.thread.state === "resolved") {
        throw new Error(`${label} is already resolved`);
    }
    if (!found.thread.replied) {
        throw new Error(`${label} has no reply from you; reply before resolving`);
    }
    if (found.thread.author_kind === "human" && !deps.config.threads.resolve_human) {
        throw new Error(`${label} is a human thread and threads.resolve_human is off`);
    }
    await github_write(deps.writer, deps.config.github.write_repos, repo_of(found.pr), {
        kind: "gh",
        args: ["api", "graphql", "-f", `query=${RESOLVE_MUTATION}`, "-F", `id=${found.thread.id}`],
    });
    deps.log?.(`${label}: resolved`);
    return after_write(home, summary, found.pr.repo, found.thread.id, deps);
}

/** Marks a thread for the operator. Local only: the flag lives in the JSON beside the file. */
export function flag_thread(
    home: SpinnerHome,
    summary: SessionSummary,
    input: ThreadActionInput & { reason: string },
    deps: Pick<ThreadsDeps, "config" | "log" | "now">,
): ThreadResponse {
    assert.ok(input.reason.trim().length > 0, "a flag needs a reason");
    const found = find_thread(read_threads(summary), input.thread, input.pr);
    if (found.thread.state === "resolved") {
        throw new Error(`${found.pr.repo}#${found.pr.number} ${found.thread.label} is resolved`);
    }
    const threads = found.pr.threads.map((thread) =>
        thread.id === found.thread.id ? { ...thread, flagged: input.reason } : thread,
    );
    const flagged = threads.filter((t) => t.state === "open" && t.flagged !== null).length;
    const view: PrThreadsView = { ...found.pr, threads, flagged };
    write_pr_threads(summary, view, found.pr);
    const entry = summary.session.repos[found.pr.repo]?.pr;
    assert.ok(entry !== undefined && entry !== null, `${found.pr.repo} has no PR`);
    const session = apply_pr_facts(summary.session, found.pr.repo, with_flagged(entry, flagged));
    const now = deps.now ?? (() => new Date());
    const refreshed = refresh_session(summary.session, session, deps.config, now());
    write_session({ ...summary, session: refreshed.session });
    deps.log?.(`${found.pr.repo}#${found.pr.number} ${found.thread.label}: flagged`);
    const thread = threads.find((t) => t.id === found.thread.id);
    assert.ok(thread !== undefined);
    return { repo: found.pr.repo, number: found.pr.number, thread };
}

async function after_write(
    home: SpinnerHome,
    summary: SessionSummary,
    repo: string,
    id: string,
    deps: ThreadsDeps,
): Promise<ThreadResponse> {
    const refreshed = await refresh_threads(home, summary, deps);
    const pr = refreshed.view.prs.find((entry) => entry.repo === repo);
    const thread = pr?.threads.find((entry) => entry.id === id);
    assert.ok(pr !== undefined && thread !== undefined, `thread ${id} vanished after the write`);
    return { repo, number: pr.number, thread };
}

function repo_of(pr: PrThreadsView): string {
    const ref = parse_pr_url(pr.url);
    assert.ok(ref !== null, `${pr.url} is not a GitHub PR URL`);
    return `${ref.owner}/${ref.name}`;
}
