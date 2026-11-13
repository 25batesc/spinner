// `spinner land <session>`: for every PR whose gates pass (checks green, no open threads, the
// configured approval check passed), enqueue it in the GitHub merge queue with
// `expectedHeadOid` so the commit the operator verified is the one that merges, then watch.
// On a pop-out the job rebases the session's worktree onto fresh `base`, pushes, waits for
// green checks and re-enqueues; a conflict stops the job with the conflicting paths. With
// `merge_queue: none` the PR is merged directly. Every write goes through `github_write`.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
    LandRequest,
    PipelineConfig,
    PrFacts,
    PullRequest,
    Session,
    SessionSummary,
} from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";
import { read_session, write_session } from "../store/session-store.js";
import {
    fetch_owner_login,
    fetch_pr_response,
    parse_pr_url,
    pr_facts_from_response,
    type GhRunner,
    type PrRef,
} from "./github.js";
import { github_write, type GithubWriter } from "./github-write.js";
import { append_log_line } from "./mission-sections.js";
import type { Notifier } from "./notify.js";
import { clock, repo_base } from "./pr.js";
import { with_flagged } from "./threads.js";
import { apply_pr_facts, refresh_session, session_prs } from "./tracker.js";

export interface LandDeps {
    gh: GhRunner;
    writer: GithubWriter;
    config: PipelineConfig;
    log?: (line: string) => void;
    now?: () => Date;
    notify?: Notifier;
    /** The wait between two looks at the queue; tests pass a no-op. */
    sleep?: (ms: number) => Promise<void>;
    poll_ms?: number;
    /** Upper bound on looks at the queue before the job gives up. */
    polls_max?: number;
}

/** 30 s between looks, 240 looks: two hours, which a busy queue can take. */
const POLL_MS_DEFAULT = 30_000;
const POLLS_MAX_DEFAULT = 240;

/** Rebases a popped PR at most this many times in one job; past that, something is wrong. */
const REBASES_MAX = 5;

const ENQUEUE_MUTATION =
    "mutation($id: ID!, $head: GitObjectID!) { enqueuePullRequest(input: " +
    "{pullRequestId: $id, expectedHeadOid: $head}) { mergeQueueEntry { id state } } }";

/** Pure: why a PR may not be enqueued now, or null when every gate passes. */
export function land_blocker(pr: PullRequest, config: PipelineConfig): string | null {
    if (pr.state !== "open") {
        return `PR is ${pr.state}`;
    }
    if (pr.queue === "queued" || pr.queue === "merging") {
        return "already in the queue";
    }
    if (pr.checks !== "green") {
        return `checks are ${pr.checks}`;
    }
    const open = pr.threads.bots_open + pr.threads.humans_open;
    if (open > 0) {
        return `${open} open thread${open === 1 ? "" : "s"}`;
    }
    if (config.github.approval_check !== undefined && pr.approval_check !== "pass") {
        return `${config.github.approval_check} is ${pr.approval_check}`;
    }
    return null;
}

export async function land_prs(
    home: SpinnerHome,
    summary: SessionSummary,
    input: LandRequest,
    deps: LandDeps,
): Promise<{ summary: SessionSummary; merged: string[] }> {
    const owner_login = deps.config.github.owner_login ?? (await fetch_owner_login(deps.gh));
    const context = { config: deps.config.github, owner_login };
    let session = await refresh_facts(summary.session, deps, context);
    const prs = session_prs(session).filter((pr) => input.pr === undefined || pr.repo === input.pr);
    if (input.pr !== undefined && prs.length === 0) {
        throw new Error(`no PR for repo "${input.pr}" in ${summary.dir}`);
    }
    const open = prs.filter((pr) => pr.state === "open");
    const blocked = open.map((pr) => ({ pr, why: land_blocker(pr, deps.config) }));
    for (const entry of blocked.filter((e) => e.why !== null)) {
        throw new Error(`${entry.pr.repo}#${entry.pr.number} cannot land: ${entry.why ?? ""}`);
    }
    if (open.length === 0) {
        throw new Error("no open PR to land");
    }
    const merged: string[] = [];
    for (const pr of open) {
        const ref = parse_pr_url(pr.url);
        assert.ok(ref !== null, `${pr.url} is not a GitHub PR URL`);
        session = await land_one(session, summary, pr, ref, deps, context);
        merged.push(`${pr.repo}#${pr.number}`);
    }
    const now = deps.now ?? (() => new Date());
    const refreshed = refresh_session(summary.session, session, deps.config, now());
    write_session({ ...summary, session: refreshed.session });
    const check = read_session(home, summary.dir);
    assert.ok(check.ok, "a landed session must read back");
    return { summary: check.summary, merged };
}

