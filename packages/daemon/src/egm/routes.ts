// The EGM routes: the fetch state of the skills, a refetch job, and the transcript of one
// subagent step of the lead (a Goldfish of an EGM skill, or any other pi-subagents child).
// Mounted by one line in `server.ts`.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import type {
    AgentEventsResponse,
    EgmResponse,
    ErrorResponse,
    JobResponse,
} from "@spinner/protocol";
import { EGM_RUNS_DIR } from "@spinner/protocol";
import { events_of_transcript } from "../agents/history.js";
import type { SpinnerHome } from "../home.js";
import type { JobRunner, JobWork } from "../jobs/jobs.js";
import { read_session } from "../store/session-store.js";
import { type EgmFetcher, marker_path } from "./fetch.js";
import { inside_agents, read_runs } from "./goldfish.js";

export interface EgmRouteDeps {
    fetcher: EgmFetcher;
    jobs: JobRunner;
    home: SpinnerHome;
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
            const reason = error instanceof Error ? error.message : String(error);
            return c.json(error_body(reason), 409);
        }
    });

    app.get("/sessions/:dir/egm/goldfish/:run/:step/events", (c) => {
        const read = read_session(deps.home, c.req.param("dir"));
        if (!read.ok) {
            return c.json(error_body(read.error), 404);
        }
        const run_id = c.req.param("run");
        const index = Number(c.req.param("step"));
        const run = read_runs(join(read.summary.path, EGM_RUNS_DIR)).find(
            (entry) => entry.run === run_id,
        );
        const step = run?.steps.find((entry) => entry.index === index);
        const file = step?.session_file ?? null;
        if (file === null || !inside_agents(read.summary.path, file)) {
            return c.json(error_body(`no transcript for subagent ${run_id}/${index}`), 404);
        }
        const body: AgentEventsResponse = {
            events: events_of_transcript(readFileSync(file, "utf8")),
        };
        return c.json(body);
    });
}

function error_body(error: string): ErrorResponse {
    return { error };
}
