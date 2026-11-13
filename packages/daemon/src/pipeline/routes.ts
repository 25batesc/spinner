// The pipeline commands' routes (`pr`, `fix`, `review`, `threads`, `post`, `approve`, `land`,
// `reset`), mounted on the daemon's Hono app by one registry line in `server.ts`. Each write
// starts a job on `actions.ts`, the same functions the CLI calls; each read answers from the
// session directory. Bodies are parsed here, so a bad request is a 400 before any job starts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono, Context } from "hono";
import type {
    ApproveRequest,
    ApproveResponse,
    ChangeStartRequest,
    ErrorResponse,
    FixRequest,
    JobAction,
    JobResponse,
    LandRequest,
    PostRequest,
    PostResponse,
    PrRequest,
    ResetRequest,
    ReviewRequest,
    SessionSummary,
    ThreadFlagRequest,
    ThreadReplyRequest,
    ThreadResponse,
    ThreadsResponse,
} from "@spinner/protocol";
import { ROUNDS_MAX } from "@spinner/protocol";
import { count_outcome } from "./outcomes.js";
import { parse_previous_rounds } from "./rounds.js";
import { thread_file, type ThreadsDiff } from "./threads.js";
import { review_targets } from "./review.js";
import type { ReviewSwarm } from "../agents/swarm.js";
import * as actions from "../actions.js";
import type { ActionContext } from "../actions.js";
import type { EventBus } from "../event-bus.js";
import type { SpinnerHome } from "../home.js";
import type { JobRunner, JobWork } from "../jobs/jobs.js";
import { find_session, focus_summary } from "../store/session-store.js";
import { current_change, has_change } from "./changes.js";

/** What the routes need from the daemon; `server.ts` passes its `AppDeps` plus the bus. */
export interface PipelineRouteDeps {
    home: SpinnerHome;
    ctx: ActionContext;
    jobs: JobRunner;
    bus: EventBus;
    /** Called after a job on `dir` finished, so the view carries fresh facts. */
    refresh: (dir: string) => Promise<void>;
    /** The review swarm (s015); `review` answers 503 without it (a route test without agents). */
    swarm?: ReviewSwarm;
}

