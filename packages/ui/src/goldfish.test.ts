// The Goldfish chip rules (entries 4.14, 4.17, 4.18): which runs the row shows and in which
// order, the chip's label, tokens and tooltip, the cap line, and the stepper's running count.
// Each case builds `GoldfishView` values as the daemon sends them and reads the pure helpers.
import { describe, expect, it } from "vitest";

import { GOLDFISH_LIVE_MAX, type GoldfishView } from "@spinner/protocol";

import {
    capLine, chipLabel, chipTitle, goldfishDot, newestRuns, runningOn, tokensLabel,
} from "./goldfish.ts";

function fish(run: string, step: number, partial: Partial<GoldfishView> = {}): GoldfishView {
    return {
        run, step, agent: "egm-zoom-out", persona: "zoom_out", state: "done",
        model: "anthropic/claude-opus-5-5", tokens: 12_400, usd: 0.31,
        started: "2026-11-02T10:00:00Z", last_activity: null, design_step: "review",
        transcript: true, ...partial,
    };
}

const at = (minute: number) => `2026-11-02T10:${String(minute).padStart(2, "0")}:00Z`;

describe("newestRuns", () => {
    it("keeps the steps of the newest runs, newest run first, steps by index", () => {
        const goldfish = [
            fish("a", 0, { started: at(1) }),
            fish("c", 1, { started: at(30) }),
            fish("b", 0, { started: at(10) }),
            fish("c", 0, { started: at(29) }),
            fish("d", 0, { started: at(40) }),
        ];
        const keys = newestRuns(goldfish, 3).map((view) => `${view.run}/${view.step}`);
        expect(keys).toEqual(["d/0", "c/0", "c/1", "b/0"]);
    });

    it("dates a run by its latest step and sorts a run without a start last", () => {
        const goldfish = [
            fish("none", 0, { started: null }),
            fish("early", 0, { started: at(1) }),
            fish("early", 1, { started: at(50) }),
            fish("late", 0, { started: at(40) }),
        ];
        const runs = newestRuns(goldfish, 3).map((view) => view.run);
        expect(runs).toEqual(["early", "early", "late", "none"]);
    });

    it("breaks a tie by run id, descending, and returns nothing for a count of 0", () => {
        const goldfish = [fish("r1", 0), fish("r2", 0)];
        expect(newestRuns(goldfish, 3).map((view) => view.run)).toEqual(["r2", "r1"]);
        expect(newestRuns(goldfish, 0)).toEqual([]);
        expect(newestRuns([], 3)).toEqual([]);
    });
});

describe("chipLabel and tokensLabel", () => {
    it("names the persona, else the agent", () => {
        expect(chipLabel(fish("a", 0))).toBe("zoom_out");
        expect(chipLabel(fish("a", 0, { persona: null, agent: "scout" }))).toBe("scout");
    });

    it("writes thousands with one decimal under 10k and none from 10k", () => {
        expect(tokensLabel(0)).toBe("0.0k");
        expect(tokensLabel(850)).toBe("0.9k");
        expect(tokensLabel(9_940)).toBe("9.9k");
        expect(tokensLabel(9_960)).toBe("10k");
        expect(tokensLabel(12_400)).toBe("12k");
        expect(tokensLabel(250_600)).toBe("251k");
    });
});

describe("chipTitle and goldfishDot", () => {
    it("names the agent, the model, the state, the tokens and the cost", () => {
        expect(chipTitle(fish("a", 0))).toBe(
            "egm-zoom-out · anthropic/claude-opus-5-5 · done · 12k tokens · $0.31",
        );
    });

    it("says a failed Goldfish was not run, as EGM counts it", () => {
        const title = chipTitle(fish("a", 0, { state: "failed", model: null, usd: 0 }));
        expect(title).toBe("egm-zoom-out · model unknown · failed, not run · 12k tokens · $0.00");
    });

    it("gives each state its own dot", () => {
        const states = ["queued", "running", "done", "failed", "stopped"] as const;
        const dots = states.map(goldfishDot);
        expect(dots).toEqual(["dot-idle", "dot-working", "dot-up", "dot-failed", "dot-off"]);
    });
});

describe("capLine", () => {
    it("shows from the global cap on, with the count", () => {
        expect(GOLDFISH_LIVE_MAX).toBe(12);
        expect(capLine(11)).toBeNull();
        expect(capLine(0)).toBeNull();
        expect(capLine(12)).toBe("12 Goldfish running across sessions; new skill starts wait");
        expect(capLine(14)).toBe("14 Goldfish running across sessions; new skill starts wait");
    });
});

describe("runningOn", () => {
    const goldfish = [
        fish("b", 0, { state: "running", design_step: "brainstorm" }),
        fish("r", 0, { state: "running" }),
        fish("r", 1, { state: "running" }),
        fish("r", 2, { state: "failed" }),
        fish("d", 0, { state: "running", design_step: "draft" }),
    ];

    it("counts the running Goldfish of Brainstorm and Review", () => {
        expect(runningOn(goldfish, "brainstorm")).toBe(1);
        expect(runningOn(goldfish, "review")).toBe(2);
    });

    it("shows no count on the other steps", () => {
        expect(runningOn(goldfish, "draft")).toBe(0);
        expect(runningOn(goldfish, "approve")).toBe(0);
        expect(runningOn(goldfish, "build")).toBe(0);
        expect(runningOn([], "review")).toBe(0);
    });
});
