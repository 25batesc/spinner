// `spinner adopt <pr-url>...`: a session built from PRs that were opened outside Spinner, so
// the board can track them. It creates the session directory with `session.yaml` and a
// `MISSION.md` that lists the PRs, fetches each PR once and derives the stage. With a project
// it also checks each PR's head branch out as the repo's worktree, so `up`, the agents, `fix`
// and `land` work on the session; without one, adopting is for watching only. `attach_adopted`
// does the worktree half later for a session adopted without a project.
import assert from "node:assert/strict";
import { basename } from "node:path";
import type { Session, SessionRepo, SessionSummary, StackSpec } from "@spinner/protocol";
import { fetch_branch } from "../git/worktree.js";
import type { SpinnerHome } from "../home.js";
import { attach_project } from "../stack/runner.js";
import { find_spec, load_spec, type LoadedSpec } from "../stack/spec.js";
import { create_session, read_session, write_session } from "../store/session-store.js";
import { pipeline_config_from_spec } from "./config.js";
import {
    fetch_owner_login,
    fetch_pr_response,
    parse_pr_url,
    pr_facts_from_response,
    type GhRunner,
    type PrRef,
    type PrResponse,
} from "./github.js";
import { apply_pr_facts, refresh_session } from "./tracker.js";

export interface AdoptInput {
    urls: string[];
    /** Project name or spec path. Without it, the current directory must hold a spinner.yaml. */
    project?: string;
    /** Session title. Defaults to the first PR's title. */
    title?: string;
    cwd: string;
    gh: GhRunner;
    now?: () => Date;
    log?: (line: string) => void;
}

/** Upper bound on PRs adopted into one session: one per repo of a project, with margin. */
const URLS_MAX = 20;

export async function adopt_prs(home: SpinnerHome, input: AdoptInput): Promise<SessionSummary> {
    assert.ok(input.urls.length > 0, "adopt needs at least one PR URL");
    assert.ok(input.urls.length <= URLS_MAX, `adopt takes at most ${URLS_MAX} PRs`);
    const now = input.now ?? (() => new Date());
    const log = input.log ?? (() => {});
    const refs = input.urls.map(parse_ref);

    const loaded = load_project(input.project, home, input.cwd, log);
    const spec: Pick<StackSpec, "repos" | "pipeline"> = loaded?.spec ?? { repos: {} };
    const config = pipeline_config_from_spec(spec);
    const owner_login = config.github.owner_login ?? (await fetch_owner_login(input.gh));
    const responses: PrResponse[] = [];
    for (const ref of refs) {
        responses.push(await fetch_pr_response(input.gh, ref));
    }
    const first = responses[0];
    assert.ok(first !== undefined);
    const first_node = first.data.repository.pullRequest;

    const title = input.title ?? first_node.title;
    const created = create_session(home, { title, now: now(), adopted: input.urls });
    let session: Session = {
        ...created.session,
        branch: session_branch(responses),
        base: first_node.baseRefName,
        pipeline: { verified_locally: false, verified_heads: {}, slack_post: null },
    };
    if (input.project !== undefined) {
        session.project = input.project;
    }
    const heads: Record<string, string> = {};
    for (const [index, ref] of refs.entries()) {
        const response = responses[index];
        assert.ok(response !== undefined);
        const repo = repo_for(ref, spec, log);
        session.repos[repo.key] = repo.entry;
        heads[repo.key] = response.data.repository.pullRequest.headRefName;
        const facts = pr_facts_from_response(response, { config: config.github, owner_login });
        session = apply_pr_facts(session, repo.key, facts);
    }
    const refreshed = refresh_session(created.session, session, config, now());
    write_session({ ...created, session: refreshed.session });
    if (loaded !== null) {
        await attach_worktrees({ ...created, session: refreshed.session }, loaded, heads, log);
    }
    const check = read_session(home, created.dir);
    assert.ok(check.ok, "an adopted session must read back");
    return check.summary;
}

export interface AttachInput {
    /** Absolute path of the project's spec, resolved by the caller. */
    spec_path: string;
    gh: GhRunner;
    log?: (line: string) => void;
}