type FactsContext = { config: PipelineConfig["github"]; owner_login: string };

async function refresh_facts(
    session: Session,
    deps: LandDeps,
    context: FactsContext,
): Promise<Session> {
    let next = session;
    for (const pr of session_prs(session)) {
        if (pr.state !== "open" && pr.state !== "draft") {
            continue;
        }
        const ref = parse_pr_url(pr.url);
        assert.ok(ref !== null, `${pr.url} is not a GitHub PR URL`);
        const facts = pr_facts_from_response(await fetch_pr_response(deps.gh, ref), context);
        next = apply_pr_facts(next, pr.repo, with_flagged(facts, pr.threads.flagged ?? 0));
    }
    return next;
}

/** Enqueues (or merges) one PR and watches it to `merged`, rebasing on each pop-out. */
async function land_one(
    session: Session,
    summary: SessionSummary,
    pr: PrFacts,
    ref: PrRef,
    deps: LandDeps,
    context: FactsContext,
): Promise<Session> {
    const label = `${pr.repo}#${pr.number}`;
    const repo = `${ref.owner}/${ref.name}`;
    const allow = deps.config.github.write_repos;
    if (deps.config.github.merge_queue === "none") {
        deps.log?.(`${label}: no merge queue; merging ${pr.head.slice(0, 7)}`);
        await github_write(deps.writer, allow, repo, {
            kind: "gh",
            args: ["pr", "merge", pr.url, "--merge", "--match-head-commit", pr.head],
        });
    } else {
        await enqueue(pr, ref, deps);
    }
    let current = session;
    let rebases = 0;
    const polls_max = deps.polls_max ?? POLLS_MAX_DEFAULT;
    for (let poll = 0; poll < polls_max; poll += 1) {
        await (deps.sleep ?? sleep_ms)(deps.poll_ms ?? POLL_MS_DEFAULT);
        const facts = pr_facts_from_response(await fetch_pr_response(deps.gh, ref), context);
        current = apply_pr_facts(current, pr.repo, with_flagged(facts, pr.threads.flagged ?? 0));
        if (facts.state === "merged") {
            deps.log?.(`${label}: merged`);
            const text = `${summary.session.id}: ${label} merged`;
            await deps.notify?.("Spinner", text, summary.dir);
            log_line(summary, deps, `land: ${label} merged`);
            return current;
        }
        if (facts.queue === "popped") {
            rebases += 1;
            assert.ok(rebases <= REBASES_MAX, `${label} popped out ${rebases} times; giving up`);
            const why = facts.queue_reason ?? "unknown";
            deps.log?.(`${label}: popped out of the queue (${why}); rebasing`);
            const head = await rebase_and_push(summary, pr, repo, deps);
            await wait_green(ref, deps, context, label);
            await enqueue({ ...pr, head }, ref, deps);
        }
    }
    throw new Error(`${label}: still not merged after ${polls_max} looks at the queue`);
}

