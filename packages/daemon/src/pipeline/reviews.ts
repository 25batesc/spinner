// Reviews (MISSION.md s015): a place for a peer's PR. `POST /reviews { text }` takes PR
// references in any form the extractor reads, with no project: any repository the operator's
// `gh` can read. Each resolved PR becomes one session of `kind: review`: the repository is
// cloned once under `<home>/reviews/<owner>-<name>/` and fetched per review, the PR head is
// checked out detached under the session's `worktrees/<name>` (no branch, so nothing can be
// pushed from it), and the PR facts go into `session.yaml` like an adopted PR's, so the
// poller, the threads and the board track it. No stack, no project, no pipeline but `review`.
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Session, SessionSummary } from "@spinner/protocol";
import { add_detached_worktree } from "../git/worktree.js";
import type { SpinnerHome } from "../home.js";
import { run, run_ok } from "../stack/shell.js";
import { create_session, read_session, write_session } from "../store/session-store.js";
import { pipeline_config_from_spec } from "./config.js";
import { extract_refs, type ExtractRef } from "./extract.js";
import {
    fetch_owner_login,
    fetch_pr_response,
    pr_facts_from_response,
    type GhRunner,
    type PrRef,
} from "./github.js";
import { apply_pr_facts, refresh_session } from "./tracker.js";

/** Where the review clones live, under the home. */
export const REVIEWS_DIR = "reviews";

/** Upper bound on one clone or fetch. */
const GIT_TIMEOUT_MS = 5 * 60_000;

export interface CreateReviewsInput {
    text: string;
    gh: GhRunner;
    /** The URL `git clone` takes for a repository; GitHub over https when absent. Tests: a path. */
    clone_url?: (ref: PrRef) => string;
    now?: () => Date;
    log?: (line: string) => void;
}

export interface CreateReviewsResult {
    sessions: SessionSummary[];
    /** References that did not resolve to a PR, with the reason. */
    skipped: { ref: string; reason: string }[];
}

/**
 * One review session per PR reference in `text`. Throws when no reference resolves; a
 * reference that resolves but fails later (a repository `gh` cannot read, a clone that
 * fails) is logged and skipped, so one bad link does not sink the paste.
 */
export async function create_reviews(
    home: SpinnerHome,
    input: CreateReviewsInput,
): Promise<CreateReviewsResult> {
    assert.ok(input.text.trim().length > 0, "a review needs text");
    const now = input.now ?? (() => new Date());
    const log = input.log ?? (() => {});
    const clone_url = input.clone_url ?? github_clone_url;
    const extraction = extract_refs(input.text, []);
    const result: CreateReviewsResult = { sessions: [], skipped: [] };
    const refs: PrRef[] = [];
    for (const ref of extraction.refs) {
        const resolved = pr_ref_of(ref);
        if (resolved === null) {
            result.skipped.push({ ref: ref.ref, reason: ref.reason ?? "not a PR reference" });
            continue;
        }
        refs.push(resolved);
    }
    if (refs.length === 0) {
        const reasons = result.skipped.map((entry) => `${entry.ref}: ${entry.reason}`);
        const detail = reasons.length === 0 ? "no PR reference in the text" : reasons.join("; ");
        throw new Error(`nothing to review (${detail})`);
    }
    const owner_login = await fetch_owner_login(input.gh);
    for (const ref of refs) {
        const label = `${ref.owner}/${ref.name}#${ref.number}`;
        try {
            const summary = await create_review(home, ref, {
                gh: input.gh,
                owner_login,
                clone_url: clone_url(ref),
                now,
                log,
            });
            result.sessions.push(summary);
            log(`review ${summary.dir}: ${label} at ${summary.session.repos[ref.name]?.pr?.head}`);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            result.skipped.push({ ref: label, reason });
            log(`review of ${label} skipped: ${reason}`);
        }
    }
    if (result.sessions.length === 0) {
        const reasons = result.skipped.map((entry) => `${entry.ref}: ${entry.reason}`);
        throw new Error(`no review created (${reasons.join("; ")})`);
    }
    return result;
}

