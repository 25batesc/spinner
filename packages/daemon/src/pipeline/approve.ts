// `spinner approve <session>`: shows what the operator is about to approve (head SHA, diff
// stat, open-thread count) and submits their approving review with `gh pr review --approve`
// only on confirmation. The approval is recorded per head in `pipeline.approved_heads`, so
// after any push it is asked for again and never re-applied (s005 Contracts). GitHub refuses
// an author's approval, so a PR Spinner opened as the operator is never approvable here.
import assert from "node:assert/strict";
import type {
    ApprovePrView,
    ApproveRequest,
    ApproveView,
    DiffStat,
    PipelineConfig,
    PrFacts,
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
} from "./github.js";
import { github_write, type GithubWriter } from "./github-write.js";
import { apply_pr_facts, refresh_session, session_prs } from "./tracker.js";

export interface ApproveDeps {
    gh: GhRunner;
    writer: GithubWriter;
    config: PipelineConfig;
    log?: (line: string) => void;
    now?: () => Date;
}

/** The diff stat of one PR, from `gh pr view`. */
export async function fetch_diff_stat(gh: GhRunner, url: string): Promise<DiffStat> {
    const stdout = await gh(["pr", "view", url, "--json", "additions,deletions,changedFiles"]);
    const parsed = JSON.parse(stdout) as {
        additions: number;
        deletions: number;
        changedFiles: number;
    };
    return { files: parsed.changedFiles, additions: parsed.additions, deletions: parsed.deletions };
}

/** Pure: whether and why the operator may not approve this PR now. */
export function approve_blocker(pr: PrFacts, session: Session, owner_login: string): string | null {
    const approved_head = session.pipeline?.approved_heads?.[pr.repo];
    if (pr.state !== "open") {
        return `PR is ${pr.state}`;
    }
    if (pr.author === owner_login) {
        return "you are the author; GitHub does not accept an author's approval";
    }
    if (pr.approvals.owner || approved_head === pr.head) {
        return `already approved at ${pr.head.slice(0, 7)}`;
    }
    const open = pr.threads.bots_open + pr.threads.humans_open;
    if (open > 0) {
        return `${open} open thread${open === 1 ? "" : "s"}`;
    }
    if (pr.checks === "red") {
        return "checks are red";
    }
    return null;
}

/** What `approve` would submit, per PR, with the diff stat read from GitHub. */
export async function approve_view(
    summary: SessionSummary,
    deps: Pick<ApproveDeps, "gh" | "config">,
): Promise<ApproveView> {
    const owner_login = deps.config.github.owner_login ?? (await fetch_owner_login(deps.gh));
    const prs: ApprovePrView[] = [];
    for (const pr of session_prs(summary.session)) {
        const diff =
            pr.state === "open"
                ? await fetch_diff_stat(deps.gh, pr.url)
                : { files: 0, additions: 0, deletions: 0 };
        const approved_head = summary.session.pipeline?.approved_heads?.[pr.repo];
        prs.push({
            repo: pr.repo,
            number: pr.number,
            url: pr.url,
            title: pr.title ?? `${pr.repo}#${pr.number}`,
            state: pr.state,
            head: pr.head,
            diff,
            open_threads: pr.threads.bots_open + pr.threads.humans_open,
            approved: pr.approvals.owner || approved_head === pr.head,
            blocked: approve_blocker(pr, summary.session, owner_login),
        });
    }
    return { prs };
}

/** Submits the operator's approving review on every approvable PR, or on the named one. */
export async function approve_prs(
    home: SpinnerHome,
    summary: SessionSummary,
    input: ApproveRequest,
    deps: ApproveDeps,
): Promise<{ summary: SessionSummary; approved: string[] }> {
    assert.equal(input.confirm, true, "approve needs the operator's confirmation");
    const now = deps.now ?? (() => new Date());
    const owner_login = deps.config.github.owner_login ?? (await fetch_owner_login(deps.gh));
    const view = await approve_view(summary, { gh: deps.gh, config: deps.config });
    const wanted = view.prs.filter((pr) => input.pr === undefined || pr.repo === input.pr);
    if (input.pr !== undefined && wanted.length === 0) {
        throw new Error(`no PR for repo "${input.pr}" in ${summary.dir}`);
    }
    const approvable = wanted.filter((pr) => pr.blocked === null);
    if (approvable.length === 0) {
        const reasons = wanted.map((pr) => `${pr.repo}#${pr.number}: ${pr.blocked ?? "?"}`);
        throw new Error(`nothing to approve (${reasons.join("; ")})`);
    }
    let session: Session = summary.session;
    const approved: string[] = [];
    for (const pr of approvable) {
        const ref = parse_pr_url(pr.url);
        assert.ok(ref !== null, `${pr.url} is not a GitHub PR URL`);
        const repo = `${ref.owner}/${ref.name}`;
        const stat = `${pr.diff.files} files, +${pr.diff.additions} -${pr.diff.deletions}`;
        deps.log?.(`${pr.repo}#${pr.number} @ ${pr.head.slice(0, 7)} · ${stat} · 0 open threads`);
        await github_write(deps.writer, deps.config.github.write_repos, repo, {
            kind: "gh",
            args: ["pr", "review", pr.url, "--approve"],
        });
        deps.log?.(`${pr.repo}#${pr.number}: approved as ${owner_login}`);
        const pipeline = session.pipeline ?? { verified_locally: false, slack_post: null };
        session = {
            ...session,
            pipeline: {
                ...pipeline,
                approved_heads: { ...(pipeline.approved_heads ?? {}), [pr.repo]: pr.head },
            },
        };
        const response = await fetch_pr_response(deps.gh, ref);
        const facts = pr_facts_from_response(response, { config: deps.config.github, owner_login });
        session = apply_pr_facts(session, pr.repo, facts);
        approved.push(`${pr.repo}#${pr.number}`);
    }
    const refreshed = refresh_session(summary.session, session, deps.config, now());
    write_session({ ...summary, session: refreshed.session });
    const check = read_session(home, summary.dir);
    assert.ok(check.ok, "an approved session must read back");
    return { summary: check.summary, approved };
}
