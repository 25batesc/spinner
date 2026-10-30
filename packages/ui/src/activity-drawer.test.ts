import type { Job } from "@spinner/protocol";
import { describe, expect, it } from "vitest";

import { drawerTitle, drawerTone } from "./ActivityDrawer.tsx";

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
