// The EGM stepper in the context bar (docs/designs/egm-adoption.md, entry 2.32, Technical Plan
// T13): the `EGM` label with the attribution as its tooltip, the five steps with their state,
// the five Review dots for `egm-review` stages 5 to 9, then the pipeline stage as a pill.
// Under `TOOLBAR_COMPACT_PX` it folds to `EGM 3/5 Review` with the whole stepper in the
// tooltip, so the context bar keeps one line.
import { Fragment } from "react";

import { EGM_NOTICE, type DesignView } from "@spinner/protocol";

import {
    compactLabel, designSteps, stepperText, stepTitle, type DesignStep, type StepId,
} from "./design.ts";
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

/** A done step shows a check; the others their number. */
function StepMark({ step, index }: { step: DesignStep; index: number }) {
    return <span className="egm-step-mark">{step.state === "done" ? "✓" : index + 1}</span>;
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
    const compact = useCompact();
    const steps = designSteps(design, needs);
    const pipeline = <span className="badge egm-pipeline">{stage}</span>;
    if (compact) {
        const current = steps.find((step) => step.state !== "done") ?? steps[steps.length - 1];
        return (
            <span className="egm-stepper egm-stepper-compact" aria-label="EGM steps">
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
        <span className="egm-stepper" aria-label="EGM steps">
            <span className="egm-label" title={EGM_NOTICE}>
                EGM
            </span>
            {steps.map((step, index) => {
                const inner = (
                    <>
                        <StepMark step={step} index={index} />
                        {step.label}
                        {step.dots !== undefined && <ReviewDots dots={step.dots} />}
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
