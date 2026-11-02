// The EGM routes (docs/designs/egm-adoption.md, 1.12): the fetch state and a refetch job.
// Build sessions 2 to 6 widen `EgmRouteDeps`; each entry that does names the new fields.
// Mounted by one line in `server.ts`.
import { rmSync } from "node:fs";
import type { Hono } from "hono";
import type { EgmResponse, ErrorResponse, JobResponse } from "@spinner/protocol";
import type { JobRunner, JobWork } from "../jobs/jobs.js";
import { type EgmFetcher, marker_path } from "./fetch.js";

export interface EgmRouteDeps {
    fetcher: EgmFetcher;
    jobs: JobRunner;
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
            const body: ErrorResponse = {
                error: error instanceof Error ? error.message : String(error),
            };
            return c.json(body, 409);
        }
    });
}
