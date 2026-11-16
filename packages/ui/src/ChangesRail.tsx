// The PR view (docs/designs/talk-change-ship.md, 2.9; the operator's asks of 2026-11-13 and
// 2026-11-15): a table with one line per pull request of the session's changes, and one for a
// change without any. A click on a row opens its detail under it: what the change needs from
// the operator, the facts the narrowed columns no longer show, and the PR actions that were
// the top toolbar's. `merge`, `post` and `approve` act on that change, checked out or not
// (`?change=<id>`); `create PR`, `review` and `fix` on the current one. Finished changes fold
// under a count.
import { useEffect, useRef, useState } from "react";

import type { ChangeView, SessionView } from "@spinner/protocol";

import "./pr-view.css";
import "./pr-table.css";
import {
    changeCards,
    hasStack,
    isFinished,
    prActions,
    prTableRows,
    startRow,
    type PrAction,
    type PrActionName,
    type PrCell,
    type PrColumn,
    type PrTableRow,
} from "./changes.ts";
import { ApproveDialog, PIPELINE_TIPS, PostDialog } from "./PipelineActions.tsx";
import type { RunAction } from "./SessionsPane.tsx";

/** The window event the PR chip sends to open the PR view on a change. */
const OPEN_CHANGE_EVENT = "spinner:open-change";

export interface OpenChange {
    dir: string;
    change: string;
}

declare global {
    interface WindowEventMap {
        [OPEN_CHANGE_EVENT]: CustomEvent<OpenChange>;
    }
}

/** Opens the PR view of session `dir` on change `change` (the PR chip's rows). */
export function openChange(detail: OpenChange): void {
    window.dispatchEvent(new CustomEvent<OpenChange>(OPEN_CHANGE_EVENT, { detail }));
}

/** Calls `onOpen` for every `openChange` while mounted. */
export function useOpenChange(onOpen: (detail: OpenChange) => void): void {
    const latest = useRef(onOpen);
    latest.current = onOpen;
    useEffect(() => {
        const listener = (event: CustomEvent<OpenChange>) => latest.current(event.detail);
        window.addEventListener(OPEN_CHANGE_EVENT, listener);
        return () => window.removeEventListener(OPEN_CHANGE_EVENT, listener);
    }, []);
}

export interface ChangesRailProps {
    view: SessionView;
    /** True while a job runs on the session; the actions wait. */
    busy: boolean;
    run: RunAction;
    /** Moves on pipeline events; the post and approve dialogs read the daemon's preview again. */
    revision: number;
    /** The change the PR chip asked for; its row opens and scrolls into view. `seq` moves. */
    focus?: { change: string; seq: number } | undefined;
}

const ACTION_LABELS: Record<PrActionName, string> = {
    test: "test locally",
    create: "create PR",
    review: "review",
    fix: "fix",
    post: "post",
    approve: "approve",
    merge: "merge",
};

function actionTip(name: PrActionName, change: ChangeView): string {
    switch (name) {
        case "test":
            return change.current
                ? "Start the stack on this change."
                : "Check out this change in the worktrees and restart the stack on it.";
        case "create":
            return PIPELINE_TIPS.pr;
        case "merge":
            return "Merge (or enqueue) this change's pull requests.";
        default:
            return PIPELINE_TIPS[name];
    }
}

interface Dialog {
    kind: "post" | "approve";
    change: string;
}

interface ActionsProps {
    dir: string;
    /** True when the session has a stack: `test locally` is offered. */
    stack: boolean;
    change: ChangeView;
    busy: boolean;
    run: RunAction;
    onDialog: (dialog: Dialog) => void;
}

