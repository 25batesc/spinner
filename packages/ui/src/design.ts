// The EGM stepper's rules (docs/designs/egm-adoption.md, entry 2.30, Technical Plan T7 and
// T13): which of the five steps is done, active, waiting or still to do, from the design
// stage that the daemon derives. The UI never derives the stage itself; it reads
// `SessionView.design` and maps it. This module is the one place that maps it, for the
// context bar and the session card.
import {
    DESIGN_DEFAULT_DIR,
    REVIEW_STAGE_REPORTS,
    type DesignStage,
    type DesignTrack,
    type DesignView,
    type EgmSkill,
    type EgmStatus,
    type ReviewStageId,
    type SessionView,
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

/**
 * `Review: active · Goldfish: $1.20`: a step's tooltip ends with its Goldfish cost from
 * `cost_by_stage`, `$0.00` before any (entry 4.17). Approve has no Goldfish, so no cost.
 */
export function stepTitle(step: DesignStep, design: DesignView): string {
    const id = step.id;
    const base = `${step.label}: ${step.state}`;
    if (id === "approve") {
        return base;
    }
    return `${base} · Goldfish: ${formatUsd(design.cost_by_stage[id] ?? 0)}`;
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

// The toolbar's design group (entry 3.18, Technical Plan T9 and T13): the one primary button
// per design stage, the `EGM \u25be` menu with the skills, and when the resolve card shows.

export type PrimaryAction =
    | { label: string; kind: "run"; skill: EgmSkill }
    | { label: string; kind: "approve" };

/**
 * The primary button per design stage, from the toolbar table of Technical Plan T13. The
 * stages where a skill runs (`drafting`, `design-review`) and `resolving`, where the resolve
 * card answers, have none. `design-ready` opens the approve dialog (entry 6.17), labelled
 * `re-approve design` after an edit invalidated the approval. A direct track (a null stage)
 * has none.
 */
export function primaryAction(design: DesignView): PrimaryAction | null {
    if (design.track !== "design") {
        return null;
    }
    switch (design.stage) {
        case "intake":
            return { label: "brainstorm", kind: "run", skill: "egm-brainstorm" };
        case "brainstorm":
            return { label: "draft", kind: "run", skill: "egm-draft" };
        case "drafted":
            return { label: "review design", kind: "run", skill: "egm-review" };
        case "design-ready":
            return {
                label: design.changed_after_approval ? "re-approve design" : "approve design",
                kind: "approve",
            };
        default:
            return null;
    }
}

/**
 * The one field a menu item asks for before it runs: the concept text of `brainstorm`, the
 * target file of `review loop` and `resolve`, the designs directory of `drift report`, the
 * path of `bootstrap`. Null: no field (`draft` runs at once; `review design` asks a preset).
 */
export type MenuField = "concept" | "target" | "dir" | "path" | null;

export interface MenuItem {
    label: string;
    skill: EgmSkill;
    field: MenuField;
    /** The tooltip of a disabled item, or null when the item runs. */
    disabled: string | null;
}

/** Technical Plan T9: the edit guard blocks README writes on the design track before approval. */
export const BOOTSTRAP_BLOCKED =
    "the design-only scope blocks README writes; use a direct-track session";

/** Technical Plan T14: the drift report reads the worktree, so it waits for a clean round. */
export const DRIFT_BLOCKED =
    "the worktree has this round's unlanded commits; run the drift report before the round's " +
    "first commit or after it lands";

/**
 * The `EGM \u25be` menu. The design track lists all 7 skills; the direct track lists only
 * `drift report` and `bootstrap`. `changed` is true when any repo of the session has commits
 * in this round, which disables the drift report.
 */
export function egmMenu(design: DesignView, changed: boolean): MenuItem[] {
    const drift: MenuItem = {
        label: "drift report", skill: "egm-drift-report", field: "dir",
        disabled: changed ? DRIFT_BLOCKED : null,
    };
    const guarded = design.track === "design" && design.stage !== "approved";
    const bootstrap: MenuItem = {
        label: "bootstrap", skill: "egm-bootstrap", field: "path",
        disabled: guarded ? BOOTSTRAP_BLOCKED : null,
    };
    if (design.track !== "design") {
        return [drift, bootstrap];
    }
    return [
        { label: "brainstorm", skill: "egm-brainstorm", field: "concept", disabled: null },
        { label: "draft", skill: "egm-draft", field: null, disabled: null },
        { label: "review design", skill: "egm-review", field: null, disabled: null },
        { label: "review loop", skill: "egm-review-loop", field: "target", disabled: null },
        { label: "resolve", skill: "egm-resolve", field: "target", disabled: null },
        drift,
        bootstrap,
    ];
}

/**
 * The skill of the session's current step (dogfood row 25, r4.6), which the ▾ half of the
 * split button marks: brainstorm while brainstorming, draft while drafting and once drafted,
 * review design under review, resolve while resolving. None at intake, at design-ready, once
 * approved, and on the direct track.
 */
export function currentSkill(design: DesignView): EgmSkill | null {
    if (design.track !== "design") {
        return null;
    }
    switch (design.stage) {
        case "brainstorm":
            return "egm-brainstorm";
        case "drafting":
        case "drafted":
            return "egm-draft";
        case "design-review":
            return "egm-review";
        case "resolving":
            return "egm-resolve";
        default:
            return null;
    }
}

/** One item of the split button's ▾ half: a menu item, marked when it is the current step. */
export interface SplitItem extends MenuItem {
    current: boolean;
}

/**
 * The ▾ half of the design group's split button (row 25): the menu's skills without the one
 * the primary half runs, so nothing is listed twice, with the current step's skill marked.
 */
export function splitMenu(design: DesignView, changed: boolean): SplitItem[] {
    const primary = primaryAction(design);
    const shown = primary?.kind === "run" ? primary.skill : null;
    const current = currentSkill(design);
    return egmMenu(design, changed)
        .filter((item) => item.skill !== shown)
        .map((item) => ({ ...item, current: item.skill === current }));
}

// The approve dialog's words (entry 6.16, D2 and D5).

/** The dialog's confirm button: `approve and build` while `start the build` is checked. */
export function approveLabel(build: boolean): string {
    return build ? "approve and build" : "approve";
}

/** `blocker` for 1, `blockers` otherwise. */
function blockerNoun(count: number): string {
    return count === 1 ? "blocker" : "blockers";
}

/** The line over the second confirm, after a 409 that names the listed blockers. */
export function blockersLine(count: number): string {
    return `The newest review report lists ${count} ${blockerNoun(count)}.`;
}

/** The second confirm button, which posts again with `blockers_confirmed`. */
export function blockersLabel(count: number): string {
    return `approve with ${count} listed ${blockerNoun(count)}`;
}

/** The `needs_human` text the daemon sets at `resolving` once the lead settled (T7, line 2). */
export const RESOLVE_NEEDS = "resolve the review findings";

/** True when the resolve card shows: stage `resolving` and the lead has settled (T8). */
export function showResolveCard(design: DesignView, needs: string | null): boolean {
    return design.stage === "resolving" && needs === RESOLVE_NEEDS;
}

/**
 * Which card the agents view shows above the chips (entry 3.22): the gate card while a gate is
 * open, else the resolve card when `showResolveCard`, else none.
 */
export function gateCard(design: DesignView | undefined, needs: string | null) {
    if (design === undefined) {
        return null;
    }
    if (design.gate !== null) {
        return "gate" as const;
    }
    return showResolveCard(design, needs) ? ("resolve" as const) : null;
}

/** The absolute paths the menu's dialogs prefill. Null when the session has no worktree. */
export interface DesignPaths {
    /** The design doc, or null before `design_doc`. */
    doc: string | null;
    /** The designs directory. */
    designs: string | null;
    /** The worktree root. */
    root: string | null;
}

/**
 * The prefills of the menu's dialogs. The doc's repo is `design.repo` (the doc's repo, else
 * the designs repo), and the designs directory is `design.designs_dir`, both from the daemon.
 * A daemon before 0df3a92 sends neither: then this takes the approval's repo, else the first
 * repo with a worktree, and `DESIGN_DEFAULT_DIR` in it. The operator confirms or edits each
 * value before the run; the daemon composes the arguments of `draft` and `review` itself.
 */
export function designPaths(view: SessionView): DesignPaths {
    const repos = view.summary.session.repos;
    const hasWorktree = (name: string | null | undefined): name is string =>
        typeof name === "string" && repos[name]?.worktree !== undefined;
    const named = [view.design?.repo, view.design?.approved?.repo].find(hasWorktree);
    const key = named ?? Object.keys(repos).find(hasWorktree);
    const worktree = key === undefined ? undefined : repos[key]?.worktree;
    if (worktree === undefined) {
        return { doc: null, designs: view.design?.designs_dir ?? null, root: null };
    }
    const root = joinPath(view.summary.path, worktree);
    const doc = view.design?.doc ?? null;
    return {
        doc: doc === null ? null : joinPath(root, doc),
        designs: view.design?.designs_dir ?? joinPath(root, DESIGN_DEFAULT_DIR),
        root,
    };
}

/** `a/b` + `./c/` is `a/b/c`: one slash between the parts, none at the end. */
function joinPath(base: string, relative: string): string {
    const head = base.replace(/\/+$/, "");
    const tail = relative.replace(/^(\.\/)+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
    return tail === "" ? head : `${head}/${tail}`;
}
