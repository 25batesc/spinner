// `spinner adopt <pr-url>...`: a session built from PRs that were opened outside Spinner, so
// the board can track them. It creates the session directory with `session.yaml` and the
// minimal `MISSION.md`, fetches each PR once and derives the stage. No worktrees, no stack:
// adopting is for watching, not for building.
import assert from "node:assert/strict";
import { basename } from "node:path";
import type { Session, SessionRepo, SessionSummary, StackSpec } from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";
import { find_spec, load_spec } from "../stack/spec.js";
import { create_session, read_session, write_session } from "../store/session-store.js";
import { pipeline_config_from_spec } from "./config.js";
import {
    fetch_owner_login,
    fetch_pr_response,
    parse_pr_url,
    pr_facts_from_response,
    type GhRunner,
    type PrRef,
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
    const refs = input.urls.map((url) => {
        const ref = parse_pr_url(url);
        if (ref === null) {
            throw new Error(`not a GitHub pull request URL: ${url}`);
        }
        return ref;
    });

    const spec = load_project(input.project, home, input.cwd, log);
    const config = pipeline_config_from_spec(spec);
    const owner_login = config.github.owner_login ?? (await fetch_owner_login(input.gh));
    const responses = [];
    for (const ref of refs) {
        responses.push(await fetch_pr_response(input.gh, ref));
    }
    const first = responses[0];
    assert.ok(first !== undefined);
    const first_node = first.data.repository.pullRequest;

    const title = input.title ?? first_node.title;
    const created = create_session(home, { title, now: now() });
    let session: Session = {
        ...created.session,
        branch: first_node.headRefName,
        base: first_node.baseRefName,
        pipeline: { verified_locally: false, verified_heads: {}, slack_post: null },
    };
    if (input.project !== undefined) {
        session.project = input.project;
    }
    for (const [index, ref] of refs.entries()) {
        const response = responses[index];
        assert.ok(response !== undefined);
        const repo = repo_for(ref, spec, log);
        session.repos[repo.key] = repo.entry;
        const facts = pr_facts_from_response(response, { config: config.github, owner_login });
        session = apply_pr_facts(session, repo.key, facts);
    }
    const refreshed = refresh_session(created.session, session, config, now());
    write_session({ ...created, session: refreshed.session });
    const check = read_session(home, created.dir);
    assert.ok(check.ok, "an adopted session must read back");
    return check.summary;
}

/**
 * The project's spec, or an empty one (plain GitHub defaults) when none can be found. A spec
 * that exists but does not load is an error, not a fallback.
 */
function load_project(
    project: string | undefined,
    home: SpinnerHome,
    cwd: string,
    log: (line: string) => void,
): Pick<StackSpec, "repos" | "pipeline"> {
    let path: string;
    try {
        path = find_spec(project, home, cwd);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`adopt: no project spec, using plain GitHub defaults (${message})`);
        return { repos: {} };
    }
    return load_spec(path).spec;
}

interface RepoMatch {
    key: string;
    entry: SessionRepo;
}

/**
 * Maps a PR's GitHub repo to a repo of the spec by the basename of its path, which is the
 * clone directory name in the common case. Without a match, the GitHub name is the key and
 * the PR's repository URL stands in for the path, since adopt never checks anything out.
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
