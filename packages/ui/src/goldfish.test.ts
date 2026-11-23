// The subagent row's label and token count. Each case builds a `GoldfishView` as the daemon
// sends it and reads the pure helpers.
import { describe, expect, it } from "vitest";

import type { GoldfishView } from "@spinner/protocol";

import { chipLabel, tokensLabel } from "./goldfish.ts";

function fish(run: string, step: number, partial: Partial<GoldfishView> = {}): GoldfishView {
    return {
        run, step, agent: "egm-zoom-out", persona: "zoom_out", state: "done",
        model: "anthropic/claude-opus-5-5", tokens: 12_400, usd: 0.31,
        started: "2026-11-02T10:00:00Z", last_activity: null, transcript: true, ...partial,
    };
}

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
