import type { SessionView } from "@spinner/protocol";

import { Icon, PaneHead, PrBadge, type IconButtonProps } from "./PaneHead.tsx";
import { prLine } from "./prLine.ts";
import { needsHuman, stageOf } from "./state.ts";
import type { ComposeKind, RunAction } from "./SessionForms.tsx";

export type { RunAction } from "./SessionForms.tsx";

export interface SessionsPaneProps {
    sessions: [string, SessionView][];
    selected: string | undefined;
    onSelect: (dir: string) => void;
    run: RunAction;
    /** Opens the `new` or `adopt` form in the middle pane. */
    onCompose: (kind: ComposeKind) => void;
    /** Header icons; absent when the pane is rendered alone by the `?pane=` route. */
    controls?: IconButtonProps[] | undefined;
    /** The side-panel toggle, at the left of the title. */
    leading?: IconButtonProps | undefined;
}

function stackDot(view: SessionView): string {
    return `dot dot-${view.stack.state}`;
}

/**
 * The block at the top of the list: `+ New session` on the right two thirds, `Adopt` on the
 * left third. Each opens its form as a view of the middle pane.
 */
function ComposeCard({ onCompose }: { onCompose: (kind: ComposeKind) => void }) {
    return (
        <li className="compose-card">
            <button
                type="button"
                className="compose-adopt"
                onClick={() => onCompose("adopt")}
                title="Adopt pull requests into a session"
                aria-label="Adopt pull requests"
            >
                <Icon name="pull-request" />
                <span>Adopt</span>
            </button>
            <button
                type="button"
                className="compose-new"
                onClick={() => onCompose("new")}
                aria-label="New session"
            >
                <span className="compose-plus">+</span>
                <span>New session</span>
            </button>
        </li>
    );
}

/** One session, a block of fixed height; the per-PR lines are the card's tooltip. */
function SessionCard(props: {
    dir: string;
    view: SessionView;
    selected: boolean;
    onSelect: (dir: string) => void;
}) {
    const { dir, view, selected, onSelect } = props;
    const needs = needsHuman(view);
    const prs = view.board?.prs ?? [];
    const detail = [dir, ...prs.map(prLine)].join("\n");
    return (
        <li>
            <button
                className={selected ? "session session-selected" : "session"}
                onClick={() => onSelect(dir)}
                title={detail}
                data-dir={dir}
            >
                <strong className="session-title">{view.summary.session.title}</strong>
                <span className="badges">
                    <span className="badge">{stageOf(view)}</span>
                    <span className={stackDot(view)} />
                    <span className="muted">stack {view.stack.state}</span>
                    <PrBadge prs={prs} />
                </span>
                <span className="needs-human session-needs">{needs ?? ""}</span>
            </button>
        </li>
    );
}

export function SessionsPane(props: SessionsPaneProps) {
    const { sessions, selected, onSelect, onCompose, controls, leading } = props;
    return (
        <section className="pane sessions-pane" aria-label="Sessions">
            <PaneHead name="sessions" controls={controls} leading={leading} />
            <ul className="session-list">
                <ComposeCard onCompose={onCompose} />
                {sessions.map(([dir, view]) => (
                    <SessionCard
                        key={dir}
                        dir={dir}
                        view={view}
                        selected={dir === selected}
                        onSelect={onSelect}
                    />
                ))}
                {sessions.length === 0 && <li className="muted">No sessions yet.</li>}
            </ul>
        </section>
    );
}