function ChangeActions({ dir, stack, change, busy, run, onDialog }: ActionsProps) {
    // `merge` cannot be undone, so the first click arms it and the second sends it.
    const [armed, setArmed] = useState(false);
    const query = `?change=${encodeURIComponent(change.id)}`;
    const merge = () => {
        setArmed(false);
        void run(`/sessions/${dir}/land${query}`);
    };
    const act: Record<Exclude<PrActionName, "merge">, () => void> = {
        test: () => void run(`/sessions/${dir}/up`, { change: change.id }),
        create: () => void run(`/sessions/${dir}/pr`),
        review: () => void run(`/sessions/${dir}/review`),
        fix: () => void run(`/sessions/${dir}/fix`),
        post: () => onDialog({ kind: "post", change: change.id }),
        approve: () => onDialog({ kind: "approve", change: change.id }),
    };
    const button = ({ name, reason }: PrAction) => {
        if (name !== "merge") {
            return (
                <button
                    key={name}
                    disabled={reason !== null}
                    title={reason ?? actionTip(name, change)}
                    onClick={act[name]}
                >
                    {ACTION_LABELS[name]}
                </button>
            );
        }
        if (armed) {
            return (
                <span key={name} className="pr-merge-confirm">
                    <button className="danger" onClick={merge}>confirm merge</button>
                    <button onClick={() => setArmed(false)}>cancel</button>
                </span>
            );
        }
        return (
            <button
                key={name}
                className="danger"
                disabled={reason !== null}
                title={reason ?? actionTip(name, change)}
                onClick={() => setArmed(true)}
            >
                merge
            </button>
        );
    };
    const actions = prActions(change, stack, busy);
    return actions.length > 0 && <div className="change-actions">{actions.map(button)}</div>;
}

/** A cell's text, a link in a new tab when it has one. */
function CellText({ cell }: { cell: PrCell | null }) {
    if (cell === null) {
        return null;
    }
    if (cell.href === undefined) {
        return <span title={cell.title}>{cell.text}</span>;
    }
    return (
        <a href={cell.href} target="_blank" rel="noreferrer" title={cell.title}>
            {cell.text}
        </a>
    );
}

const HEADINGS: [string, PrColumn | undefined][] = [
    ["", undefined], ["PR", undefined], ["Title", undefined], ["State", "state"],
    ["CI", undefined], ["Review", "review"], ["Threads", "threads"], ["Size", "size"],
    ["Updated", "updated"], ["", undefined],
];

interface RowProps extends Omit<ActionsProps, "change"> {
    row: PrTableRow;
    open: boolean;
    onToggle: () => void;
}

function TableRow({ row, open, onToggle, ...actions }: RowProps) {
    const { change, ci } = row;
    return (
        <>
            <div
                className="pr-table-row"
                role="row"
                data-change={change.id}
                data-tone={row.tone}
                data-open={open}
                onClick={(event) => {
                    // A link opens GitHub or Slack; it does not fold the row.
                    if (event.target instanceof Element && event.target.closest("a") !== null) {
                        return;
                    }
                    onToggle();
                }}
            >
                <span role="cell"><span className="dot change-dot" aria-hidden="true" /></span>
                <span role="cell">
                    {row.href === null ? (
                        <span className="change-pr-name">{row.name}</span>
                    ) : (
                        <a
                            className="change-pr-name"
                            href={row.href}
                            target="_blank"
                            rel="noreferrer"
                            title="Open on GitHub"
                        >
                            {row.name} ↗
                        </a>
                    )}
                </span>
                <span role="cell" className="pr-table-title">
                    <span className="pr-table-title-text" title={row.title}>{row.title}</span>
                    {change.current && (
                        <span className="badge" title="Checked out in the session's worktrees">
                            current
                        </span>
                    )}
                    {change.verified === true && (
                        <span className="badge change-tested" title="You verified it at this head">
                            tested
                        </span>
                    )}
                    {change.posted != null && (
                        <a
                            className="badge change-posted"
                            href={change.posted}
                            target="_blank"
                            rel="noreferrer"
                            title="The review request on Slack"
                        >
                            posted ↗
                        </a>
                    )}
                </span>
                <span role="cell" data-column="state" data-tone={row.state.tone}>
                    <CellText cell={row.state} />
                </span>
                <span role="cell" data-tone={ci?.tone}>
                    {ci !== null && (
                        <a href={ci.href} target="_blank" rel="noreferrer" title={ci.title}>
                            {ci.mark}
                            <span data-column="ci"> {ci.text}</span>
                        </a>
                    )}
                </span>
                <span role="cell" data-column="review" data-tone={row.review?.tone}>
                    <CellText cell={row.review} />
                </span>
                <span role="cell" data-column="threads" data-tone={row.threads?.tone}>
                    <CellText cell={row.threads} />
                </span>
                <span role="cell" data-column="size">
                    <CellText cell={row.size} />
                </span>
                <span role="cell" data-column="updated">
                    <CellText cell={row.updated} />
                </span>
                <span role="cell">
                    <button
                        className="pr-table-chevron"
                        aria-expanded={open}
                        aria-label={open ? "Close the detail" : "Open the detail"}
                    >
                        {open ? "▾" : "▸"}
                    </button>
                </span>
            </div>
            {open && (
                <div className="pr-table-detail">
                    {change.needs_human !== null && (
                        <div className="needs-human">needs you: {change.needs_human}</div>
                    )}
                    <dl className="pr-table-facts">
                        {row.facts.map((fact) => (
                            <div
                                key={fact.label}
                                className="pr-table-fact"
                                data-column={fact.column}
                                data-tone={fact.tone}
                            >
                                <dt>{fact.label}</dt>
                                <dd title={fact.title}>
                                    {fact.href === undefined ? (
                                        fact.text
                                    ) : (
                                        <a href={fact.href} target="_blank" rel="noreferrer">
                                            {fact.text}
                                        </a>
                                    )}
                                </dd>
                            </div>
                        ))}
                    </dl>
                    <ChangeActions change={change} {...actions} />
                </div>
            )}
        </>
    );
}

