// The EGM stepper's rules (entry 2.31): one case per design stage against the stepper table
// of Technical Plan T7, the waiting case, the folded label, the tooltip, and the track
// choices for EGM ready, not ready and without pi-subagents. Each case builds a `DesignView`
// as the daemon sends it and reads the steps a caller sees.
import {
    EGM_LICENSE,
    EGM_NOTICE,
    EGM_SOURCE_URL,
    type DesignStage,
    type DesignView,
    type EgmStatus,
} from "@spinner/protocol";
import { describe, expect, it } from "vitest";

import { compactLabel, designSteps, stepTitle, stepperText, trackChoices } from "./design.ts";

function design(stage: DesignStage | null, partial: Partial<DesignView> = {}): DesignView {
    return {
        track: "design", stage, files: [],
        reviews: { "5": false, "6": false, "7": false, "8": false, "9": false },
        consolidated: false, resolve: "none", review_run: null, doc: null, doc_missing: false,
        approved: null, approvals: [], changed_after_approval: false, gate: null, goldfish: [],
        goldfish_live: 0, cost_by_stage: {}, ...partial,
    };
}

const states = (stage: DesignStage | null, needs: string | null = null) =>
    designSteps(design(stage), needs).map((step) => step.state);

describe("designSteps", () => {
    it("names the five steps in order with their labels", () => {
        const steps = designSteps(design("intake"), null);
        expect(steps.map((step) => step.id)).toEqual(
            ["brainstorm", "draft", "review", "approve", "build"],
        );
        expect(steps.map((step) => step.label)).toEqual(
            ["Brainstorm", "Draft", "Review", "Approve", "Build"],
        );
    });

    const table: [DesignStage, string[]][] = [
        ["intake", ["todo", "todo", "todo", "todo", "todo"]],
        ["brainstorm", ["active", "todo", "todo", "todo", "todo"]],
        ["drafting", ["done", "active", "todo", "todo", "todo"]],
        ["drafted", ["done", "done", "todo", "todo", "todo"]],
        ["design-review", ["done", "done", "active", "todo", "todo"]],
        ["resolving", ["done", "done", "active", "todo", "todo"]],
        ["design-ready", ["done", "done", "done", "active", "todo"]],
        ["approved", ["done", "done", "done", "done", "active"]],
    ];
    for (const [stage, wanted] of table) {
        it(`maps ${stage}`, () => {
            expect(states(stage)).toEqual(wanted);
        });
    }

    it("reads a null stage as intake", () => {
        expect(states(null)).toEqual(["todo", "todo", "todo", "todo", "todo"]);
    });

    it("turns the active step to waiting when the session needs the operator", () => {
        expect(states("design-ready", "approve the design")).toEqual(
            ["done", "done", "done", "waiting", "todo"],
        );
    });

    it("leaves drafted without an active step even when the session needs the operator", () => {
        expect(states("drafted", "review the design")).toEqual(
            ["done", "done", "todo", "todo", "todo"],
        );
    });

    it("gives the Review step one dot per stage report 5 to 9, and no other step dots", () => {
        const reviews = { "5": true, "6": true, "7": true, "8": false, "9": false };
        const steps = designSteps(design("design-review", { reviews }), null);
        expect(steps.find((step) => step.id === "review")?.dots).toEqual(
            [true, true, true, false, false],
        );
        expect(steps.filter((step) => step.dots !== undefined)).toHaveLength(1);
    });
});

describe("compactLabel", () => {
    it("names the first step that is not done", () => {
        expect(compactLabel(designSteps(design("design-review"), null))).toBe("EGM 3/5 Review");
    });

    it("names Brainstorm at intake", () => {
        expect(compactLabel(designSteps(design("intake"), null))).toBe("EGM 1/5 Brainstorm");
    });

    it("names Build once approved", () => {
        expect(compactLabel(designSteps(design("approved"), null))).toBe("EGM 5/5 Build");
    });
});

describe("stepTitle and stepperText", () => {
    it("adds the Goldfish cost of the step when the view has one", () => {
        const view = design("design-review", { cost_by_stage: { review: 1.2 } });
        const [, draft, review] = designSteps(view, null);
        expect(stepTitle(review!, view)).toBe("Review: active · Goldfish $1.20");
        expect(stepTitle(draft!, view)).toBe("Draft: done");
    });

    it("writes every step in one line for the folded tooltip", () => {
        expect(stepperText(designSteps(design("drafting"), null))).toBe(
            "1 Brainstorm done · 2 Draft active · 3 Review todo · 4 Approve todo · 5 Build todo",
        );
    });
});

function egm(partial: Partial<EgmStatus>): EgmStatus {
    return {
        state: "ready", pinned_sha: "a119668d7dc5", fetched_sha: "a119668d7dc5",
        fetched_at: "2026-10-30T09:00:00Z", adapter_version: 1, error: null,
        source: EGM_SOURCE_URL, license: EGM_LICENSE, notice: EGM_NOTICE, subagents: true,
        ...partial,
    };
}

describe("trackChoices", () => {
    it("offers design and direct when EGM is ready with pi-subagents", () => {
        expect(trackChoices(egm({}))).toEqual(["design", "direct"]);
    });

    it("offers only direct when EGM is not ready", () => {
        expect(trackChoices(egm({ state: "failed", error: "git exited 128" }))).toEqual(["direct"]);
        expect(trackChoices(egm({ state: "absent" }))).toEqual(["direct"]);
    });

    it("offers only direct without pi-subagents", () => {
        expect(trackChoices(egm({ subagents: false }))).toEqual(["direct"]);
    });

    it("offers only direct before GET /egm answers", () => {
        expect(trackChoices(null)).toEqual(["direct"]);
    });
});
