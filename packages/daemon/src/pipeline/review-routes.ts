// The review lead's routes (MISSION.md s016, Plan item 3): the briefing, the draft and the
// post. `PUT .../review/briefing` is the lead's `review_briefing` tool. `PUT .../review/draft`
// is both the lead's `review_draft` tool and the operator's edits in the review pane: the
// body is validated against the PR diff and written only when whole; `session.yaml` then
// carries `review.draft: true`, which the tracker turns into `needs_human`. `DELETE` drops
// it. `POST .../review/post` is the operator's click and the only path that posts a review:
// one PR review at the head SHA through the operator's `gh`. The posted URL lands in
// `session.yaml` and in one Log line. `approve` posts APPROVE "LGTM" without a swarm and
// `cancel` stops a running review (dogfood #22); both are the operator's clicks. Each write
// answers at once and publishes the view, so `review.updated` follows.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import type {
    ErrorResponse,
    OkResponse,
    ReviewCancelResponse,
    ReviewDraft,
    ReviewDraftResponse,
    ReviewPostResponse,
    Session,
    SessionSummary,
} from "@spinner/protocol";
import { LEAD_NAME, REVIEW_VERDICTS_DIR } from "@spinner/protocol";
import * as actions from "../actions.js";
import type { ActionContext } from "../actions.js";
import type { AgentManager } from "../agents/manager.js";
import type { ReviewSwarm } from "../agents/swarm.js";
import type { SpinnerHome } from "../home.js";
import type { MissionWriter } from "../store/mission-writer.js";
import { find_session, read_session, write_session } from "../store/session-store.js";
import { parse_pr_url, type PrRef } from "./github.js";
import { github_write } from "./github-write.js";
import { config_for_session } from "./poller.js";
import {
    briefing_path,
    drop_draft,
    fetch_diff_lines,
    parse_draft,
    post_review,
    read_draft,
    validate_draft,
    write_briefing,
    write_draft,
    write_posted,
} from "./review-draft.js";
import { is_review } from "./reviews.js";
import { refresh_session, session_prs } from "./tracker.js";

export interface ReviewRouteDeps {
    home: SpinnerHome;
    ctx: ActionContext;
    /** After a write: the view on the bus, so the pane and `review.updated` follow. */
    refresh: (dir: string) => Promise<void>;
    /** The mission writer, for the Log line after a post; a route test may run without. */
    writer?: MissionWriter;
    /** After a post: one poll round, so the PR's review decision follows at once. */
    poll?: () => Promise<void>;
    /** `cancel` stops the reviewers through the swarm and a review session's lead (#22). */
    swarm?: ReviewSwarm;
    agents?: AgentManager;
    log?: (line: string) => void;
}

/** The body of the operator's one-click approve (dogfood #22). */
export const APPROVE_BODY = "LGTM";

