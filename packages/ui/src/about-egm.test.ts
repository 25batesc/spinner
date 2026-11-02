// The About EGM state line, one test per fetch state (entry 1.37), and the reload key.
import {
    EGM_LICENSE,
    EGM_NOTICE,
    EGM_SOURCE_URL,
    type EgmStatus,
    type Job,
} from "@spinner/protocol";
import { expect, it } from "vitest";

import { egmKey, egmLine } from "./about-egm.ts";

const PIN = "a119668d7dc5d558664ba711d4671d11fb7270a8";

function status(partial: Partial<EgmStatus>): EgmStatus {
    return {
        state: "absent", pinned_sha: PIN, fetched_sha: null, fetched_at: null,
        adapter_version: null, error: null, source: EGM_SOURCE_URL, license: EGM_LICENSE,
        notice: EGM_NOTICE, subagents: true, ...partial,
    };
}

function job(id: string, started: string, state: Job["state"], action: Job["action"] = "egm"): Job {
    return { id, action, session: null, state, started, finished: null, log: [], error: null };
}

it("reads ready with the fetch date", () => {
    const ready = status({
        state: "ready", fetched_sha: PIN, fetched_at: "2026-10-30T09:00:00Z", adapter_version: 1,
    });
    expect(egmLine(ready)).toBe("ready · fetched 2026-10-30");
});

it("reads fetching", () => {
    expect(egmLine(status({ state: "fetching" }))).toBe("fetching…");
});

it("reads failed with the kept error", () => {
    const failed = status({ state: "failed", error: "git fetch exited 128" });
    expect(egmLine(failed)).toBe("failed: git fetch exited 128");
});

it("reads not fetched when absent", () => {
    expect(egmLine(status({ state: "absent" }))).toBe("not fetched");
});

it("names a missing pi-subagents after the state", () => {
    expect(egmLine(status({ state: "absent", subagents: false })))
        .toBe("not fetched · pi-subagents missing");
    const ready = status({ state: "ready", fetched_at: "2026-10-30T09:00:00Z", subagents: false });
    expect(egmLine(ready)).toBe("ready · fetched 2026-10-30 · pi-subagents missing");
});

it("keys on the last egm job and its state, ignoring other jobs", () => {
    expect(egmKey([])).toBe("egm#none#none");
    expect(egmKey([job("j-1", "2026-11-02T10:00:00Z", "ok", "diff")])).toBe("egm#none#none");
    const jobs = [
        job("j-2", "2026-11-02T10:00:00Z", "failed"),
        job("j-4", "2026-11-02T10:05:00Z", "running"),
        job("j-3", "2026-11-02T10:01:00Z", "ok", "diff"),
    ];
    expect(egmKey(jobs)).toBe("egm#j-4#running");
    expect(egmKey([jobs[0]!, { ...jobs[1]!, state: "ok" }])).toBe("egm#j-4#ok");
});
