// A plan's page in the middle pane (docs/designs/talk-change-ship.md, 4.6): the document and
// `Implement`, with the choice of the session that builds it. It shows for a plan without a
// live planning session; a plan that is being written shows its session instead, with the
// same `Implement` bar above it.
import { useState } from "react";

import type { PlanView } from "@spinner/protocol";

import { Markdown } from "./Markdown.tsx";
import {
    NEW_SESSION_TARGET,
    canImplement,
    implementBody,
    planStatusText,
    type ImplementTarget,
} from "./plans.ts";
import { fetchPlanDoc, useLoaded } from "./remote.ts";
import type { RunAction } from "./SessionsPane.tsx";

export interface ImplementBarProps {
    plan: PlanView;
    targets: readonly ImplementTarget[];
    /** True while an `Implement` job runs. */
    busy: boolean;
    run: RunAction;
}

/** The plan's title, its status, and `Implement` with the choice of session. */
export function ImplementBar({ plan, targets, busy, run }: ImplementBarProps) {
    const [target, setTarget] = useState(NEW_SESSION_TARGET);
    const ready = canImplement(plan);
    const tip = ready
        ? "Attach the plan to the session: its steps seed the mission board, and the agent " +
          "builds them, one change per step."
        : "The plan has no steps yet: its document needs a Detailed Implementation Plan.";
    return (
        <div className="plan-bar" aria-label="Plan">
            <span className="plan-bar-title">
                <strong>{plan.title}</strong>
                <span className="muted"> · {planStatusText(plan)}</span>
            </span>
            <label className="plan-bar-target">
                <span className="muted">in</span>
                <select
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                    aria-label="Session that implements the plan"
                >
                    <option value={NEW_SESSION_TARGET}>a new session</option>
                    {targets.map((entry) => (
                        <option key={entry.dir} value={entry.dir}>{entry.label}</option>
                    ))}
                </select>
            </label>
            <button
                className="primary"
                disabled={!ready || busy}
                title={tip}
                onClick={() => void run(`/plans/${plan.id}/implement`, implementBody(target))}
            >
                Implement
            </button>
        </div>
    );
}

export interface PlanPageProps extends ImplementBarProps {
    /** Moves when the plan's document may have changed. */
    revision: string;
}

export function PlanPage(props: PlanPageProps) {
    const { plan } = props;
    const loaded = useLoaded(`${plan.id}#${props.revision}`, (signal) =>
        plan.doc === null ? Promise.resolve("") : fetchPlanDoc(plan.id, signal),
    );
    return (
        <section className="pane plan-page" aria-label="Plan">
            <ImplementBar {...props} />
            <div className="plan-doc">
                {loaded.error !== null && <p className="needs-human">{loaded.error}</p>}
                {plan.doc === null && <p className="muted">This plan has no document yet.</p>}
                {loaded.value !== undefined && loaded.value !== "" && (
                    <Markdown text={loaded.value} label={plan.doc ?? plan.id} />
                )}
            </div>
        </section>
    );
}
