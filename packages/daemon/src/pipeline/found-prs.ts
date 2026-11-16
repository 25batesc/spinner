// Pull requests an agent opened outside a change (dogfood #72). A lead that makes a worktree
// of its own under the session and runs `gh pr create` there leaves a pull request that no
// change holds, so no list showed it and nothing polled it. Each poll round therefore asks
// GitHub, once per repository, for the operator's open pull requests. One that no session
// holds belongs to the session whose worktrees had its head branch checked out, now or
// before: git keeps that in each worktree's reflog. It is recorded into the change on that
// branch when there is one without a pull request, else as a change of its own. The poll of
// the same round then reads its facts as it does for any change.
//
// The cost is bounded: one `gh pr list` per repository at most every `FOUND_RECHECK_MS`, at
// most `FOUND_LOOKUPS_PER_ROUND_MAX` per round, and no git call unless GitHub lists a pull
// request that no session holds.
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { PipelineConfig, SessionSummary } from "@spinner/protocol";
import { origin_repo, worktree_branches } from "../git/worktree.js";
import type { SpinnerHome } from "../home.js";
import { run_ok } from "../stack/shell.js";
import { focus_summary, read_session, write_session } from "../store/session-store.js";
import { add_found_change, change_on_branch, next_change_id, tracked_numbers } from "./changes.js";
import {
    fetch_pr_response,
    parse_pr_url,
    pr_facts_from_response,
    type GhRunner,
} from "./github.js";
import { append_log_line } from "./mission-sections.js";
import { clock } from "./pr.js";
import { apply_pr_facts, refresh_session } from "./tracker.js";

/** A repository is asked about again after this long. */
export const FOUND_RECHECK_MS = 2 * 60_000;
/** Upper bound on `gh pr list` calls in one poll round. */
export const FOUND_LOOKUPS_PER_ROUND_MAX = 20;
/** Upper bound on pull requests read from one `gh pr list` answer. */
const LIST_LIMIT = 100;
/** Upper bound on reflog entries read per worktree. */
const REFLOG_ENTRIES_MAX = 500;

/** What the poller keeps between rounds. */
export interface FoundState {
    /** Per repository (`owner/name`), the time of the last ask in milliseconds. */
    asked: Map<string, number>;
    /** Per worktree path, the repository of its origin; null for one that is not on GitHub. */
    slugs: Map<string, string | null>;
}

export function new_found_state(): FoundState {
    return { asked: new Map(), slugs: new Map() };
}

export interface FoundDeps {
    gh: GhRunner;
    /** A session's pipeline configuration; read only when a pull request is found for it. */
    config: (summary: SessionSummary) => PipelineConfig;
    /** The operator's login; asked for only when a pull request is found. */
    owner_login: (config: PipelineConfig) => Promise<string>;
    now: Date;
    log: (line: string) => void;
    state: FoundState;
}

/** One row of `gh pr list --json number,url,title,createdAt,headRefName`. */
export interface ListedPr {
    number: number;
    url: string;
    title: string;
    createdAt: string;
    headRefName: string;
}

/** One repo of one session that has a worktree on disk and a GitHub origin. */
interface SessionRepo {
    summary: SessionSummary;
    repo: string;
    worktree: string;
    slug: string;
}

/** Pure: true when `slug` is due: never asked, or the recheck time passed. */
export function is_due(state: FoundState, slug: string, now: number): boolean {
    const last = state.asked.get(slug);
    return last === undefined || now - last >= FOUND_RECHECK_MS;
}

/**
 * Pure: the branches a worktree's HEAD reflog names, from its `checkout: moving from A to B`
 * lines (`git reflog --format=%gs`). A commit hash (a detached head) is left out.
 */
export function reflog_branches(subjects: string): Set<string> {
    const branches = new Set<string>();
    for (const line of subjects.split("\n")) {
        const match = /^checkout: moving from (\S+) to (\S+)$/.exec(line.trim());
        for (const name of match?.slice(1) ?? []) {
            if (!/^[0-9a-f]{40}$/.test(name)) {
                branches.add(name);
            }
        }
    }
    return branches;
}

/** Pure: the listed pull requests that no session holds. `held` has `<slug>#<number>`. */
export function untracked(
    slug: string,
    listed: readonly ListedPr[],
    held: ReadonlySet<string>,
): ListedPr[] {
    return listed.filter((pr) => !held.has(`${slug}#${pr.number}`));
}

/**
 * One look over every session. Returns one line per pull request recorded. A review or
 * planning session is skipped: a review session's worktrees hold other people's branches.
 */
export async function track_found_prs(
    home: SpinnerHome,
    sessions: readonly SessionSummary[],
    deps: FoundDeps,
): Promise<string[]> {
    const repos = await session_repos(sessions, deps.state);
    const held = new Set<string>();
    for (const { summary, repo, slug } of repos) {
        for (const number of tracked_numbers(summary.session, repo)) {
            held.add(`${slug}#${number}`);
        }
    }
    const recorded: string[] = [];
    let lookups = 0;
    for (const slug of new Set(repos.map((entry) => entry.slug))) {
        const due = is_due(deps.state, slug, deps.now.getTime());
        if (!due || lookups >= FOUND_LOOKUPS_PER_ROUND_MAX) {
            continue;
        }
        lookups += 1;
        deps.state.asked.set(slug, deps.now.getTime());
        const candidates = repos.filter((entry) => entry.slug === slug);
        for (const pr of untracked(slug, await list_open_prs(deps.gh, slug), held)) {
            const line = await record_in_owner(home, candidates, pr, deps);
            if (line !== null) {
                recorded.push(line);
                held.add(`${slug}#${pr.number}`);
            }
        }
    }
    return recorded;
}