export function mount_review_routes(app: Hono, deps: ReviewRouteDeps): void {
    app.get("/sessions/:dir/review/briefing", (c) => {
        const summary = session_of(deps, c);
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const path = briefing_path(summary.path);
        if (!existsSync(path)) {
            return c.json(error_body(`${summary.dir} has no briefing yet`), 404);
        }
        return c.body(readFileSync(path, "utf8"), 200, { "content-type": "text/markdown" });
    });

    app.put("/sessions/:dir/review/briefing", async (c) => {
        const summary = session_of(deps, c);
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const body = await json_body(c);
        const markdown =
            typeof body === "object" && body !== null
                ? (body as { markdown?: unknown }).markdown
                : "";
        if (typeof markdown !== "string" || markdown.trim().length === 0) {
            return c.json(error_body("`markdown` must be the briefing text"), 400);
        }
        write_briefing(summary.path, markdown);
        deps.log?.(`${summary.dir}: briefing written`);
        await deps.refresh(summary.dir);
        const response: OkResponse = { ok: true };
        return c.json(response);
    });

    app.put("/sessions/:dir/review/draft", async (c) => {
        const summary = session_of(deps, c);
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const target = review_pr(summary);
        if (target === null) {
            return c.json(error_body(`${summary.dir} has no PR to review`), 409);
        }
        const draft = parse_draft(await json_body(c));
        if (typeof draft === "string") {
            return c.json(error_body(draft), 400);
        }
        let errors: string[];
        try {
            errors = validate_draft(draft, await fetch_diff_lines(deps.ctx.gh, target.ref));
        } catch (error) {
            return c.json(error_body(`could not read the PR diff: ${describe_error(error)}`), 502);
        }
        if (errors.length > 0) {
            const noun = errors.length === 1 ? "fault" : "faults";
            const text = `the draft has ${errors.length} ${noun}: ${errors.join("; ")}`;
            return c.json(error_body(text), 400);
        }
        write_draft(summary.path, draft);
        mark_draft(deps, summary, true);
        const count = draft.comments.length;
        deps.log?.(`${summary.dir}: review draft written (${draft.event}, ${count} comments)`);
        await deps.refresh(summary.dir);
        const response: ReviewDraftResponse = { draft };
        return c.json(response);
    });

    app.delete("/sessions/:dir/review/draft", async (c) => {
        const summary = session_of(deps, c);
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        if (!drop_draft(summary.path)) {
            return c.json(error_body(`${summary.dir} has no review draft`), 404);
        }
        mark_draft(deps, summary, false);
        deps.log?.(`${summary.dir}: review draft dropped`);
        await deps.refresh(summary.dir);
        const response: OkResponse = { ok: true };
        return c.json(response);
    });

    app.post("/sessions/:dir/review/approve", (c) => approve_route(c, deps));
    app.post("/sessions/:dir/review/cancel", (c) => cancel_route(c, deps));

    app.post("/sessions/:dir/review/post", async (c) => {
        const summary = session_of(deps, c);
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const draft = read_draft(summary.path);
        if (draft === null) {
            return c.json(error_body(`${summary.dir} has no review draft to post`), 409);
        }
        const target = review_pr(summary);
        if (target === null) {
            return c.json(error_body(`${summary.dir} has no PR to review`), 409);
        }
        const repo = `${target.ref.owner}/${target.ref.name}`;
        let result: ReviewPostResponse;
        try {
            result = await post_review(gh_writer(deps, summary, repo), summary.path, {
                pr: target.ref,
                head: target.head,
                draft,
            });
        } catch (error) {
            return c.json(error_body(describe_error(error)), 502);
        }
        write_posted(summary.path, draft, result);
        drop_draft(summary.path);
        mark_draft(deps, summary, false, result.url);
        const fell_back = result.fell_back
            ? "; GitHub refused APPROVE on your own PR, so it went as COMMENT"
            : "";
        const line =
            `posted the review of ${repo}#${target.ref.number} as ${result.event}: ` +
            `${result.url}${fell_back}`;
        deps.log?.(`${summary.dir}: ${line}`);
        await log_line(deps, summary.dir, line);
        if (deps.poll !== undefined) {
            try {
                await deps.poll();
            } catch (error) {
                deps.log?.(`poll after the post: ${describe_error(error)}`);
            }
        }
        await deps.refresh(summary.dir);
        return c.json(result);
    });
}

/**
 * The operator's `gh` for one PR review. A review session exists for exactly this PR, on the
 * operator's paste, and the post is the operator's click; an ordinary session's PR is on the
 * project's allow-list.
 */
function gh_writer(
    deps: ReviewRouteDeps,
    summary: SessionSummary,
    repo: string,
): (args: string[]) => Promise<string> {
    const config = config_for_session(summary, deps.home, deps.ctx.cwd, deps.log ?? (() => {}));
    const allowed = is_review(summary.session)
        ? [...config.github.write_repos, repo]
        : config.github.write_repos;
    return (args) => github_write(actions.writer_of(deps.ctx), allowed, repo, { kind: "gh", args });
}

/**
 * `POST …/review/approve` (dogfood #22): one APPROVE review with "LGTM" at the PR's head,
 * without a swarm or a draft; an existing draft stays. Records it as posted.
 */
async function approve_route(c: Context, deps: ReviewRouteDeps): Promise<Response> {
    const summary = session_of(deps, c);
    if (summary === null) {
        return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
    }
    const target = review_pr(summary);
    if (target === null) {
        return c.json(error_body(`${summary.dir} has no PR to review`), 409);
    }
    const repo = `${target.ref.owner}/${target.ref.name}`;
    const draft: ReviewDraft = { event: "APPROVE", body: APPROVE_BODY, comments: [] };
    let result: ReviewPostResponse;
    try {
        result = await post_review(gh_writer(deps, summary, repo), summary.path, {
            pr: target.ref,
            head: target.head,
            draft,
        });
    } catch (error) {
        return c.json(error_body(describe_error(error)), 502);
    }
    write_posted(summary.path, draft, result);
    mark_draft(deps, summary, read_draft(summary.path) !== null, result.url);
    const fell_back = result.fell_back ? "; GitHub refused APPROVE on your own PR: COMMENT" : "";
    const pr = `${repo}#${target.ref.number}`;
    const line = `approved ${pr} as ${result.event}: ${result.url}${fell_back}`;
    deps.log?.(`${summary.dir}: ${line}`);
    await log_line(deps, summary.dir, line);
    await deps.refresh(summary.dir);
    return c.json(result);
}

/**
 * `POST …/review/cancel` (dogfood #22): the swarm drops and stops its reviewers, a review
 * session's lead stops, and the verdict files move under `artifacts/reviews-cancelled/`.
 */
