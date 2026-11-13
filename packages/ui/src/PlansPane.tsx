// The Plans view of the sidebar (docs/designs/talk-change-ship.md, 4.6): the plans library.
// One row per plan with its status and the sessions that implement it. A row with a live
// planning session opens that session; a row without one opens the plan's page. `+ New plan`
// opens the composer with `Plan first` set.
import type { PlanView } from "@spinner/protocol";

import { liveImplementations, planStatusText, planTone } from "./plans.ts";
import { NewButton } from "./Sidebar.tsx";

export interface PlansPaneProps {
    plans: readonly PlanView[];
    error: string | null;
    /** The plan whose page or planning session shows. */
    selected: string | undefined;
    onSelect: (plan: PlanView) => void;
    /** Opens a live session that implements a plan. */
    onSession: (dir: string) => void;
    onNew: () => void;
    composing: boolean;
}

function Row(props: {
    plan: PlanView;
    selected: boolean;
    onSelect: (plan: PlanView) => void;
    onSession: (dir: string) => void;
}) {
    const { plan } = props;
    const sessions = liveImplementations(plan);
    return (
        <li className="plan-row-item">
            <button
                className={props.selected ? "pr-row pr-row-selected" : "pr-row"}
                data-plan={plan.id}
                data-tone={planTone(plan)}
                onClick={() => props.onSelect(plan)}
                title={plan.id}
            >
                <span className="pr-row-head">
                    <span className="dot change-dot" aria-hidden="true" />
                    <strong className="pr-row-title">{plan.title}</strong>
                </span>
                <span className="muted pr-row-meta">
                    {planStatusText(plan)}
                    {plan.session !== null && " · planning"}
                </span>
            </button>
            {sessions.length > 0 && (
                <span className="muted plan-row-sessions">
                    built in{" "}
                    {sessions.map((dir) => (
                        <button key={dir} className="link" onClick={() => props.onSession(dir)}>
                            {dir.split("-")[0]}
                        </button>
                    ))}
                </span>
            )}
        </li>
    );
}

export function PlansPane(props: PlansPaneProps) {
    const { plans, error, selected } = props;
    return (
        <section className="pane plans-pane" aria-label="Plans">
            <div className="side-compose">
                <NewButton label="New plan" active={props.composing} onClick={props.onNew} />
            </div>
            <div className="plans-list">
                {error !== null && <p className="needs-human">{error}</p>}
                {plans.length === 0 && error === null && (
                    <p className="muted">
                        No plan yet. A plan is a document: what to build, in which steps. Write
                        one with an agent, then press Implement.
                    </p>
                )}
                <ul className="pr-rows">
                    {plans.map((plan) => (
                        <Row
                            key={plan.id}
                            plan={plan}
                            selected={plan.id === selected || plan.session === selected}
                            onSelect={props.onSelect}
                            onSession={props.onSession}
                        />
                    ))}
                </ul>
            </div>
        </section>
    );
}
