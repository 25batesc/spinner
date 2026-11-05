// The activity feed's lines (docs/designs/session-workspace.md, entry 2.25, D6). Method: feed
// one event of each kind the drawer trims to `describeEvent` and check it gives no line, then
// one event the drawer keeps and check its line.
import type { Job, SpinnerEvent } from "@spinner/protocol";
import { expect, it } from "vitest";

import { describeEvent } from "./describe.ts";

const ts = "2026-11-05T02:00:00Z";

it("gives no line for mission.changed and agent.settled", () => {
    const changed: SpinnerEvent = {
        type: "mission.changed", ts, session: "s46-workspace", author: "engine",
        sections: ["plan", "log"],
    };
    const settled: SpinnerEvent = {
        type: "agent.settled", ts, session: "s46-workspace", agent: "lead",
    };
    expect(describeEvent(changed)).toBeNull();
    expect(describeEvent(settled)).toBeNull();
});

it("still lines a finished job", () => {
    const job = { id: "j1", action: "up", session: "s46-workspace" } as unknown as Job;
    const finished: SpinnerEvent = {
        type: "job.finished", ts, session: "s46-workspace", job: "j1", ok: true, data: job,
    };
    expect(describeEvent(finished)).toBe("up finished");
});
