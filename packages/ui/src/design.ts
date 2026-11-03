// The EGM stepper's rules (docs/designs/egm-adoption.md, entry 2.30, Technical Plan T7 and
// T13): which of the five steps is done, active, waiting or still to do, from the design
// stage that the daemon derives. The UI never derives the stage itself; it reads
// `SessionView.design` and maps it. This module is the one place that maps it, for the
// context bar and the session card.
import {
    REVIEW_STAGE_REPORTS,
    type DesignStage,
    type DesignTrack,
    type DesignView,
    type EgmStatus,
    type ReviewStageId,
} from "@spinner/protocol";

import { formatUsd } from "./costs.ts";

export type StepState = "todo" | "active" | "waiting" | "done";

export type StepId = "brainstorm" | "draft" | "review" | "approve" | "build";

export interface DesignStep {
    id: StepId;
    label: string;
    state: StepState;
    /** The Review step only: one dot per `egm-review` stage 5 to 9, true once its report exists. */
    dots?: boolean[];
}

/** The five steps in order, with the label the stepper shows (Technical Plan T13). */
export const DESIGN_STEPS: readonly { id: StepId; label: string }[] = [
    { id: "brainstorm", label: "Brainstorm" },
    { id: "draft", label: "Draft" },
    { id: "review", label: "Review" },
    { id: "approve", label: "Approve" },
    { id: "build", label: "Build" },
];

/**
 * Per design stage: how many steps are done, and the index of the active step (null when no
 * step is active). The stepper table of Technical Plan T7. `drafted` has Draft done and no
 * active step, because the operator starts the review.
 */
const STAGE_STEPS: Record<DesignStage, { done: number; active: number | null }> = {
    intake: { done: 0, active: null },
    brainstorm: { done: 0, active: 0 },
    drafting: { done: 1, active: 1 },
    drafted: { done: 2, active: null },
    "design-review": { done: 2, active: 2 },
    resolving: { done: 2, active: 2 },
    "design-ready": { done: 3, active: 3 },
    approved: { done: 4, active: 4 },
};

/** The review stage ids 5 to 9, in order. */
const REVIEW_STAGE_IDS = Object.keys(REVIEW_STAGE_REPORTS).sort() as ReviewStageId[];

/**
 * The five steps of a design-track session. An active step is `waiting` when `needs` is not
 * null: the session waits on the operator. A null stage (the view of a direct track) reads as
 * `intake`, every step to do.
 */
export function designSteps(design: DesignView, needs: string | null): DesignStep[] {
    const rule = STAGE_STEPS[design.stage ?? "intake"];
    const dots = REVIEW_STAGE_IDS.map((id) => design.reviews[id]);
    return DESIGN_STEPS.map((step, index) => {
        let state: StepState = "todo";
        if (index < rule.done) {
            state = "done";
        } else if (index === rule.active) {
            state = needs === null ? "active" : "waiting";
        }
        return step.id === "review" ? { ...step, state, dots } : { ...step, state };
    });
}

/** `EGM 3/5 Review`: the first step that is not done, for the folded stepper. */
export function compactLabel(steps: readonly DesignStep[]): string {
    const index = steps.findIndex((step) => step.state !== "done");
    const shown = index === -1 ? steps.length - 1 : index;
    return `EGM ${shown + 1}/${steps.length} ${steps[shown]?.label ?? ""}`.trim();
}

/** `Review: active · Goldfish $1.20`: a step's tooltip, with its Goldfish cost when known. */
export function stepTitle(step: DesignStep, design: DesignView): string {
    const id = step.id;
    const usd = id === "approve" ? undefined : design.cost_by_stage[id];
    const cost = usd === undefined ? "" : ` · Goldfish ${formatUsd(usd)}`;
    return `${step.label}: ${step.state}${cost}`;
}

/** The full stepper in one line, the tooltip of the folded form. */
export function stepperText(steps: readonly DesignStep[]): string {
    return steps.map((step, index) => `${index + 1} ${step.label} ${step.state}`).join(" · ");
}

/**
 * The tracks the track chip offers: `design` only when EGM is fetched and pi-subagents is
 * installed, as the track route requires; `direct` always.
 */
export function trackChoices(egm: EgmStatus | null): DesignTrack[] {
    if (egm?.state === "ready" && egm.subagents) {
        return ["design", "direct"];
    }
    return ["direct"];
}
