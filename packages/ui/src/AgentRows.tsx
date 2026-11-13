// The Agents view's head (docs/designs/talk-change-ship.md, R9 and 5.10): the agent in focus
// as one line, and a list of every agent that drops down from it: one line per agent, grouped
// as `agent-rows.ts` builds them, each group's finished rows behind an `n finished` line, and
// `+ add agent` at the end. A pick in the list focuses the agent; the pane shows its chat.
import { useState } from "react";

import {
    rowCount,
    rowOf,
    type AgentRow,
    type RowAction,
    type RowGroup,
    type RowTarget,
} from "./agent-rows.ts";
import { agentLabel } from "./agent-view.ts";
import { formatUsd } from "./costs.ts";

import "./agent-rows.css";

export interface AgentRowsProps {
    groups: RowGroup[];
    /** The key of the selected row, or null while none is (the add form shows). */
    selected: string | null;
    adding: boolean;
    /** The Goldfish cap line (`capLine`), or null. */
    cap: string | null;
    onPick: (target: RowTarget) => void;
    onAdd: () => void;
    /** Posts the action to its agent route; the promise settles with the daemon's answer. */
    onAction: (name: string, action: RowAction) => Promise<void>;
}

const ACTION_TITLES: Record<RowAction, string> = {
    interrupt: "End the current turn; the agent stays up",
    compact: "Send pi's /compact: summarise the conversation to free the window",
    stop: "Stop the agent's process; its transcript stays",
    resume: "Start the agent again on its transcript",
};

/**
 * The row's buttons. Each one waits for the daemon's answer, so a double click sends once;
 * `stop` asks for a second click, and a click elsewhere takes the question back.
 */
function RowActions(props: { row: AgentRow; onAction: AgentRowsProps["onAction"] }) {
    const { row, onAction } = props;
    const [sending, setSending] = useState<RowAction | null>(null);
    const [confirming, setConfirming] = useState(false);
    const send = (action: RowAction) => {
        setSending(action);
        void onAction(row.name, action).finally(() => setSending(null));
    };
    return (
        <span className="ar-actions">
            {row.actions.map((action) => {
                const asks = action === "stop" && confirming;
                return (
                    <button
                        key={action}
                        type="button"
                        className={asks ? "ar-action ar-confirm" : `ar-action ar-${action}`}
                        aria-label={asks ? `Confirm stop ${row.name}` : `${action} ${row.name}`}
                        title={asks ? "Click again to stop the agent" : ACTION_TITLES[action]}
                        disabled={sending !== null}
                        onBlur={() => setConfirming(false)}
                        onClick={() => {
                            if (action === "stop" && !confirming) {
                                setConfirming(true);
                                return;
                            }
                            setConfirming(false);
                            send(action);
                        }}
                    >
                        {asks ? "stop?" : action}
                    </button>
                );
            })}
        </span>
    );
}

function Row(props: {
    row: AgentRow;
    selected: boolean;
    onPick: AgentRowsProps["onPick"];
    onAction: AgentRowsProps["onAction"];
}) {
    const { row, selected, onPick, onAction } = props;
    const context = row.context;
    return (
        <li
            className={selected ? "ar-row ar-selected" : "ar-row"}
            data-key={row.key}
            data-state={row.state}
        >
            <button
                type="button"
                className="ar-pick"
                aria-pressed={selected}
                onClick={() => onPick(row.target)}
            >
                <span className={`dot ar-dot ar-dot-${row.state}`} title={row.state} />
                <span className="ar-name" title={`${agentLabel(row.name)} · ${row.roleLabel}`}>
                    {agentLabel(row.name)}
                </span>
                <span className="ar-role muted">{row.roleLabel}</span>
                <span className="ar-doing" title={row.doingTitle}>{row.doing}</span>
                <span className="ar-model muted" title={row.modelTitle}>{row.model}</span>
                {context === null ? (
                    <span className="ar-context muted" title="No context figure known yet">
                        —
                    </span>
                ) : (
                    <span
                        className={context.tone === "plain"
                            ? "ar-context"
                            : `ar-context pill pill-${context.tone}`}
                        title={context.title}
                    >
                        {context.label}
                    </span>
                )}
                <span className="ar-cost muted">
                    {row.usd === null ? "—" : formatUsd(row.usd)}
                </span>
            </button>
            <RowActions row={row} onAction={onAction} />
        </li>
    );
}

