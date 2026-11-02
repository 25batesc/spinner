// The diff tab's routes (MISSION.md s012, Contracts): `start` is a job that fetches the
// viewer on first use and then starts one viewer per repo; `stop` is synchronous; the agent
// route runs `diffview comments` in the agent's worktree. Mounted by one line in `server.ts`.
import type { Context, Hono } from "hono";
import type {
    DiffRepoRequest,
    ErrorResponse,
    JobResponse,
    SessionResponse,
    SessionSummary,
} from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";
import type { JobRunner, JobWork } from "../jobs/jobs.js";
import { find_session } from "../store/session-store.js";
import type { ViewBuilder } from "../watcher.js";
import { type DiffManager, UnknownRepoError } from "./manager.js";

export interface DiffRouteDeps {
    home: SpinnerHome;
    diff: DiffManager;
    jobs: JobRunner;
    view: ViewBuilder;
    /** Called after a job on `dir` finished, so the view carries fresh facts. */
    refresh: (dir: string) => Promise<void>;
}

export function mount_diff_routes(app: Hono, deps: DiffRouteDeps): void {
    app.post("/sessions/:dir/diff/start", async (c) => {
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const request = parse_repo_request(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const unknown = unknown_repo(summary, request.repo);
        if (unknown !== null) {
            return c.json(error_body(unknown), 404);
        }
        const work: JobWork = async (log) => {
            try {
                await deps.diff.start(summary, request.repo, log);
            } finally {
                await deps.refresh(summary.dir);
            }
        };
        try {
            const job = deps.jobs.start("diff", summary.dir, work);
            const body: JobResponse = { job };
            return c.json(body, 202);
        } catch (error) {
            return c.json(error_body(error instanceof Error ? error.message : String(error)), 409);
        }
    });

    app.post("/sessions/:dir/diff/stop", async (c) => {
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const request = parse_repo_request(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        try {
            await deps.diff.stop(summary, request.repo, () => {});
        } catch (error) {
            if (error instanceof UnknownRepoError) {
                return c.json(error_body(error.message), 404);
            }
            throw error;
        }
        await deps.refresh(summary.dir);
        const fresh = find_session(deps.home, summary.dir) ?? summary;
        const body: SessionResponse = { session: deps.view(fresh) };
        return c.json(body);
    });
}

function unknown_repo(summary: SessionSummary, repo: string | undefined): string | null {
    if (repo === undefined) {
        return null;
    }
    if (summary.session.repos?.[repo] === undefined) {
        return `session ${summary.dir} has no repo ${repo}`;
    }
    return null;
}

/** An empty or absent body is "every repo". */
function parse_repo_request(input: unknown): DiffRepoRequest | string {
    if (input === undefined) {
        return {};
    }
    if (input === null || typeof input !== "object") {
        return "body must be a JSON object";
    }
    const repo = (input as Record<string, unknown>)["repo"];
    if (repo === undefined) {
        return {};
    }
    if (typeof repo !== "string" || repo.length === 0) {
        return "`repo` must be a non-empty string";
    }
    return { repo };
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
