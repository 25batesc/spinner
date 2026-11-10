import { useEffect, useState } from "react";

import type { SessionView } from "@spinner/protocol";

import { ArchiveButton, ArchiveConfirm } from "./CardArchive.tsx";
import { designSteps, stepperText } from "./design.ts";
import { ContextFigure, CostFigure, PrBadge, RoundBadge, SyncBadge } from "./PaneHead.tsx";
import { prLine } from "./prLine.ts";
import { agentWorking, agoText, needsHuman, stageOf } from "./state.ts";
import type { RunAction } from "./SessionForms.tsx";
import { NewButton } from "./Sidebar.tsx";
import { stackLine, stackUsageOf, type UsageSample } from "./usage.ts";

export type { RunAction } from "./SessionForms.tsx";

export interface SessionsPaneProps {
    sessions: [string, SessionView][];
    selected: string | undefined;
    onSelect: (dir: string) => void;
    run: RunAction;
    /** The confirmed `archive` of a card: the caller runs `close` and moves the selection. */
    onArchive: (dir: string) => void;
    /** The pinned `+ New session` button opens the composer in the working area. */
    onNew: () => void;
    /** True while the composer shows; the button reads as pressed. */
    composing: boolean;
    /** The last usage sample, for the line beside each up stack. */
    usage: UsageSample | null;
}

function stackDot(view: SessionView): string {
    return `dot dot-${view.stack.state}`;
}

/**
 * The five EGM steps as dots without labels (entry 2.34), for a design-track session only;
 * the steps in words are the tooltip.
 */
function CardDots({ view, needs }: { view: SessionView; needs: string | null }) {
    if (view.design?.track !== "design") {
        return null;
    }
    const steps = designSteps(view.design, needs);
    return (
        <span className="card-dots" title={`EGM: ${stepperText(steps)}`}>
            {steps.map((step) => (
                <span key={step.id} className="card-dot" data-state={step.state} />
            ))}
        </span>
    );
}

/** One session, a block of fixed height; the per-PR lines are the card's tooltip. */
function SessionCard(props: {
    dir: string;
    view: SessionView;
    selected: boolean;
    onSelect: (dir: string) => void;
    onArchive: (dir: string) => void;
    usage: UsageSample | null;
    /** The clock for the "n min ago" text; the pane ticks it once a minute. */
    now: Date;
}) {
    const { dir, view, selected, onSelect, usage } = props;
    const [asking, setAsking] = useState(false);
    const needs = needsHuman(view);
    const working = agentWorking(view);
    const ago = agoText(view.summary.session.last_interaction, props.now);
    const stack = stackUsageOf(view, usage);
    const prs = view.board?.prs ?? [];
    const detail = [dir, ...prs.map(prLine)].join("\n");
    if (asking) {
        return (
            <li className="session-item" data-dir={dir}>
                <ArchiveConfirm
                    onArchive={() => {
                        setAsking(false);
                        props.onArchive(dir);
                    }}
                    onCancel={() => setAsking(false)}
                />
            </li>
        );
    }
    return (
        <li className="session-item">
            <button
                className={selected ? "session session-selected" : "session"}
                onClick={() => onSelect(dir)}
                title={detail}
                data-dir={dir}
            >
                <strong className="session-title">
                    {working && (
                        <span
                            className="dot session-working"
                            title="An agent is working"
                            aria-label="An agent is working"
                        />
                    )}
                    {view.summary.session.title}
                </strong>
                <span className="badges">
                    <span className="badge">{stageOf(view)}</span>
                    <CardDots view={view} needs={needs} />
                    <RoundBadge view={view} />
                    <span className={stackDot(view)} />
                    <span className="muted">stack {view.stack.state}</span>
                    {stack !== null && (
                        <span className="muted usage-line">{stackLine(stack)}</span>
                    )}
                    <CostFigure cost={view.cost} />
                    <ContextFigure view={view} />
                    <PrBadge prs={prs} />
                    <SyncBadge view={view} />
                </span>
                <span className="session-foot">
                    <span className="needs-human session-needs">{needs ?? ""}</span>
                    {ago !== null && <span className="muted session-ago">{ago}</span>}
                </span>
            </button>
            <ArchiveButton onClick={() => setAsking(true)} />
        </li>
    );
}

/** The "n min ago" texts move with the clock: one re-render a minute. */
function useMinuteClock(): Date {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 60_000);
        return () => clearInterval(timer);
    }, []);
    return now;
}

export function SessionsPane(props: SessionsPaneProps) {
    const { sessions, selected, onSelect, usage } = props;
    const now = useMinuteClock();
    return (
        <section className="pane sessions-pane" aria-label="Sessions">
            <div className="side-compose">
                <NewButton label="New session" active={props.composing} onClick={props.onNew} />
            </div>
            <ul className="session-list">
                {sessions.map(([dir, view]) => (
                    <SessionCard
                        key={dir}
                        dir={dir}
                        view={view}
                        usage={usage}
                        selected={dir === selected}
                        onSelect={onSelect}
                        onArchive={props.onArchive}
                        now={now}
                    />
                ))}
                {sessions.length === 0 && <li className="muted">No sessions yet.</li>}
            </ul>
        </section>
    );
}
