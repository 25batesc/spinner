// `spinner pr <session>`: for each repo whose branch has commits ahead of its base, push the
// branch and open one PR as the operator (`gh` login), with a body built from the mission's
// Goal, Done when and Log, or from the approved design doc's Overview and Goals. PR numbers
// go into `session.yaml` and the Log; the stage is re-derived at once, so the board shows
// bot-review without waiting for a poll. Every push and every `gh pr create` goes through
// `github_write`, which checks the allow-list first.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PipelineConfig, PrRequest, Session, SessionSummary } from "@spinner/protocol";
import { approved_doc_of, pr_body_from_design } from "../egm/pr-body.js";
import type { SpinnerHome } from "../home.js";
import { SESSION_SPEC } from "../stack/runner.js";
import { load_spec } from "../stack/spec.js";
import { read_session, write_session } from "../store/session-store.js";
import {
    fetch_owner_login,
    fetch_pr_response,
    parse_pr_url,
    pr_facts_from_response,
    type GhRunner,
} from "./github.js";
import { github_write, repo_of_checkout, type GithubWriter } from "./github-write.js";
import { append_log_line, pr_body_from_mission } from "./mission-sections.js";
import { threads_from_response, with_flagged, write_pr_threads } from "./threads.js";
import { apply_pr_facts, refresh_session } from "./tracker.js";
import { empty_autopilot } from "./autopilot.js";
import { current_change, FIRST_CHANGE_ID, stacked_base } from "./changes.js";

export type Log = (line: string) => void;

export interface PrDeps {
    /** Read-only `gh`, for the facts after the PR exists. */
    gh: GhRunner;
    writer: GithubWriter;
    config: PipelineConfig;
    log: Log;
    now?: () => Date;
}

export interface PrOutcome {
    repo: string;
    /** `opened`, `pushed` (a PR existed; only the push ran) or `unchanged` (nothing ahead). */
    outcome: "opened" | "pushed" | "unchanged";
    url: string | null;
}

export async function open_prs(
    home: SpinnerHome,
    summary: SessionSummary,
    input: PrRequest,
    deps: PrDeps,
): Promise<{ summary: SessionSummary; outcomes: PrOutcome[] }> {
    const now = deps.now ?? (() => new Date());
    const wanted = input.repos;
    assert.ok(wanted === undefined || wanted.length > 0, "repos must name at least one repo");
    let session: Session = summary.session;
    const outcomes: PrOutcome[] = [];
    let owner_login: string | null = null;
    for (const [repo, entry] of Object.entries(session.repos)) {
        if (wanted !== undefined && !wanted.includes(repo)) {
            continue;
        }
        if (entry.worktree === undefined) {
            continue;
        }
        const worktree = join(summary.path, entry.worktree);
        if (!existsSync(worktree)) {
            deps.log(`${repo}: worktree ${entry.worktree} is missing; skipped`);
            continue;
        }
        // A change started on another opens against that change's branch while its pull
        // request is open (2.3); the commits are counted against the same base.
        const base = stacked_base(session, repo) ?? repo_base(summary, repo);
        const ahead = await commits_ahead(deps.writer, worktree, base);
        if (ahead === 0 && (entry.pr === undefined || entry.pr === null)) {
            deps.log(`${repo}: no commits ahead of ${base}; no PR`);
            outcomes.push({ repo, outcome: "unchanged", url: null });
            continue;
        }
        const full_name = await repo_of_checkout(deps.writer.git, worktree);
        const allow = deps.config.github.write_repos;
        deps.log(`${repo}: ${ahead} commit(s) ahead of ${base}; pushing ${session.branch}`);
        await github_write(deps.writer, allow, full_name, {
            kind: "git_push",
            cwd: worktree,
            args: ["push", "--set-upstream", "origin", session.branch],
        });
        if (entry.pr !== undefined && entry.pr !== null) {
            deps.log(`${repo}: PR #${entry.pr.number} exists; pushed only`);
            outcomes.push({ repo, outcome: "pushed", url: entry.pr.url });
            continue;
        }
        const body = write_pr_body(summary, repo, input.body);
        const title = pr_title(session, repo);
        const args = ["pr", "create", "--repo", full_name, "--base", base];
        args.push("--head", session.branch, "--title", title, "--body-file", body);
        if (input.draft === true) {
            args.push("--draft");
        }
        const stdout = await github_write(deps.writer, allow, full_name, { kind: "gh", args });
        const url = pr_url_from_output(stdout);
        deps.log(`${repo}: opened ${url}`);
        owner_login ??= deps.config.github.owner_login ?? (await fetch_owner_login(deps.gh));
        const ref = parse_pr_url(url);
        assert.ok(ref !== null, `gh pr create printed no PR URL: ${stdout.trim()}`);
        const response = await fetch_pr_response(deps.gh, ref);
        const context = { config: deps.config.github, owner_login };
        const facts = pr_facts_from_response(response, context);
        // The first `threads/` render comes from the same response, so the fixer and the UI
        // see the PR's threads before the first poll.
        const view = threads_from_response(repo, response, context, null);
        write_pr_threads(summary, view, null);
        session = apply_pr_facts(session, repo, with_flagged(facts, view.flagged));
        outcomes.push({ repo, outcome: "opened", url });
    }
    const refreshed = refresh_session(summary.session, session, deps.config, now());
    // A pull request opened here starts with an empty autopilot state, so its first failed
    // check and its first review threads are told to the lead (talk-change-ship.md, 1.5).
    const pipeline = refreshed.session.pipeline;
    const opened = outcomes.some((outcome) => outcome.outcome === "opened");
    if (opened && pipeline !== undefined && pipeline.autopilot === undefined) {
        pipeline.autopilot = empty_autopilot();
    }
    write_session({ ...summary, session: refreshed.session });
    log_opened(summary, outcomes, now());
    const check = read_session(home, summary.dir);
    assert.ok(check.ok, "a session with PRs must read back");
    return { summary: check.summary, outcomes };
}