/**
 * The Agents view's head (the operator's request of 2026-11-13): the agent in focus as one
 * line, and a control at its end that drops the list of every agent down over the chat. A
 * pick in the list focuses that agent and closes the list; `+ add agent` is its last line.
 */
export function AgentRows(props: AgentRowsProps) {
    const { groups, selected, adding, cap, onPick, onAdd, onAction } = props;
    const [listed, setListed] = useState(false);
    const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
    const toggle = (id: string) =>
        setOpen((old) => {
            const next = new Set(old);
            if (!next.delete(id)) {
                next.add(id);
            }
            return next;
        });
    const focus = adding ? null : rowOf(groups, selected);
    const others = rowCount(groups) - (focus === null ? 0 : 1);
    // One group needs no heading: a session with one agent is one line.
    const headed = groups.length > 1;
    const pick = (target: RowTarget) => {
        setListed(false);
        onPick(target);
    };
    const row = (item: AgentRow) => (
        <Row
            key={item.key}
            row={item}
            selected={!adding && item.key === selected}
            onPick={pick}
            onAction={onAction}
        />
    );
    return (
        <div className="ar" aria-label="Agents" data-listed={listed}>
            <ul className="ar-rows ar-focus">
                {focus === null ? (
                    <li className="ar-row ar-none muted">
                        {adding ? "New agent" : "No agent in focus"}
                    </li>
                ) : (
                    <Row
                        row={focus}
                        selected
                        onPick={() => setListed(!listed)}
                        onAction={onAction}
                    />
                )}
                <li className="ar-more">
                    <button
                        type="button"
                        className="ar-more-button"
                        aria-expanded={listed}
                        aria-label={listed ? "Hide the agents" : "Show every agent"}
                        title={listed ? "Hide the list" : "Every agent of the session"}
                        onClick={() => setListed(!listed)}
                    >
                        {others > 0 ? `${others} more ` : ""}
                        <span className="ar-chevron" data-open={listed}>›</span>
                    </button>
                </li>
            </ul>
            {listed && (
                <>
                    <button
                        type="button"
                        className="ar-backdrop"
                        aria-label="Close the list of agents"
                        onClick={() => setListed(false)}
                    />
                    <div className="ar-list" role="listbox" aria-label="Every agent">
                        {groups.map((group) => (
                            <section key={group.id} className="ar-group" data-group={group.id}>
                                {headed && <h3 className="ar-heading">{group.label}</h3>}
                                <ul className="ar-rows">
                                    {group.rows.map(row)}
                                    {group.finished.length > 0 && (
                                        <li className="ar-fold">
                                            <button
                                                type="button"
                                                className="ar-fold-line"
                                                aria-expanded={open.has(group.id)}
                                                onClick={() => toggle(group.id)}
                                            >
                                                {open.has(group.id) ? "▾" : "▸"}
                                                {` ${group.finished.length} finished`}
                                            </button>
                                        </li>
                                    )}
                                    {open.has(group.id) && group.finished.map(row)}
                                </ul>
                            </section>
                        ))}
                        {cap !== null && <p className="muted ar-cap">{cap}</p>}
                        <button
                            type="button"
                            className={adding ? "ar-add ar-add-on" : "ar-add"}
                            aria-label="Add agent"
                            aria-pressed={adding}
                            onClick={() => {
                                setListed(false);
                                onAdd();
                            }}
                        >
                            + add agent
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}