interface CreateReviewDeps {
    gh: GhRunner;
    owner_login: string;
    clone_url: string;
    now: () => Date;
    log: (line: string) => void;
}

/** One PR: the facts, the clone or fetch, the session, the detached worktree. */
async function create_review(
    home: SpinnerHome,
    ref: PrRef,
    deps: CreateReviewDeps,
): Promise<SessionSummary> {
    const response = await fetch_pr_response(deps.gh, ref);
    const node = response.data.repository.pullRequest;
    const clone = review_clone_path(home, ref);
    await clone_or_fetch(clone, deps.clone_url, ref.number, node.headRefOid, deps.log);
    const created = create_session(home, {
        title: node.title,
        now: deps.now(),
        adopted: [node.url],
    });
    const worktree = join("worktrees", ref.name);
    const config = pipeline_config_from_spec({});
    const facts = pr_facts_from_response(response, {
        config: config.github,
        owner_login: deps.owner_login,
    });
    const session: Session = {
        ...created.session,
        kind: "review",
        branch: node.headRefName,
        base: node.baseRefName,
        repos: { [ref.name]: { path: clone, worktree, changed: false, pr: null } },
        pipeline: { verified_locally: false, verified_heads: {}, slack_post: null },
    };
    const tracked = apply_pr_facts(session, ref.name, facts);
    const refreshed = refresh_session(created.session, tracked, config, deps.now());
    write_session({ ...created, session: refreshed.session });
    const outcome = await add_detached_worktree({
        repo_path: clone,
        worktree_path: join(created.path, worktree),
        commit: node.headRefOid,
        session_dir: created.path,
    });
    deps.log(`worktree ${worktree} ${outcome} at ${node.headRefOid.slice(0, 7)} (detached)`);
    const check = read_session(home, created.dir);
    assert.ok(check.ok, "a review session must read back");
    return check.summary;
}

/** `<home>/reviews/<owner>-<name>`. */
export function review_clone_path(home: SpinnerHome, ref: PrRef): string {
    return join(home.root, REVIEWS_DIR, `${ref.owner}-${ref.name}`);
}

/**
 * The clone once, then one fetch of the PR head per review: `refs/pull/<n>/head` covers a
 * fork's PR too. The head SHA must be reachable afterwards; a stale PR view is an error.
 */
async function clone_or_fetch(
    clone: string,
    url: string,
    number: number,
    head: string,
    log: (line: string) => void,
): Promise<void> {
    if (!existsSync(join(clone, ".git"))) {
        mkdirSync(clone, { recursive: true });
        log(`cloning ${url} into ${clone}`);
        await run_ok("git", ["clone", "--quiet", url, clone], { timeout_ms: GIT_TIMEOUT_MS });
    }
    const pull_ref = `refs/pull/${number}/head`;
    const fetched = await run("git", ["-C", clone, "fetch", "--quiet", "origin", pull_ref], {
        timeout_ms: GIT_TIMEOUT_MS,
    });
    if (fetched.code !== 0) {
        throw new Error(`fetch of ${pull_ref} failed: ${fetched.stderr.trim()}`);
    }
    const known = await run("git", ["-C", clone, "cat-file", "-e", `${head}^{commit}`]);
    if (known.code !== 0) {
        throw new Error(`PR head ${head} is not in ${clone} after the fetch`);
    }
}

function github_clone_url(ref: PrRef): string {
    return `https://github.com/${ref.owner}/${ref.name}.git`;
}

function pr_ref_of(ref: ExtractRef): PrRef | null {
    if (ref.owner === null || ref.name === null) {
        return null;
    }
    return { owner: ref.owner, name: ref.name, number: ref.number };
}

/** True for a session of `kind: review`. */
export function is_review(session: Pick<Session, "kind">): boolean {
    return session.kind === "review";
}