/** The repos of the ordinary sessions that have a worktree on disk and a GitHub origin. */
async function session_repos(
    sessions: readonly SessionSummary[],
    state: FoundState,
): Promise<SessionRepo[]> {
    const found: SessionRepo[] = [];
    for (const summary of sessions) {
        if (summary.session.kind !== undefined) {
            continue;
        }
        for (const [repo, entry] of Object.entries(summary.session.repos)) {
            const worktree = entry.worktree === undefined ? "" : join(summary.path, entry.worktree);
            if (worktree === "" || !existsSync(worktree)) {
                continue;
            }
            if (!state.slugs.has(worktree)) {
                const origin = await origin_repo(worktree);
                const name = origin === null ? null : `${origin.owner}/${origin.name}`;
                state.slugs.set(worktree, name);
            }
            const slug = state.slugs.get(worktree) ?? null;
            if (slug !== null) {
                found.push({ summary, repo, worktree, slug });
            }
        }
    }
    return found;
}

/** The operator's open pull requests of `slug`; at most `LIST_LIMIT`. */
async function list_open_prs(gh: GhRunner, slug: string): Promise<ListedPr[]> {
    const fields = "number,url,title,createdAt,headRefName";
    const out = await gh([
        "pr",
        "list",
        "--repo",
        slug,
        "--author",
        "@me",
        "--state",
        "open",
        "--json",
        fields,
        "--limit",
        String(LIST_LIMIT),
    ]);
    const parsed: unknown = JSON.parse(out);
    assert.ok(Array.isArray(parsed), "gh pr list must print a JSON array");
    return parsed as ListedPr[];
}

/**
 * The branches that the worktrees under the session directory have or had checked out, for
 * the repository that `worktree` belongs to. A worktree an agent added under the session
 * counts; the operator's own checkout and other sessions' worktrees do not.
 */
async function session_branches(session_path: string, worktree: string): Promise<Set<string>> {
    const real = realpathSync(session_path);
    const inside = real.endsWith(sep) ? real : real + sep;
    const branches = new Set<string>();
    for (const entry of await worktree_branches(worktree)) {
        if (!entry.path.startsWith(inside) || !existsSync(entry.path)) {
            continue;
        }
        if (entry.branch !== null) {
            branches.add(entry.branch);
        }
        const count = String(REFLOG_ENTRIES_MAX);
        const args = ["-C", entry.path, "reflog", "show", "--format=%gs", "-n", count, "HEAD"];
        for (const branch of reflog_branches(await run_ok("git", args))) {
            branches.add(branch);
        }
    }
    return branches;
}

/**
 * Records `pr` in the first session whose worktrees had its head branch checked out. Null
 * when no session did: the pull request is not a session's work.
 */
async function record_in_owner(
    home: SpinnerHome,
    candidates: readonly SessionRepo[],
    pr: ListedPr,
    deps: FoundDeps,
): Promise<string | null> {
    for (const { summary, repo, worktree } of candidates) {
        const branches = await session_branches(summary.path, worktree);
        if (branches.has(pr.headRefName)) {
            return record_found(home, summary, repo, pr, deps);
        }
    }
    return null;
}

/**
 * Records one found pull request, unless the session holds its number by now. The session
 * is read again first: a find before this one in the same round may have written it.
 */
async function record_found(
    home: SpinnerHome,
    summary: SessionSummary,
    repo: string,
    pr: ListedPr,
    deps: FoundDeps,
): Promise<string | null> {
    const dir = summary.dir;
    const branch = pr.headRefName;
    const read = read_session(home, dir);
    if (!read.ok || tracked_numbers(read.summary.session, repo).has(pr.number)) {
        return null;
    }
    const ref = parse_pr_url(pr.url);
    assert.ok(ref !== null, `gh listed a pull request without a GitHub URL: ${pr.url}`);
    let id = change_on_branch(read.summary.session, repo, branch);
    if (id === null) {
        id = next_change_id(read.summary.session);
        const input = { id, title: pr.title, branch, started: pr.createdAt };
        write_session({ ...read.summary, session: add_found_change(read.summary.session, input) });
    }
    const fresh = read_session(home, dir);
    assert.ok(fresh.ok, `${dir} must read back after a found pull request`);
    const focused = focus_summary(fresh.summary, id);
    const response = await fetch_pr_response(deps.gh, ref);
    const config = deps.config(summary);
    const context = { config: config.github, owner_login: await deps.owner_login(config) };
    const facts = pr_facts_from_response(response, context);
    const next = apply_pr_facts(focused.session, repo, facts);
    const refreshed = refresh_session(focused.session, next, config, deps.now);
    write_session({ ...focused, session: refreshed.session });
    const what = `found ${repo}#${pr.number} on ${branch}, opened outside a change`;
    const line = `${what}: tracked as ${id}`;
    log_found(fresh.summary, line, deps.now);
    deps.log(`${dir}: ${line}`);
    return line;
}

function log_found(summary: SessionSummary, line: string, now: Date): void {
    const mission_path = join(summary.path, "MISSION.md");
    if (!existsSync(mission_path)) {
        return;
    }
    const mission = readFileSync(mission_path, "utf8");
    writeFileSync(mission_path, append_log_line(mission, clock(now), "spinner", `pr: ${line}`));
}
