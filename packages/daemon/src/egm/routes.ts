// The EGM routes (docs/designs/egm-adoption.md, 1.12, 2.24): the fetch state and a refetch
// job, the design track and the lead's design doc. Build sessions 3 to 6 widen
// `EgmRouteDeps`; each entry that does names the new fields. Mounted by one line in
// `server.ts`.
import { rmSync } from "node:fs";
import type { Context, Hono } from "hono";
import type {
    DesignTrack,
    EgmResponse,
    ErrorResponse,
    JobResponse,
    SessionResponse,
} from "@spinner/protocol";
import { DESIGN_TRACKS } from "@spinner/protocol";
import { set_design_track, type ActionContext } from "../actions.js";
import type { JobRunner, JobWork } from "../jobs/jobs.js";
import type { MissionWriter } from "../store/mission-writer.js";
import { read_session } from "../store/session-store.js";
import type { ViewBuilder } from "../watcher.js";
import { DesignDocConflict, DesignDocRefused, type DesignTracker } from "./design.js";
import { type EgmFetcher, marker_path } from "./fetch.js";

export interface EgmRouteDeps {
    fetcher: EgmFetcher;
    jobs: JobRunner;
    design: DesignTracker;
    ctx: ActionContext;
    view: ViewBuilder;
    /** The daemon's one mission writer, for `set_design_track`. */
    writer: MissionWriter;
}

export function mount_egm_routes(app: Hono, deps: EgmRouteDeps): void {
    app.get("/egm", (c) => {
        const body: EgmResponse = { egm: deps.fetcher.status() };
        return c.json(body);
    });

    app.post("/egm/fetch", (c) => {
        const work: JobWork = async (log) => {
            // A refetch: without the marker `ensure` clones the pin again.
            rmSync(marker_path(deps.fetcher.home), { force: true });
            const ok = await deps.fetcher.ensure(log);
            if (!ok) {
                throw new Error(deps.fetcher.status().error ?? "the EGM fetch failed");
            }
        };
        try {
            const job = deps.jobs.start("egm", null, work);
            const body: JobResponse = { job };
            return c.json(body, 202);
        } catch (error) {
            return c.json(error_body(describe_error(error)), 409);
        }
    });

    app.put("/sessions/:dir/design/track", async (c) => {
        const dir = c.req.param("dir");
        const track = field(await json_body(c), "track");
        if (track === null || !(DESIGN_TRACKS as readonly string[]).includes(track)) {
            return c.json(error_body(`track must be one of ${DESIGN_TRACKS.join(", ")}`), 400);
        }
        const read = read_session(deps.ctx.home, dir);
        if (!read.ok) {
            return c.json(error_body(read.error), 404);
        }
        const egm = deps.fetcher.status();
        const next = track as DesignTrack;
        try {
            await set_design_track(deps.ctx, deps.writer, read.summary, next, egm);
        } catch (error) {
            return c.json(error_body(describe_error(error)), 409);
        }
        await deps.design.refresh(dir);
        return session_response(c, deps, dir);
    });

    app.put("/sessions/:dir/design/doc", async (c) => {
        const dir = c.req.param("dir");
        const path = field(await json_body(c), "path");
        if (path === null || path.trim().length === 0) {
            return c.json(error_body("path must be a non-empty string"), 400);
        }
        const read = read_session(deps.ctx.home, dir);
        if (!read.ok) {
            return c.json(error_body(read.error), 404);
        }
        if (read.summary.session.design?.track !== "design") {
            return c.json(error_body("this session is not on the design track"), 409);
        }
        try {
            await deps.design.set_doc(dir, path.trim());
        } catch (error) {
            if (error instanceof DesignDocRefused) {
                return c.json(error_body(error.message), 400);
            }
            if (error instanceof DesignDocConflict) {
                return c.json(error_body(error.message), 409);
            }
            throw error;
        }
        return session_response(c, deps, dir);
    });
}

function session_response(c: Context, deps: EgmRouteDeps, dir: string): Response {
    const read = read_session(deps.ctx.home, dir);
    if (!read.ok) {
        return c.json(error_body(read.error), 404);
    }
    const body: SessionResponse = { session: deps.view(read.summary) };
    return c.json(body);
}

/** A string field of a JSON object body, or null. */
function field(body: unknown, key: string): string | null {
    if (typeof body !== "object" || body === null) {
        return null;
    }
    const value = (body as Record<string, unknown>)[key];
    return typeof value === "string" ? value : null;
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