export function mount_pipeline_routes(app: Hono, deps: PipelineRouteDeps): void {
    // The Log of an earlier round, from `## Previous rounds` (EGM, T14, 2.45).
    app.get("/sessions/:dir/rounds/:round/log", (c) => {
        const raw = c.req.param("round");
        const round = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
        if (!Number.isInteger(round) || round < 1 || round > ROUNDS_MAX) {
            return c.json(error_body(`round must be an integer from 1 to ${ROUNDS_MAX}`), 400);
        }
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const file = join(summary.path, "MISSION.md");
        const mission = existsSync(file) ? readFileSync(file, "utf8") : "";
        const entry = parse_previous_rounds(mission).find((parsed) => parsed.round === round);
        if (entry === undefined) {
            return c.json(error_body(`no Log for round ${round} in ${summary.dir}`), 404);
        }
        return c.body(`${entry.log}\n`, 200, { "content-type": "text/markdown" });
    });

    app.post("/sessions/:dir/pr", async (c) => {
        const request = parse_pr(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        return start_job(c, deps, "pr", summary.dir, (log) =>
            actions.pr(deps.ctx, summary, request, log).then(() => {}),
        );
    });

    app.post("/sessions/:dir/fix", async (c) => {
        const request = parse_fix(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        return start_job(c, deps, "fix", summary.dir, async (log) => {
            // A fixer round counts when its job starts (6.20), on a fresh read of the session.
            // The fix continues from the counted summary, because it writes the session too.
            const counted = count_outcome(deps.home, summary.dir, "fix_rounds");
            const result = await actions.fix(deps.ctx, counted, request, log);
            publish_threads(deps, summary, result.diffs);
        });
    });

    app.post("/sessions/:dir/review", async (c) => {
        const request = parse_review(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const swarm = deps.swarm;
        if (swarm === undefined) {
            return c.json(error_body("the review swarm is not available"), 503);
        }
        try {
            review_targets(summary, request);
        } catch (error) {
            return c.json(error_body(describe_error(error)), 409);
        }
        // The swarm starts inside the job, so a reviewer that does not start is a failed
        // job with the reason in its log; the 409s the contract names come first, from
        // `start` throwing before any agent is touched.
        try {
            await swarm.check(summary, request);
        } catch (error) {
            return c.json(error_body(describe_error(error)), 409);
        }
        const work: JobWork = async (log) => {
            const result = await swarm.start(summary, request, log);
            const total = result.started.length + result.queued.length + result.failed.length;
            const counts = `${result.started.length} started, ${result.queued.length} queued`;
            const failed = result.failed.length === 0 ? "" : `, ${result.failed.length} failed`;
            log(`swarm of ${total}: ${counts}${failed}`);
        };
        try {
            const job = deps.jobs.start("review", summary.dir, work, { exclusive: false });
            const body: JobResponse = { job };
            return c.json(body, 202);
        } catch (error) {
            return c.json(error_body(describe_error(error)), 409);
        }
    });

    app.get("/sessions/:dir/threads", (c) => {
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const body: ThreadsResponse = { threads: actions.threads(deps.ctx, summary) };
        return c.json(body);
    });

    app.post("/sessions/:dir/threads/refresh", async (c) => {
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        try {
            const result = await actions.threads_refresh(deps.ctx, summary, no_log);
            publish_threads(deps, summary, result.diffs);
            await deps.refresh(summary.dir);
            const body: ThreadsResponse = { threads: result.view };
            return c.json(body);
        } catch (error) {
            return c.json(error_body(describe_error(error)), 502);
        }
    });

    app.post("/sessions/:dir/threads/:id/reply", async (c) => {
        const request = parse_thread_reply(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        return thread_action(c, deps, params(c), (summary, thread, pr) =>
            actions.thread_reply(deps.ctx, summary, { thread, ...pr, text: request.text }, no_log),
        );
    });

    app.post("/sessions/:dir/threads/:id/resolve", (c) =>
        thread_action(c, deps, params(c), (summary, thread, pr) =>
            actions.thread_resolve(deps.ctx, summary, { thread, ...pr }, no_log),
        ),
    );

    app.get("/sessions/:dir/post", (c) => {
        const summary = focused_session(c, deps);
        if (summary instanceof Response) {
            return summary;
        }
        const body: PostResponse = {
            post: actions.post_preview(deps.ctx, summary, c.req.query("to")),
        };
        return c.json(body);
    });

    app.post("/sessions/:dir/post", async (c) => {
        const request = parse_post(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const summary = focused_session(c, deps);
        if (summary instanceof Response) {
            return summary;
        }
        return start_job(c, deps, "post", summary.dir, (log) =>
            actions.post(deps.ctx, summary, request, log).then(() => {}),
        );
    });

    app.get("/sessions/:dir/approve", async (c) => {
        const summary = focused_session(c, deps);
        if (summary instanceof Response) {
            return summary;
        }
        try {
            const body: ApproveResponse = {
                approve: await actions.approve_preview(deps.ctx, summary),
            };
            return c.json(body);
        } catch (error) {
            return c.json(error_body(describe_error(error)), 502);
        }
    });

    app.post("/sessions/:dir/approve", async (c) => {
        const request = parse_approve(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const summary = focused_session(c, deps);
        if (summary instanceof Response) {
            return summary;
        }
        return start_job(c, deps, "approve", summary.dir, (log) =>
            actions.approve(deps.ctx, summary, request, log).then(() => {}),
        );
    });

    app.post("/sessions/:dir/land", async (c) => {
        const request = parse_land(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const summary = focused_session(c, deps);
        if (summary instanceof Response) {
            return summary;
        }
        // Not exclusive: a merge queue can hold a pull request for an hour, and the lead
        // must be able to open the next change's pull request meanwhile. The job writes
        // focused, and its one use of the worktree checks the branch first.
        const work: JobWork = (log) => actions.land(deps.ctx, summary, request, log).then(() => {});
        return start_job(c, deps, "land", summary.dir, work, { exclusive: false });
    });

    app.post("/sessions/:dir/changes", async (c) => {
        const request = parse_change_start(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        return start_job(c, deps, "change", summary.dir, (log) =>
            actions.change_start(deps.ctx, summary, request, log).then(() => {}),
        );
    });

    app.post("/sessions/:dir/changes/:id/switch", (c) => {
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const id = c.req.param("id") ?? "";
        if (!has_change(summary.session, id)) {
            return c.json(error_body(`no change ${id} in ${summary.dir}`), 404);
        }
        return start_job(c, deps, "change", summary.dir, (log) =>
            actions.change_switch(deps.ctx, summary, id, log).then(() => {}),
        );
    });

    app.post("/sessions/:dir/reset", async (c) => {
        const request = parse_reset(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        return start_job(c, deps, "reset", summary.dir, (log) =>
            actions.reset(deps.ctx, summary, request, log).then(() => {}),
        );
    });

    app.post("/sessions/:dir/threads/:id/flag", async (c) => {
        const request = parse_thread_flag(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        return thread_action(c, deps, params(c), async (summary, thread, pr) =>
            actions.thread_flag(
                deps.ctx,
                summary,
                { thread, ...pr, reason: request.reason },
                no_log,
            ),
        );
    });
}

/**
 * The session of the route, focused on the change `?change=<id>` names, or on its current
 * change (docs/designs/talk-change-ship.md, 2.7). A 404 response when either is unknown.
 */
function focused_session(c: Context, deps: PipelineRouteDeps): SessionSummary | Response {
    const dir = c.req.param("dir") ?? "";
    const summary = find_session(deps.home, dir);
    if (summary === null) {
        return c.json(error_body(`no session ${dir}`), 404);
    }
    const id = c.req.query("change") ?? current_change(summary.session).id;
    if (!has_change(summary.session, id)) {
        return c.json(error_body(`no change ${id} in ${summary.dir}`), 404);
    }
    return focus_summary(summary, id);
}

/**
 * Runs one thread write and answers with the thread, or 409 when a rule refuses it (no
 * reply yet, human thread, unknown label). `?pr=<repo>` disambiguates a label.
 */
function params(c: Context): { dir: string; id: string } {
    return { dir: c.req.param("dir") ?? "", id: c.req.param("id") ?? "" };
}

type ThreadWork = (
    summary: SessionSummary,
    thread: string,
    pr: { pr?: string },
) => Promise<ThreadResponse>;

async function thread_action(
    c: Context,
    deps: PipelineRouteDeps,
    ids: { dir: string; id: string },
    work: ThreadWork,
): Promise<Response> {
    const { dir, id } = ids;
    const summary = find_session(deps.home, dir);
    if (summary === null) {
        return c.json(error_body(`no session ${dir}`), 404);
    }
    const repo = c.req.query("pr");
    try {
        const body = await work(summary, id, repo === undefined ? {} : { pr: repo });
        publish_threads(deps, summary, [diff_for(body)]);
        await deps.refresh(summary.dir);
        return c.json(body);
    } catch (error) {
        return c.json(error_body(describe_error(error)), 409);
    }
}

/** The event for one thread write: the thread's new state as a one-label diff. */
function diff_for(body: ThreadResponse): ThreadsDiff {
    return {
        repo: body.repo,
        number: body.number,
        opened: [],
        resolved: body.thread.state === "resolved" ? [body.thread.label] : [],
        flagged: body.thread.flagged === null ? [] : [body.thread.label],
        file: thread_file(body.repo, body.number),
    };
}

function publish_threads(
    deps: PipelineRouteDeps,
    summary: SessionSummary,
    diffs: ThreadsDiff[],
): void {
    const ts = new Date().toISOString();
    for (const diff of diffs) {
        deps.bus.publish({ type: "threads.updated", ts, session: summary.dir, ...diff });
    }
}

/** Thread writes answer at once; their one-line log goes nowhere. */
const no_log = (): void => {};

/** Starts the job and answers 202, or 409 when the session is busy. */
function start_job(
    c: Context,
    deps: PipelineRouteDeps,
    action: JobAction,
    session: string,
    work: JobWork,
    options: { exclusive?: boolean } = {},
): Response {
    const refreshed: JobWork = async (log, set_session) => {
        try {
            await work(log, set_session);
        } finally {
            await deps.refresh(session);
        }
    };
    try {
        const job = deps.jobs.start(action, session, refreshed, options);
        const body: JobResponse = { job };
        return c.json(body, 202);
    } catch (error) {
        return c.json(error_body(describe_error(error)), 409);
    }
}

export function parse_pr(input: unknown): PrRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const request: PrRequest = {};
    const repos = record["repos"];
    if (repos !== undefined) {
        if (!Array.isArray(repos) || !repos.every((r) => typeof r === "string" && r.length > 0)) {
            return "`repos` must be a list of repo keys";
        }
        request.repos = repos as string[];
    }
    if (record["draft"] !== undefined) {
        if (typeof record["draft"] !== "boolean") {
            return "`draft` must be a boolean";
        }
        request.draft = record["draft"];
    }
    if (record["body"] !== undefined) {
        const body = record["body"];
        if (typeof body !== "string" || body.length > PR_BODY_MAX) {
            return `\`body\` must be text of at most ${PR_BODY_MAX} characters`;
        }
        request.body = body;
    }
    return request;
}

export function parse_fix(input: unknown): FixRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const pr = optional_string(record, "pr");
    if (typeof pr === "string") {
        return { pr };
    }
    return pr === undefined ? {} : "`pr` must be a repo key";
}

export function parse_review(input: unknown): ReviewRequest | string {
    if (input === undefined || input === null) {
        return {};
    }
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const pr = optional_string(record, "pr");
    if (typeof pr === "string") {
        return { pr };
    }
    return pr === undefined ? {} : "`pr` must be a repo key";
}

export function parse_thread_reply(input: unknown): ThreadReplyRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const text = optional_string(record, "text");
    return typeof text === "string" ? { text } : "`text` is required";
}

export function parse_thread_flag(input: unknown): ThreadFlagRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const reason = optional_string(record, "reason");
    return typeof reason === "string" ? { reason } : "`reason` is required";
}

export function parse_post(input: unknown): PostRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    if (record["confirm"] !== true) {
        return "`confirm: true` is required: post only sends what the operator confirmed";
    }
    const to = optional_string(record, "to");
    if (to !== undefined && typeof to !== "string") {
        return "`to` must be a Slack user id or @name";
    }
    return to === undefined ? { confirm: true } : { confirm: true, to };
}

export function parse_approve(input: unknown): ApproveRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    if (record["confirm"] !== true) {
        return "`confirm: true` is required: approve only submits what the operator saw";
    }
    const pr = optional_string(record, "pr");
    if (pr !== undefined && typeof pr !== "string") {
        return "`pr` must be a repo key";
    }
    return pr === undefined ? { confirm: true } : { confirm: true, pr };
}

export function parse_land(input: unknown): LandRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const pr = optional_string(record, "pr");
    if (typeof pr === "string") {
        return { pr };
    }
    return pr === undefined ? {} : "`pr` must be a repo key";
}

export function parse_change_start(input: unknown): ChangeStartRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const title = record["title"];
    if (typeof title !== "string" || title.trim().length === 0) {
        return "`title` is required: it names the change, its branch and its pull requests";
    }
    if (title.length > CHANGE_TITLE_MAX) {
        return `\`title\` must be at most ${CHANGE_TITLE_MAX} characters`;
    }
    const on = optional_string(record, "on");
    if (on !== undefined && typeof on !== "string") {
        return "`on` must be the id of a change";
    }
    return on === undefined ? { title: title.trim() } : { title: title.trim(), on };
}

/** GitHub refuses a pull request body past 65536 characters; the footer needs a little. */
const PR_BODY_MAX = 60_000;

/** A change's title is a pull request title; GitHub cuts longer ones in its lists. */
const CHANGE_TITLE_MAX = 120;

export function parse_reset(input: unknown): ResetRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const branch = optional_string(record, "branch");
    if (typeof branch === "string") {
        return { branch };
    }
    return branch === undefined ? {} : "`branch` must be a non-empty string";
}

/** An empty body is an empty object; `null` (unparsable JSON) and non-objects are errors. */
function as_record(input: unknown): Record<string, unknown> | string {
    if (input === undefined) {
        return {};
    }
    if (input === null) {
        return "body must be JSON";
    }
    if (typeof input !== "object" || Array.isArray(input)) {
        return "body must be a JSON object";
    }
    return input as Record<string, unknown>;
}

/** The string under `key`, `undefined` when absent, or `null` when present but not a string. */
function optional_string(record: Record<string, unknown>, key: string): string | undefined | null {
    const value = record[key];
    if (value === undefined) {
        return undefined;
    }
    return typeof value === "string" && value.length > 0 ? value : null;
}

/** The parsed JSON body, `undefined` for an empty body, or `null` for unparsable text. */
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