async function cancel_route(c: Context, deps: ReviewRouteDeps): Promise<Response> {
    const summary = session_of(deps, c);
    if (summary === null) {
        return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
    }
    if (summary.session.review === undefined && !is_review(summary.session)) {
        return c.json(error_body(`${summary.dir} has no review to cancel`), 409);
    }
    const stopped = deps.swarm === undefined ? [] : await deps.swarm.cancel(summary.dir);
    if (deps.swarm === undefined) {
        mark_cancelled(deps, summary);
    }
    if (is_review(summary.session) && deps.agents?.get(summary.dir, LEAD_NAME) != null) {
        await deps.agents.stop(summary.dir, LEAD_NAME).catch(() => undefined);
        stopped.push(LEAD_NAME);
    }
    const archived = archive_verdicts(summary.path, new Date());
    const line =
        `cancelled the review: stopped ${stopped.length === 0 ? "nothing" : stopped.join(", ")}` +
        `; archived ${archived.length} verdict file${archived.length === 1 ? "" : "s"}`;
    deps.log?.(`${summary.dir}: ${line}`);
    await log_line(deps, summary.dir, line);
    await deps.refresh(summary.dir);
    const response: ReviewCancelResponse = { ok: true, stopped, archived };
    return c.json(response);
}

/** The PR a review of the session is about: the first tracked PR's ref and head. */
function review_pr(summary: SessionSummary): { ref: PrRef; head: string } | null {
    const pr = session_prs(summary.session)[0];
    if (pr === undefined) {
        return null;
    }
    const ref = parse_pr_url(pr.url);
    if (ref === null) {
        return null;
    }
    return { ref, head: pr.head };
}

/** `review.draft` (and `posted_url`) in `session.yaml`, then the stage re-derived. */
function mark_draft(
    deps: ReviewRouteDeps,
    summary: SessionSummary,
    draft: boolean,
    posted_url?: string,
): void {
    const read = read_session(deps.home, summary.dir);
    if (!read.ok) {
        return;
    }
    const session: Session = read.summary.session;
    session.review ??= { swarm: {} };
    session.review.draft = draft;
    // A draft, a drop, a post or an approve is the next action after a cancel (#22).
    delete session.review.cancelled;
    if (posted_url !== undefined) {
        session.review.posted_url = posted_url;
    }
    const config = config_for_session(summary, deps.home, deps.ctx.cwd, deps.log ?? (() => {}));
    const refreshed = refresh_session(read.summary.session, session, config, new Date());
    write_session({ ...read.summary, session: refreshed.session });
}

/** `review.cancelled` without a swarm (a route test, or a daemon without one). */
function mark_cancelled(deps: ReviewRouteDeps, summary: SessionSummary): void {
    const read = read_session(deps.home, summary.dir);
    if (!read.ok) {
        return;
    }
    read.summary.session.review = {
        ...(read.summary.session.review ?? { swarm: {} }),
        swarm: {},
        cancelled: true,
    };
    write_session(read.summary);
}

/** Upper bound on verdict files moved by one cancel; a swarm has a handful of reviewers. */
const VERDICTS_MAX = 100;

/**
 * Moves the swarm's verdict files to `artifacts/reviews-cancelled/<stamp>/`, so the next run
 * starts without them and the lead does not reconcile a cancelled review. Answers the new
 * paths, relative to the session directory.
 */
export function archive_verdicts(session_path: string, now: Date): string[] {
    const dir = join(session_path, REVIEW_VERDICTS_DIR);
    if (!existsSync(dir)) {
        return [];
    }
    const files = readdirSync(dir).filter((name) => name.endsWith(".md"));
    assert.ok(files.length <= VERDICTS_MAX, `more than ${VERDICTS_MAX} verdict files`);
    if (files.length === 0) {
        return [];
    }
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const target = join("artifacts", "reviews-cancelled", stamp);
    mkdirSync(join(session_path, target), { recursive: true });
    const moved = files.map((name) => {
        renameSync(join(dir, name), join(session_path, target, name));
        return join(target, name);
    });
    assert.equal(readdirSync(dir).filter((name) => name.endsWith(".md")).length, 0);
    return moved;
}

async function log_line(deps: ReviewRouteDeps, dir: string, text: string): Promise<void> {
    if (deps.writer === undefined) {
        return;
    }
    try {
        await deps.writer.write(dir, { section: "log", mode: "append", text, author: "operator" });
    } catch (error) {
        deps.log?.(`${dir}: Log line not written: ${describe_error(error)}`);
    }
}

function session_of(deps: ReviewRouteDeps, c: Context): SessionSummary | null {
    const dir = c.req.param("dir") ?? "";
    return dir.length === 0 ? null : find_session(deps.home, dir);
}

async function json_body(c: Context): Promise<unknown> {
    const text = await c.req.text();
    if (text.trim().length === 0) {
        return undefined;
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return null;
    }
}

function error_body(error: string): ErrorResponse {
    return { error };
}

function describe_error(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