export function ChangesRail({ view, busy, run, revision, focus }: ChangesRailProps) {
    const [dialog, setDialog] = useState<Dialog | null>(null);
    const [showFinished, setShowFinished] = useState(false);
    const list = useRef<HTMLDivElement | null>(null);
    const dir = view.summary.dir;
    const rows = prTableRows(view, new Date());
    const finished = changeCards(view).finished.length;
    const [openRow, setOpenRow] = useState(() => startRow(rows.open));
    const focused = focus === undefined
        ? undefined
        : (view.changes ?? []).find((change) => change.id === focus.change);
    useEffect(() => {
        if (focused === undefined) {
            return;
        }
        if (isFinished(focused)) {
            setShowFinished(true);
        }
        const first = [...rows.open, ...rows.finished].find((row) => row.change.id === focused.id);
        setOpenRow(first?.key ?? null);
        // After the fold opens: the rows of a finished change mount with it.
        requestAnimationFrame(() => {
            const row = list.current?.querySelector(`[data-change="${focused.id}"]`);
            row?.scrollIntoView({ block: "start", behavior: "smooth" });
        });
    }, [focus?.seq]);
    const tableRow = (row: PrTableRow) => (
        <TableRow
            key={row.key}
            row={row}
            open={openRow === row.key}
            onToggle={() => setOpenRow(openRow === row.key ? null : row.key)}
            dir={dir}
            stack={hasStack(view)}
            busy={busy}
            run={run}
            onDialog={setDialog}
        />
    );
    const close = () => setDialog(null);
    return (
        <div className="changes-rail" aria-label="Pull requests" ref={list}>
            {rows.open.length === 0 && rows.finished.length === 0 && (
                <p className="muted">No change yet. Tell the agent what to build.</p>
            )}
            {rows.open.length + rows.finished.length > 0 && (
                <div className="pr-table" role="table">
                    <div className="pr-table-row pr-table-head" role="row">
                        {HEADINGS.map(([name, column], index) => (
                            <span key={index} role="columnheader" data-column={column}>
                                {name}
                            </span>
                        ))}
                    </div>
                    {rows.open.map(tableRow)}
                    {rows.finished.length > 0 && (
                        <button
                            className="link changes-finished-toggle"
                            aria-expanded={showFinished}
                            onClick={() => setShowFinished(!showFinished)}
                        >
                            {showFinished ? "▾" : "▸"} {finished} finished
                        </button>
                    )}
                    {showFinished && rows.finished.map(tableRow)}
                </div>
            )}
            {dialog?.kind === "post" && (
                <PostDialog
                    dir={dir}
                    change={dialog.change}
                    revision={revision}
                    run={run}
                    close={close}
                />
            )}
            {dialog?.kind === "approve" && (
                <ApproveDialog
                    dir={dir}
                    change={dialog.change}
                    revision={revision}
                    run={run}
                    close={close}
                />
            )}
        </div>
    );
}
