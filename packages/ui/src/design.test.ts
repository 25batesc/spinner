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
    type SessionView,
} from "@spinner/protocol";
import { describe, expect, it } from "vitest";

import {
    BOOTSTRAP_BLOCKED, DRIFT_BLOCKED, RESOLVE_NEEDS, compactLabel, designPaths, designSteps,
    egmMenu, gateCard, primaryAction, showResolveCard, stepTitle, stepperText, trackChoices,
} from "./design.ts";

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

// The toolbar's design group and the gate cards (entries 3.18 and 3.24): the primary button
// per stage against the toolbar table of Technical Plan T13, the `EGM \u25be` menu per track,
// stage and round, and which card shows.

describe("primaryAction", () => {
    const table: [DesignStage, string | null, string | null][] = [
        ["intake", "brainstorm", "egm-brainstorm"],
        ["brainstorm", "draft", "egm-draft"],
        ["drafting", null, null],
        ["drafted", "review design", "egm-review"],
        ["design-review", null, null],
        ["resolving", null, null],
        // The approve kinds come with build session 6 (6.17).
        ["design-ready", null, null],
        ["approved", null, null],
    ];
    for (const [stage, label, skill] of table) {
        it(`gives ${label ?? "no button"} at ${stage}`, () => {
            const action = primaryAction(design(stage));
            if (label === null) {
                expect(action).toBeNull();
                return;
            }
            expect(action).toEqual({ label, kind: "run", skill });
        });
    }

    it("gives no button at design-ready after a change to an approved doc", () => {
        expect(primaryAction(design("design-ready", { changed_after_approval: true }))).toBeNull();
    });

    it("gives no button on the direct track", () => {
        expect(primaryAction(design(null, { track: "direct" }))).toBeNull();
    });
});

describe("egmMenu", () => {
    const labels = (items: { label: string }[]) => items.map((item) => item.label);

    it("lists all 7 skills on the design track, each with its field", () => {
        const items = egmMenu(design("drafted"), false);
        expect(items.map((item) => [item.label, item.skill, item.field])).toEqual([
            ["brainstorm", "egm-brainstorm", "concept"],
            ["draft", "egm-draft", null],
            ["review design", "egm-review", null],
            ["review loop", "egm-review-loop", "target"],
            ["resolve", "egm-resolve", "target"],
            ["drift report", "egm-drift-report", "dir"],
            ["bootstrap", "egm-bootstrap", "path"],
        ]);
    });

    it("disables only bootstrap on the design track before approval", () => {
        const items = egmMenu(design("drafted"), false);
        expect(items.filter((item) => item.disabled !== null).map((item) => item.label))
            .toEqual(["bootstrap"]);
        expect(items.find((item) => item.label === "bootstrap")?.disabled)
            .toBe(BOOTSTRAP_BLOCKED);
    });

    it("enables bootstrap on the design track once approved", () => {
        const items = egmMenu(design("approved"), false);
        expect(items.every((item) => item.disabled === null)).toBe(true);
    });

    it("lists drift report and bootstrap on the direct track, both enabled", () => {
        const items = egmMenu(design(null, { track: "direct" }), false);
        expect(labels(items)).toEqual(["drift report", "bootstrap"]);
        expect(items.every((item) => item.disabled === null)).toBe(true);
    });

    it("disables the drift report while a repo has commits in this round, on both tracks", () => {
        for (const view of [design("approved"), design(null, { track: "direct" })]) {
            const drift = egmMenu(view, true).find((item) => item.label === "drift report");
            expect(drift?.disabled).toBe(DRIFT_BLOCKED);
        }
    });
});

describe("showResolveCard and gateCard", () => {
    it("shows the resolve card at resolving once the lead settled", () => {
        expect(showResolveCard(design("resolving"), RESOLVE_NEEDS)).toBe(true);
        expect(gateCard(design("resolving"), RESOLVE_NEEDS)).toBe("resolve");
    });

    it("hides the resolve card while the lead still works", () => {
        expect(showResolveCard(design("resolving"), null)).toBe(false);
        expect(gateCard(design("resolving"), null)).toBeNull();
    });

    it("hides the resolve card at another stage with the same needs text", () => {
        expect(showResolveCard(design("design-review"), RESOLVE_NEEDS)).toBe(false);
    });

    it("shows the gate card while a gate is open, before the resolve card", () => {
        const asked = "2026-11-02T20:00:00Z";
        const gate = { question: "Which shape?", options: ["A", "B"], asked };
        expect(gateCard(design("resolving", { gate }), RESOLVE_NEEDS)).toBe("gate");
        expect(gateCard(design("approved", { gate }), null)).toBe("gate");
    });

    it("shows nothing without a design block", () => {
        expect(gateCard(undefined, RESOLVE_NEEDS)).toBeNull();
    });
});

describe("designPaths", () => {
    type Repos = SessionView["summary"]["session"]["repos"];
    function sessionView(partial: Partial<DesignView>, repos: Repos) {
        return {
            summary: {
                dir: "s1-csv", path: "/home/op/.spinner/sessions/s1-csv",
                session: { repos },
            },
            design: design("drafted", { doc: "docs/designs/csv-export.md", ...partial }),
        } as unknown as SessionView;
    }

    it("prefills the doc, the designs directory and the worktree root of the first repo", () => {
        const view = sessionView({}, {
            web: { path: "~/src/web", worktree: "web", changed: false },
            api: { path: "~/src/api", worktree: "api", changed: false },
        });
        expect(designPaths(view)).toEqual({
            doc: "/home/op/.spinner/sessions/s1-csv/web/docs/designs/csv-export.md",
            designs: "/home/op/.spinner/sessions/s1-csv/web/docs/designs",
            root: "/home/op/.spinner/sessions/s1-csv/web",
        });
    });

    it("takes the approval's repo when it has a worktree", () => {
        const approved = {
            path: "docs/designs/csv-export.md", repo: "api", sha256: "9f2c", at: "2026-11-02",
            blockers: 0, round: 1,
        };
        const view = sessionView({ approved }, {
            web: { path: "~/src/web", worktree: "web", changed: false },
            api: { path: "~/src/api", worktree: "./api/", changed: false },
        });
        expect(designPaths(view).root).toBe("/home/op/.spinner/sessions/s1-csv/api");
    });

    it("gives no doc before design_doc and nothing without a worktree", () => {
        const before = sessionView({ doc: null }, {
            web: { path: "~/src/web", worktree: "web", changed: false },
        });
        expect(designPaths(before).doc).toBeNull();
        const bare = sessionView({}, { web: { path: "~/src/web", changed: false } });
        expect(designPaths(bare)).toEqual({ doc: null, designs: null, root: null });
    });
});
