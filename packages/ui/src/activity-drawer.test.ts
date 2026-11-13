import type { Job } from "@spinner/protocol";
import { describe, expect, it } from "vitest";

import {
    activityLabel,
    drawerOpens,
    drawerTitle,
    drawerTone,
    type DrawerWatch,
} from "./ActivityDrawer.tsx";

const job = (state: Job["state"]): Job => ({
    id: "j-1", action: "up", session: "s1-a", state, started: "t", finished: null,
    log: [], error: null,
});

describe("the drawer's job line and tone", () => {
    it("names the job and its state, the failed action, or nothing", () => {
        expect(drawerTitle(job("failed"), null)).toBe("up · failed");
        expect(drawerTitle(undefined, "POST failed")).toBe("action failed");
        expect(drawerTitle(undefined, null)).toBeNull();
    });

    it("is red for a failed job, amber for a failed action, plain otherwise", () => {
        expect(drawerTone(job("failed"), null)).toBe("failed");
        expect(drawerTone(undefined, "POST failed")).toBe("error");
        expect(drawerTone(job("running"), null)).toBeNull();
        expect(drawerTone(job("ok"), "stale")).toBeNull();
    });
});

describe("the drawer opens itself only for what needs the operator (row 4)", () => {
    const quiet: DrawerWatch = {
        jobId: null, jobState: null, error: null, dir: "s1-a", needs: null,
    };
    const watch = (partial: Partial<DrawerWatch>): DrawerWatch => ({ ...quiet, ...partial });

    it("stays shut for a job that starts, runs and ends ok", () => {
        const running = watch({ jobId: "j-1", jobState: "running" });
        expect(drawerOpens(quiet, running)).toBe(false);
        expect(drawerOpens(running, watch({ jobId: "j-1", jobState: "ok" }))).toBe(false);
    });

    it("opens when the watched job fails, once", () => {
        const running = watch({ jobId: "j-1", jobState: "running" });
        const failed = watch({ jobId: "j-1", jobState: "failed" });
        expect(drawerOpens(running, failed)).toBe(true);
        expect(drawerOpens(failed, failed)).toBe(false);
        expect(drawerOpens(quiet, watch({ jobId: "j-2", jobState: "failed" }))).toBe(true);
    });

    it("opens when an action fails before it becomes a job", () => {
        expect(drawerOpens(quiet, watch({ error: "POST /up: 409" }))).toBe(true);
        const failed = watch({ error: "POST /up: 409" });
        expect(drawerOpens(failed, failed)).toBe(false);
    });

    it("stays shut when the shown session's needs_human turns from none to a line", () => {
        expect(drawerOpens(quiet, watch({ needs: "verify locally" }))).toBe(false);
        const needs = watch({ needs: "verify locally" });
        expect(drawerOpens(needs, watch({ needs: "approve the design" }))).toBe(false);
        expect(drawerOpens(needs, quiet)).toBe(false);
    });

    it("stays shut when the operator selects a session that already needs him", () => {
        expect(drawerOpens(quiet, watch({ dir: "s2-b", needs: "verify locally" }))).toBe(false);
        expect(drawerOpens(watch({ dir: null }), watch({ needs: "verify" }))).toBe(false);
    });
});

it("labels the activity tab with what the watched job does", () => {
    expect(activityLabel(undefined, null)).toBe("activity");
    expect(activityLabel(job("running"), null)).toBe("activity · running");
    expect(activityLabel(job("failed"), null)).toBe("activity · failed");
    expect(activityLabel(undefined, "POST /x failed (409)")).toBe("activity · failed");
    expect(activityLabel(job("ok"), null)).toBe("activity");
});
