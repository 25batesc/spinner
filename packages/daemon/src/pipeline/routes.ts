// The pipeline commands' routes (`pr`, `fix`, `threads`, `post`, `approve`, `land`, `reset`),
// mounted on the daemon's Hono app by one registry line in `server.ts`. Each write starts a
// job on `actions.ts`, the same functions the CLI calls; each read answers from the session
// directory. Bodies are parsed here, so a bad request is a 400 before any job starts.
import type { Hono, Context } from "hono";
import type {
    ApproveRequest,
    ErrorResponse,
    FixRequest,
    JobAction,
    JobResponse,
    LandRequest,
    PostRequest,
    PrRequest,
    ResetRequest,
} from "@spinner/protocol";
import * as actions from "../actions.js";
import type { ActionContext } from "../actions.js";
import type { EventBus } from "../event-bus.js";
import type { SpinnerHome } from "../home.js";
import type { JobRunner, JobWork } from "../jobs/jobs.js";
import { find_session } from "../store/session-store.js";

/** What the routes need from the daemon; `server.ts` passes its `AppDeps` plus the bus. */
export interface PipelineRouteDeps {
    home: SpinnerHome;
    ctx: ActionContext;
    jobs: JobRunner;
    bus: EventBus;
    /** Called after a job on `dir` finished, so the view carries fresh facts. */
    refresh: (dir: string) => Promise<void>;
}

export function mount_pipeline_routes(app: Hono, deps: PipelineRouteDeps): void {
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
}

/** Starts the job and answers 202, or 409 when the session is busy. */
function start_job(
    c: Context,
    deps: PipelineRouteDeps,
    action: JobAction,
    session: string,
    work: JobWork,
): Response {
    const refreshed: JobWork = async (log, set_session) => {
        try {
            await work(log, set_session);
        } finally {
            await deps.refresh(session);
        }
    };
    try {
        const job = deps.jobs.start(action, session, refreshed);
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
