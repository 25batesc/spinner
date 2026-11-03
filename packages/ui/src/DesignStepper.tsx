// The EGM stepper in the context bar (docs/designs/egm-adoption.md, entry 2.32, Technical Plan
// T13): the `EGM` label with the attribution as its tooltip, the five steps with their state,
// the five Review dots for `egm-review` stages 5 to 9, then the pipeline stage as a pill.
// Each step's tooltip ends with its Goldfish cost; Brainstorm and Review carry their running
// Goldfish as a superscript digit (entry 4.17).
// Under `TOOLBAR_COMPACT_PX` it folds to `EGM 3/5 Review` with the whole stepper in the
// tooltip, so the context bar keeps one line. It also folds while the full stepper would push
// the bar past its width or cut the title under `TITLE_MIN_PX`: the toolbar's design group of
// build session 3 made the bar of a design session wider than a 1500 px window.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { EGM_NOTICE, type DesignView } from "@spinner/protocol";

import {
    compactLabel, designSteps, stepperText, stepTitle, type DesignStep, type StepId,
} from "./design.ts";
import { runningOn } from "./goldfish.ts";
import { useCompact } from "./SessionToolbar.tsx";

export interface DesignStepperProps {
    design: DesignView;
    /** The pipeline stage, shown as a pill after the steps. */
    stage: string;
    /** The session's `needs_human`: an active step shows as waiting while it is set. */
    needs: string | null;
    /** Opens the step's tab of the design workspace (build session 5). */
    onStep?: ((id: StepId) => void) | undefined;
}

/** The context-bar title keeps this width (or its whole text, when shorter) before a fold. */
export const TITLE_MIN_PX = 120;

/**
 * The pixels the bar lacks for the full stepper: its overflow, plus what the title lacks of
 * `TITLE_MIN_PX`. Zero when everything fits.
 */
function deficitOf(bar: Element): number {
    const overflow = Math.max(0, bar.scrollWidth - bar.clientWidth);
    const title = bar.querySelector(".context-title");
    const short = title === null
        ? 0
        : Math.max(0, Math.min(TITLE_MIN_PX, title.scrollWidth) - title.clientWidth);
    return overflow + short;
}

/**
 * True while the full stepper does not fit the context bar. On a fold it records the bar
 * width that the full stepper needs, and it unfolds only once the bar is that wide, so a fold
 * never flips back and forth. The caller keys the stepper by session, so the record resets
 * with the bar's content.
 */
function useBarFold(ref: RefObject<HTMLSpanElement | null>): boolean {
    const [need, setNeed] = useState<number | null>(null);
    const check = () => {
        const bar = ref.current?.closest(".context-bar");
        if (bar === null || bar === undefined) {
            return;
        }
        const width = bar.clientWidth;
        setNeed((old) => {
            if (old !== null) {
                return width >= old ? null : old;
            }
            const deficit = deficitOf(bar);
            return deficit > 0 ? width + deficit : null;
        });
    };
    // Every render: the bar's content (the needs pill, the toolbar) moves with the view.
    useLayoutEffect(check);
    useEffect(() => {
        const bar = ref.current?.closest(".context-bar");
        if (bar === null || bar === undefined) {
            return;
        }
        const observer = new ResizeObserver(check);
        observer.observe(bar);
        return () => observer.disconnect();
        // `check` reads the ref and the setter only; one observer per mount.
    }, []);
    return need !== null;
}

/** A done step shows a check; the others their number. */
function StepMark({ step, index }: { step: DesignStep; index: number }) {
    return <span className="egm-step-mark">{step.state === "done" ? "✓" : index + 1}</span>;
}

/** The step's `running` Goldfish as a superscript digit (entry 4.17); nothing at 0. */
function RunningFish({ count }: { count: number }) {
    if (count === 0) {
        return null;
    }
    return (
        <sup className="egm-fish" title={`${count} Goldfish running`}>
            {count}
        </sup>
    );
}

function ReviewDots({ dots }: { dots: boolean[] }) {
    return (
        <span className="egm-dots" aria-hidden="true">
            {dots.map((on, index) => (
                <span key={index} className={on ? "egm-dot egm-dot-on" : "egm-dot"} />
            ))}
        </span>
    );
}

export function DesignStepper({ design, stage, needs, onStep }: DesignStepperProps) {
    const ref = useRef<HTMLSpanElement | null>(null);
    const folded = useBarFold(ref);
    const compact = useCompact() || folded;
    const steps = designSteps(design, needs);
    const pipeline = <span className="badge egm-pipeline">{stage}</span>;
    if (compact) {
        const current = steps.find((step) => step.state !== "done") ?? steps[steps.length - 1];
        return (
            <span ref={ref} className="egm-stepper egm-stepper-compact" aria-label="EGM steps">
                <span
                    className="egm-step egm-compact"
                    data-state={current?.state}
                    title={`${EGM_NOTICE}\n${stepperText(steps)}`}
                >
                    {compactLabel(steps)}
                </span>
                {pipeline}
            </span>
        );
    }
    return (
        <span ref={ref} className="egm-stepper" aria-label="EGM steps">
            <span className="egm-label" title={EGM_NOTICE}>
                EGM
            </span>
            {steps.map((step, index) => {
                const inner = (
                    <>
                        <StepMark step={step} index={index} />
                        {step.label}
                        {step.dots !== undefined && <ReviewDots dots={step.dots} />}
                        <RunningFish count={runningOn(design.goldfish, step.id)} />
                    </>
                );
                const shared = {
                    className: "egm-step",
                    "data-state": step.state,
                    "data-step": step.id,
                    title: stepTitle(step, design),
                };
                return (
                    <Fragment key={step.id}>
                        {index > 0 && <span className="egm-sep" aria-hidden="true" />}
                        {onStep === undefined ? (
                            <span {...shared}>{inner}</span>
                        ) : (
                            <button type="button" {...shared} onClick={() => onStep(step.id)}>
                                {inner}
                            </button>
                        )}
                    </Fragment>
                );
            })}
            {pipeline}
        </span>
    );
}