async function enqueue(pr: PullRequest, ref: PrRef, deps: LandDeps): Promise<void> {
    const repo = `${ref.owner}/${ref.name}`;
    const id_out = await deps.gh(["pr", "view", pr.url, "--json", "id", "--jq", ".id"]);
    const id = id_out.trim();
    assert.ok(id.length > 0, `gh pr view returned no node id for ${pr.url}`);
    deps.log?.(`${ref.name}#${pr.number}: enqueuing at ${pr.head.slice(0, 7)}`);
    await github_write(deps.writer, deps.config.github.write_repos, repo, {
        kind: "gh",
        args: [
            "api",
            "graphql",
            "-f",
            `query=${ENQUEUE_MUTATION}`,
            "-F",
            `id=${id}`,
            "-F",
            `head=${pr.head}`,
        ],
    });
}

/**
 * Rebases the session's worktree onto fresh base and pushes with `--force-with-lease`: the
 * one force push Spinner makes, on its own job, after a queue rejection. A dirty worktree or
 * a conflict stops the job; the operator decides.
 */
async function rebase_and_push(
    summary: SessionSummary,
    pr: PrFacts,
    repo: string,
    deps: LandDeps,
): Promise<string> {
    const entry = summary.session.repos[pr.repo];
    assert.ok(entry?.worktree !== undefined, `${pr.repo} has no worktree to rebase in`);
    const cwd = join(summary.path, entry.worktree);
    const git = deps.writer.git;
    // The worktree may be on another change's branch by now (the lead started or switched
    // one while this job watched the queue). A rebase there would rewrite the wrong branch.
    const branch = summary.session.branch;
    const checked_out = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (checked_out !== branch) {
        throw new Error(
            `${pr.repo}#${pr.number} popped out of the queue and needs a rebase, but the ` +
                `worktree is on ${checked_out}, not ${branch}; make this change the current ` +
                "one (the lead's `change switch`), then land again",
        );
    }
    const dirty = (await git(cwd, ["status", "--porcelain"])).trim();
    if (dirty.length > 0) {
        throw new Error(`${pr.repo}: worktree has uncommitted changes; rebase needs it clean`);
    }
    const base = repo_base(summary, pr.repo);
    await git(cwd, ["fetch", "origin", base]);
    try {
        await git(cwd, ["rebase", `origin/${base}`]);
    } catch (error) {
        const conflicts = (await git(cwd, ["diff", "--name-only", "--diff-filter=U"])).trim();
        await git(cwd, ["rebase", "--abort"]);
        const paths = conflicts.length > 0 ? conflicts.split("\n").join(", ") : "unknown paths";
        log_line(summary, deps, `land: ${pr.repo}#${pr.number} rebase conflict in ${paths}`);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${pr.repo}: rebase onto ${base} conflicts in ${paths} (${message})`);
    }
    const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    deps.log?.(`${pr.repo}: rebased onto ${base}, new head ${head.slice(0, 7)}; pushing`);
    await github_write(deps.writer, deps.config.github.write_repos, repo, {
        kind: "git_push",
        cwd,
        args: ["push", "--force-with-lease", "origin", summary.session.branch],
    });
    return head;
}

async function wait_green(
    ref: PrRef,
    deps: LandDeps,
    context: FactsContext,
    label: string,
): Promise<void> {
    const polls_max = deps.polls_max ?? POLLS_MAX_DEFAULT;
    for (let poll = 0; poll < polls_max; poll += 1) {
        const facts = pr_facts_from_response(await fetch_pr_response(deps.gh, ref), context);
        if (facts.checks === "green") {
            return;
        }
        if (facts.checks === "red") {
            throw new Error(`${label}: checks are red after the rebase`);
        }
        await (deps.sleep ?? sleep_ms)(deps.poll_ms ?? POLL_MS_DEFAULT);
    }
    throw new Error(`${label}: checks still pending after ${polls_max} looks`);
}

function sleep_ms(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function log_line(summary: SessionSummary, deps: LandDeps, text: string): void {
    const path = join(summary.path, "MISSION.md");
    if (!existsSync(path)) {
        return;
    }
    const now = (deps.now ?? (() => new Date()))();
    const mission = readFileSync(path, "utf8");
    writeFileSync(path, append_log_line(mission, clock(now), "spinner", text));
}
