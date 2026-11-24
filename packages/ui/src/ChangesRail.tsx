// The PR view (docs/designs/talk-change-ship.md, 2.9; the operator's asks of 2026-11-13 and
// 2026-11-15): a table with one line per pull request of the session's changes, and one for a
// change without any. A click on a row opens its detail under it: what the change needs from
// the operator, the facts the narrowed columns no longer show, and the PR actions that were
// the top toolbar's. `merge`, `post` and `approve` act on that change, checked out or not
// (`?change=<id>`); `create PR`, `review` and `fix` on the current one. Finished changes fold
// under a count.
import { Fragment, useEffect, useRef, useState } from "react";

import type { ChangeView, LinearTicket, SessionView } from "@spinner/protocol";

import "./pr-view.css";
import "./pr-table.css";
import {
    changeCards,
    hasStack,
    isFinished,
    prActions,
    prTableGroups,
    prTableRows,
    startRow,
    type PrAction,
    type PrActionName,
    type PrCell,
    type PrColumn,
    type PrTableGroup,
    type PrTableRow,
} from "./changes.ts";
import { postAgent, sendJson } from "./events-client.ts";
import { Icon } from "./PaneHead.tsx";
import { agoText } from "./state.ts";
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
                    {row.ticket !== null && <TicketBadge ticket={row.ticket} />}
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

/** The Linear ticket of a pull request or of a group: its id, a link to Linear. */
function TicketBadge({ ticket }: { ticket: LinearTicket }) {
    return (
        <a
            className="badge pr-ticket"
            href={ticket.url}
            target="_blank"
            rel="noreferrer"
            title={`${ticket.identifier} in Linear: ${ticket.state}`}
            onClick={(event) => event.stopPropagation()}
        >
            <Icon name="ticket" /> {ticket.identifier}
        </a>
    );
}

/** The text of a headline's field while the operator edits it; null while he does not. */
type GroupEdit = { field: "name" | "purpose" | "hold"; text: string } | null;

/**
 * The headline of a group: its name and what it is for, its one status, and the hold. A
 * click on the name or the purpose edits it (Enter saves, Escape leaves it); `hold` asks for
 * the reason. The lead names the groups; the operator may rename them and hold them.
 */
function GroupHead({ dir, bucket }: { dir: string; bucket: PrTableGroup }) {
    const [edit, setEdit] = useState<GroupEdit>(null);
    const [error, setError] = useState<string | null>(null);
    const { group, status } = bucket;
    if (group === null) {
        return (
            <div className="pr-group-head pr-group-none" role="row">
                <span className="pr-group-name">Not in a group</span>
            </div>
        );
    }
    const at = `/sessions/${dir}/groups/${encodeURIComponent(group.id)}`;
    const send = (work: Promise<void>) => {
        setEdit(null);
        work.then(
            () => setError(null),
            (failure: unknown) =>
                setError(failure instanceof Error ? failure.message : String(failure)),
        );
    };
    const save = () => {
        if (edit === null) {
            return;
        }
        const text = edit.text.trim();
        if (edit.field === "hold") {
            if (text !== "") {
                send(sendJson("PUT", `${at}/hold`, { reason: text, by: "operator" }));
            }
            return;
        }
        if (text === group[edit.field] || (edit.field === "name" && text === "")) {
            setEdit(null);
            return;
        }
        send(sendJson("PUT", at, { [edit.field]: text }));
    };
    const field = (name: "name" | "purpose", shown: string, label: string) =>
        edit?.field === name ? (
            <input
                className={`pr-group-input pr-group-${name}`}
                autoFocus
                aria-label={label}
                value={edit.text}
                onChange={(event) => setEdit({ field: name, text: event.target.value })}
                onBlur={save}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        save();
                    } else if (event.key === "Escape") {
                        setEdit(null);
                    }
                }}
            />
        ) : (
            <button
                type="button"
                className={`pr-group-${name}`}
                title={`${label}: click to change it`}
                onClick={() => setEdit({ field: name, text: group[name] })}
            >
                {shown}
            </button>
        );
    const hold = group.hold;
    return (
        <div className="pr-group-head" role="row" data-hold={hold !== undefined}>
            {field("name", group.name, "The group's name")}
            {field(
                "purpose",
                group.purpose === "" ? "what is this for?" : group.purpose,
                "What the group's pull requests are for",
            )}
            {bucket.ticket !== null && <TicketBadge ticket={bucket.ticket} />}
            {status !== null && (
                <span className={`pill pill-${status.tone} pr-group-status`} title={status.title}>
                    {status.text}
                </span>
            )}
            {hold !== undefined && (
                <span className="pr-group-hold" title={`Set ${agoText(hold.at, new Date()) ?? ""}`}>
                    {hold.reason} · {hold.by === "operator" ? "you" : hold.by}
                </span>
            )}
            {edit?.field === "hold" ? (
                <input
                    className="pr-group-input pr-group-reason"
                    autoFocus
                    aria-label="Why the group is on hold"
                    placeholder="why? (Enter to hold)"
                    value={edit.text}
                    onChange={(event) => setEdit({ field: "hold", text: event.target.value })}
                    onBlur={() => setEdit(null)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            save();
                        } else if (event.key === "Escape") {
                            setEdit(null);
                        }
                    }}
                />
            ) : (
                <button
                    type="button"
                    className="link pr-group-action"
                    title={
                        hold === undefined
                            ? "Pause this group: nobody works on it, Spinner does not ping about it"
                            : "End the hold"
                    }
                    onClick={() =>
                        hold === undefined
                            ? setEdit({ field: "hold", text: "" })
                            : send(sendJson("DELETE", `${at}/hold`))
                    }
                >
                    {hold === undefined ? "hold" : "resume"}
                </button>
            )}
            {error !== null && <span className="needs-human pr-group-error">{error}</span>}
        </div>
    );
}

