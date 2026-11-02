// The diff page's words and choices as a caller sees them: the repo it shows, when a start is
// for one repo, which job is the newest, and the progress and status lines.
import type { DiffRepoView, Job } from "@spinner/protocol";
import { describe, expect, it } from "vitest";

import { diffRepoStopped, initialSessions } from "../fixture/data.ts";
import {
    diffAnyRunning,
    diffJob,
    diffPreviewService,
    diffProgressLine,
    diffRepoLine,
    diffRepos,
    diffSelected,
} from "./diff-view.ts";
import { initialState, reduce } from "./state.ts";

const running: DiffRepoView = {
    ...diffRepoStopped(), state: "running", url: "http://127.0.0.1:17749/", pid: 4,
};

describe("diffRepos and diffSelected", () => {
    it("lists the fixture session's repos in order and picks the first by default", () => {
        const refund = initialSessions().find((s) => s.summary.dir === "s17-refund-flow");
        const repos = diffRepos(refund);
        expect(repos.map(([name]) => name)).toEqual(["web", "api"]);
        expect(diffSelected(repos, undefined)?.[0]).toBe("web");
        expect(diffSelected(repos, "api")?.[0]).toBe("api");
        expect(diffSelected(repos, "gone")?.[0]).toBe("web");
    });

    it("is empty for a view without `diff` (a daemon before s012)", () => {
        const boot = initialSessions().find((s) => s.summary.dir === "s001-bootstrap");
        const { diff, ...before } = boot!;
        expect(diff).toBeDefined();
        expect(diffRepos(before)).toEqual([]);
        expect(diffSelected([], undefined)).toBeUndefined();
    });

    it("says whether any viewer runs, which makes the next start a one-repo start", () => {
        expect(diffAnyRunning([["web", diffRepoStopped()]])).toBe(false);
        expect(diffAnyRunning([["web", diffRepoStopped()], ["api", running]])).toBe(true);
    });
});

describe("diffJob", () => {
    const job = (id: string, started: string, action: Job["action"] = "diff"): Job => ({
        id, action, session: "s17-refund-flow", state: "ok", started, finished: started,
        log: [], error: null,
    });

    it("returns the newest diff job of the session and ignores other actions", () => {
        const state = reduce(initialState, {
            kind: "jobs",
            jobs: [
                job("j-1", "2026-11-01T10:00:00Z"),
                job("j-2", "2026-11-01T11:00:00Z"),
                job("j-3", "2026-11-01T12:00:00Z", "up"),
                { ...job("j-4", "2026-11-01T13:00:00Z"), session: "s001-bootstrap" },
            ],
        });
        expect(diffJob(state, "s17-refund-flow")?.id).toBe("j-2");
        expect(diffJob(state, "s001-bootstrap")?.id).toBe("j-4");
        expect(diffJob(state, "nope")).toBeUndefined();
    });
});

describe("the lines", () => {
    const base: Job = {
        id: "j-1", action: "diff", session: "s17-refund-flow", state: "running",
        started: "2026-11-01T10:00:00Z", finished: null, log: [], error: null,
    };

    it("shows the job's state and its last log line, or its error once failed", () => {
        expect(diffProgressLine(base)).toBe("diff · running");
        expect(diffProgressLine({ ...base, log: ["cloning diff-viewer", "npm install"] }))
            .toBe("diff · running · npm install");
        expect(diffProgressLine({ ...base, state: "failed", log: ["x"], error: "exit 1" }))
            .toBe("diff · failed · exit 1");
    });

    it("names a repo's state, with the error when it failed", () => {
        expect(diffRepoLine("web", diffRepoStopped())).toBe("web is stopped.");
        expect(diffRepoLine("web", { ...diffRepoStopped(), state: "failed", error: "port taken" }))
            .toBe("web failed: port taken");
        expect(diffRepoLine("web", { ...diffRepoStopped(), state: "failed" }))
            .toBe("web failed: unknown error");
    });

    it("keeps the desktop key of a diff view apart from a service of the same name", () => {
        expect(diffPreviewService("web")).toBe("diff/web");
    });
});