/** The repo's base from the session's spec copy, or the session's base. */
export function repo_base(summary: SessionSummary, repo: string): string {
    const spec_path = join(summary.path, SESSION_SPEC);
    if (existsSync(spec_path)) {
        const base = load_spec(spec_path).spec.repos[repo]?.base;
        if (base !== undefined) {
            return base;
        }
    }
    return summary.session.base;
}

/** Commits on HEAD that `origin/<base>` (or `<base>`) does not have. */
async function commits_ahead(writer: GithubWriter, cwd: string, base: string): Promise<number> {
    const remote = `origin/${base}`;
    let range = `${remote}..HEAD`;
    try {
        await writer.git(cwd, ["rev-parse", "--verify", "--quiet", remote]);
    } catch {
        range = `${base}..HEAD`;
    }
    const out = await writer.git(cwd, ["rev-list", "--count", range]);
    const count = Number.parseInt(out.trim(), 10);
    assert.ok(Number.isInteger(count) && count >= 0, `rev-list printed "${out.trim()}"`);
    return count;
}

/**
 * Writes `artifacts/pr-<repo>.md` and returns its path. The body is the one given (the
 * lead's description of the change, 2.4); without one it comes from the approved
 * design doc in the designs repo's worktree (6.9), else from the mission. A doc that is
 * missing from the worktree falls back to the mission, so the PR never opens without a body.
 */
function write_pr_body(summary: SessionSummary, repo: string, given: string | undefined): string {
    const doc = approved_doc_of(summary);
    const change = current_change(summary.session);
    let body: string;
    if (given !== undefined && given.trim().length > 0) {
        body = `${given.trim()}\n\n_Opened by Spinner from session ${summary.session.id}._\n`;
    } else if (change.id !== FIRST_CHANGE_ID) {
        // The mission's Goal is the first change's; a later change without a description
        // says only what it is.
        body = `${change.title}\n\n_Opened by Spinner from session ${summary.session.id}._\n`;
    } else if (doc !== null && existsSync(doc.absolute)) {
        const text = readFileSync(doc.absolute, "utf8");
        body = pr_body_from_design(text, doc.path, summary.session.id);
    } else {
        const mission_path = join(summary.path, "MISSION.md");
        const mission = existsSync(mission_path) ? readFileSync(mission_path, "utf8") : "";
        body = pr_body_from_mission(mission, summary.session.id);
    }
    const dir = join(summary.path, "artifacts");
    mkdirSync(dir, { recursive: true });
    const name = change.id === FIRST_CHANGE_ID ? `pr-${repo}.md` : `pr-${change.id}-${repo}.md`;
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
}

function pr_title(session: Session, repo: string): string {
    const repos = Object.values(session.repos).filter((entry) => entry.worktree !== undefined);
    const suffix = repos.length > 1 ? ` (${repo})` : "";
    return `${current_change(session).title}${suffix}`;
}

/** `gh pr create` prints the PR URL as its last line. */
export function pr_url_from_output(stdout: string): string {
    const lines = stdout.trim().split("\n");
    const last = lines[lines.length - 1]?.trim() ?? "";
    assert.ok(parse_pr_url(last) !== null, `expected a PR URL, got "${last}"`);
    return last;
}

function log_opened(summary: SessionSummary, outcomes: PrOutcome[], now: Date): void {
    const opened = outcomes.filter((entry) => entry.outcome === "opened");
    if (opened.length === 0) {
        return;
    }
    const mission_path = join(summary.path, "MISSION.md");
    if (!existsSync(mission_path)) {
        return;
    }
    const text = opened.map((entry) => `${entry.repo} ${entry.url ?? ""}`).join(", ");
    const mission = readFileSync(mission_path, "utf8");
    writeFileSync(mission_path, append_log_line(mission, clock(now), "spinner", `pr: ${text}`));
}

/** `HH:MM` local time, the Log's format. */
export function clock(now: Date): string {
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
}