/**
 * The worktree half of adopt for a session that was adopted without a project: asks GitHub
 * for the head branch of each PR the session tracks, then attaches the project with those
 * branches. The session's branch becomes the PRs' head branch. Safe to run again.
 */
export async function attach_adopted(
    home: SpinnerHome,
    summary: SessionSummary,
    input: AttachInput,
): Promise<SessionSummary> {
    const log = input.log ?? (() => {});
    const loaded = load_spec(input.spec_path);
    const tracked = Object.entries(summary.session.repos).filter(
        ([, repo]) => repo.pr !== null && repo.pr !== undefined,
    );
    if (tracked.length === 0) {
        throw new Error(`${summary.dir} tracks no PR; attach is for adopted sessions`);
    }
    const heads: Record<string, string> = {};
    const responses: PrResponse[] = [];
    for (const [key, repo] of tracked) {
        assert.ok(repo.pr !== null && repo.pr !== undefined);
        const response = await fetch_pr_response(input.gh, parse_ref(repo.pr.url));
        responses.push(response);
        heads[key] = response.data.repository.pullRequest.headRefName;
    }
    summary.session.branch = session_branch(responses);
    const attached = await attach_worktrees(summary, loaded, heads, log);
    const check = read_session(home, attached.dir);
    assert.ok(check.ok, "an attached session must read back");
    return check.summary;
}

/**
 * Fetches each PR's head branch into its repo, then attaches the project: worktrees for every
 * repo of the spec, the PR repos on their head branch and the others on the session branch.
 * A PR whose repo is not in the spec stays tracked by name, without a worktree.
 */
async function attach_worktrees(
    summary: SessionSummary,
    loaded: LoadedSpec,
    heads: Record<string, string>,
    log: (line: string) => void,
): Promise<SessionSummary> {
    const branches: Record<string, string> = {};
    for (const [key, head] of Object.entries(heads)) {
        const repo = loaded.spec.repos[key];
        if (repo === undefined) {
            log(`adopt: ${key} is not a repo of ${loaded.spec.name}; no worktree for it`);
            continue;
        }
        const outcome = await fetch_branch(repo.path, head);
        log(`branch ${head} ${outcome} in ${repo.path}`);
        branches[key] = head;
    }
    const base = summary.session.base;
    return attach_project(summary, loaded, log, { branches, base });
}

/**
 * The session branch of adopted PRs: the head branch they all share, else the first PR's.
 * A session with PRs on different branches keeps each repo's own in its worktree.
 */
function session_branch(responses: PrResponse[]): string {
    const first = responses[0]?.data.repository.pullRequest.headRefName;
    assert.ok(first !== undefined, "session_branch needs at least one PR");
    return first;
}

function parse_ref(url: string): PrRef {
    const ref = parse_pr_url(url);
    if (ref === null) {
        throw new Error(`not a GitHub pull request URL: ${url}`);
    }
    return ref;
}

/**
 * The project's spec, or null (plain GitHub defaults, board only) when none is named and the
 * current directory holds none. A spec that exists but does not load is an error.
 */
function load_project(
    project: string | undefined,
    home: SpinnerHome,
    cwd: string,
    log: (line: string) => void,
): LoadedSpec | null {
    let path: string;
    try {
        path = find_spec(project, home, cwd);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`adopt: no project spec, using plain GitHub defaults (${message})`);
        return null;
    }
    return load_spec(path);
}

interface RepoMatch {
    key: string;
    entry: SessionRepo;
}

/**
 * Maps a PR's GitHub repo to a repo of the spec by the basename of its path, which is the
 * clone directory name in the common case. Without a match, the GitHub name is the key and
 * the PR's repository URL stands in for the path, since no checkout exists for it.
 */
function repo_for(
    ref: PrRef,
    spec: Pick<StackSpec, "repos">,
    log: (line: string) => void,
): RepoMatch {
    for (const [key, repo] of Object.entries(spec.repos)) {
        if (basename(repo.path) === ref.name) {
            return { key, entry: { path: repo.path, changed: true, pr: null } };
        }
    }
    log(`adopt: ${ref.owner}/${ref.name} is not a repo of the project; tracking it by name`);
    const path = `https://github.com/${ref.owner}/${ref.name}`;
    return { key: ref.name, entry: { path, changed: true, pr: null } };
}
