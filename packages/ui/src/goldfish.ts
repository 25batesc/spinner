// The Goldfish chips' rules (docs/designs/egm-adoption.md, entries 4.14, 4.17, 4.18, Technical
// Plan T5 and T6). A Goldfish is a pi-subagents child of the lead that the daemon observes
// through its `status.json`; `SessionView.design.goldfish` holds one `GoldfishView` per step.
// The chips show the newest runs only, so a long session's row stays one line or two.
import { GOLDFISH_LIVE_MAX, type GoldfishState, type GoldfishView } from "@spinner/protocol";

import { formatUsd } from "./costs.ts";
import type { DesignStep } from "./design.ts";

/** The chips row shows the steps of this many runs, the newest first (entry 4.14). */
export const GOLDFISH_CHIP_RUNS = 3;

/** The newest start among a run's steps, in ms; a run with no start sorts last. */
function runStart(steps: readonly GoldfishView[]): number {
    const starts = steps
        .map((step) => (step.started === null ? Number.NaN : Date.parse(step.started)))
        .filter((ms) => !Number.isNaN(ms));
    return starts.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...starts);
}

/**
 * The steps of the `count` newest runs: the runs newest first by their latest step start
 * (ties by run id, descending), each run's steps by step index.
 */
export function newestRuns(goldfish: readonly GoldfishView[], count: number): GoldfishView[] {
    const runs = new Map<string, GoldfishView[]>();
    for (const view of goldfish) {
        runs.set(view.run, [...(runs.get(view.run) ?? []), view]);
    }
    const ordered = [...runs.entries()].sort(([runA, stepsA], [runB, stepsB]) => {
        const byStart = runStart(stepsB) - runStart(stepsA);
        if (byStart !== 0 && !Number.isNaN(byStart)) {
            return byStart;
        }
        return runB.localeCompare(runA);
    });
    return ordered
        .slice(0, Math.max(0, count))
        .flatMap(([, steps]) => [...steps].sort((a, b) => a.step - b.step));
}

/** The chip's name: the EGM persona (`zoom_out`), else the agent (`egm-zoom-out`). */
export function chipLabel(view: GoldfishView): string {
    return view.persona ?? view.agent;
}

/** `850` → `0.9k`, `12_400` → `12k`: thousands, one decimal under 10k, none from 10k. */
export function tokensLabel(tokens: number): string {
    const thousands = Math.max(0, tokens) / 1000;
    const tenths = Math.round(thousands * 10) / 10;
    if (tenths < 10) {
        return `${tenths.toFixed(1)}k`;
    }
    return `${Math.round(thousands)}k`;
}

/**
 * The chip's tooltip: the agent, the model and the state. A failed chip says `not run`,
 * because EGM counts a failed reviewer as not run (`agents/synthesizer.md` "Failed Reviewers").
 */
export function chipTitle(view: GoldfishView): string {
    const model = view.model ?? "model unknown";
    const state = view.state === "failed" ? "failed, not run" : view.state;
    return `${view.agent} · ${model} · ${state} · ${tokensLabel(view.tokens)} tokens · ` +
        formatUsd(view.usd);
}

/** The chip's dot class, as the review chips: a ring while queued, green while running. */
export function goldfishDot(state: GoldfishState): string {
    const dots: Record<GoldfishState, string> = {
        queued: "dot-idle",
        running: "dot-working",
        done: "dot-up",
        failed: "dot-failed",
        stopped: "dot-off",
    };
    return dots[state];
}

/**
 * The line under the chips while the global cap (`GOLDFISH_LIVE_MAX`, D8) holds new skill
 * starts, else null. The daemon answers `POST …/design/run` with 409 at the same count.
 */
export function capLine(live: number): string | null {
    if (live < GOLDFISH_LIVE_MAX) {
        return null;
    }
    return `${live} Goldfish running across sessions; new skill starts wait`;
}

/** The superscript of a stepper step: its `running` Goldfish, Brainstorm and Review only. */
export function runningOn(goldfish: readonly GoldfishView[], step: DesignStep["id"]): number {
    if (step !== "brainstorm" && step !== "review") {
        return 0;
    }
    return goldfish.filter((view) => view.state === "running" && view.design_step === step)
        .length;
}