/** What the refresh line says: nothing yet, a round in flight, its end, or why it failed. */
type Refresh =
    | { state: "idle" }
    | { state: "checking" }
    | { state: "checked"; at: Date }
    | { state: "failed"; reason: string };

/**
 * The line above the PR table: how often Spinner reads GitHub, and a button that reads it
 * now. The daemon answers when the round over every session ended; the rows then follow
 * from the events, as after a round of its own.
 */
function RefreshLine() {
    const [refresh, setRefresh] = useState<Refresh>({ state: "idle" });
    const check = () => {
        setRefresh({ state: "checking" });
        postAgent("/poll", {}).then(
            () => setRefresh({ state: "checked", at: new Date() }),
            (failure: unknown) => setRefresh({
                state: "failed",
                reason: failure instanceof Error ? failure.message : String(failure),
            }),
        );
    };
    let note = "GitHub is read every minute";
    if (refresh.state === "checked") {
        note = `read from GitHub at ${refresh.at.toLocaleTimeString()}`;
    }
    return (
        <div className="pr-refresh">
            {refresh.state === "failed" ? (
                <span className="needs-human pr-refresh-note" title={refresh.reason}>
                    {refresh.reason}
                </span>
            ) : (
                <span className="muted pr-refresh-note">{note}</span>
            )}
            <button
                type="button"
                className="link"
                disabled={refresh.state === "checking"}
                title="Read every pull request from GitHub now"
                onClick={check}
            >
                {refresh.state === "checking" ? "reading…" : "refresh"}
            </button>
        </div>
    );
}

export function ChangesRail({ view, busy, run, revision, focus }: ChangesRailProps) {
    const [dialog, setDialog] = useState<Dialog | null>(null);
    const [showFinished, setShowFinished] = useState(false);
    const list = useRef<HTMLDivElement | null>(null);
    const dir = view.summary.dir;
    const rows = prTableRows(view, new Date());
    const groups = prTableGroups(view, new Date());
    // A headline is drawn once the session has a group; before that the table is flat.
    const headed = (view.groups ?? []).length > 0;
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
            {rows.open.length + rows.finished.length > 0 && <RefreshLine />}
            {rows.open.length + rows.finished.length > 0 && (
                <div className="pr-table" role="table">
                    <div className="pr-table-row pr-table-head" role="row">
                        {HEADINGS.map(([name, column], index) => (
                            <span key={index} role="columnheader" data-column={column}>
                                {name}
                            </span>
                        ))}
                    </div>
                    {groups.map((bucket) => (
                        <Fragment key={bucket.key}>
                            {headed && <GroupHead dir={dir} bucket={bucket} />}
                            {bucket.rows.map(tableRow)}
                        </Fragment>
                    ))}
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
