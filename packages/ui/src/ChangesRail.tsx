// The PR view (docs/designs/talk-change-ship.md, 2.9; the operator's ask of 2026-11-13): one
// block per change of the session. A block shows the change's state in plain words, `tested`,
// `posted`, what it needs from the operator, a grid of facts per pull request, and the PR
// actions that were the top toolbar's. `merge`, `post` and `approve` act on that change,
// checked out or not (`?change=<id>`); `create PR`, `review` and `fix` on the current one.
// Finished changes fold under a count.
import { useEffect, useRef, useState } from "react";

import type { ChangePr, ChangeView, SessionView } from "@spinner/protocol";

import "./pr-view.css";
import {
    changeCards,
    hasStack,
    isFinished,
    prActions,
    prFacts,
    stateTone,
    type PrAction,
    type PrActionName,
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
    /** The change the PR chip asked for; its block scrolls into view. `seq` moves per ask. */
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

function PrBlock({ pr, now }: { pr: ChangePr; now: Date }) {
    const name = `${pr.repo} #${pr.number}`;
    return (
        <li className="pr-block" data-state={pr.state}>
            <div className="pr-block-head">
                {pr.url === null ? (
                    <span className="change-pr-name">{name}</span>
                ) : (
                    <a
                        className="change-pr-name"
                        href={pr.url}
                        target="_blank"
                        rel="noreferrer"
                        title="Open on GitHub"
                    >
                        {name} ↗
                    </a>
                )}
                {pr.title !== undefined && (
                    <span className="pr-block-title" title={pr.title}>{pr.title}</span>
                )}
                {pr.author !== undefined && <span className="muted">by {pr.author}</span>}
            </div>
            <dl className="pr-facts">
                {prFacts(pr, now).map((fact) => (
                    <div key={fact.label} className="pr-fact" data-tone={fact.tone}>
                        <dt>{fact.label}</dt>
                        <dd title={fact.title}>{fact.text}</dd>
                    </div>
                ))}
            </dl>
        </li>
    );
}

interface Dialog {
    kind: "post" | "approve";
    change: string;
}

interface CardProps {
    dir: string;
    /** True when the session has a stack: `test locally` is offered. */
    stack: boolean;
    change: ChangeView;
    busy: boolean;
    run: RunAction;
    onDialog: (dialog: Dialog) => void;
}

function ChangeCard({ dir, stack, change, busy, run, onDialog }: CardProps) {
    // `merge` cannot be undone, so the first click arms it and the second sends it.
    const [armed, setArmed] = useState(false);
    const now = new Date();
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
    const on = change.on === null ? "" : ` · on ${change.on}`;
    return (
        <li
            className="change-card"
            data-change={change.id}
            data-current={change.current}
            data-tone={stateTone(change.state)}
        >
            <header className="change-head">
                <span className="dot change-dot" aria-hidden="true" />
                <strong className="change-title">{change.title}</strong>
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
                {change.current && (
                    <span className="badge" title="Checked out in the session's worktrees">
                        current
                    </span>
                )}
            </header>
            <div className="muted change-meta" title={change.branch}>
                <span className="change-state">{change.state}</span> · {change.branch}{on}
            </div>
            {change.needs_human !== null && (
                <div className="needs-human change-needs">needs you: {change.needs_human}</div>
            )}
            {change.prs.length > 0 && (
                <ul className="pr-blocks">
                    {change.prs.map((pr) => (
                        <PrBlock key={`${pr.repo}#${pr.number}`} pr={pr} now={now} />
                    ))}
                </ul>
            )}
            {actions.length > 0 && <div className="change-actions">{actions.map(button)}</div>}
        </li>
    );
}

export function ChangesRail({ view, busy, run, revision, focus }: ChangesRailProps) {
    const [dialog, setDialog] = useState<Dialog | null>(null);
    const [showFinished, setShowFinished] = useState(false);
    const list = useRef<HTMLDivElement | null>(null);
    const dir = view.summary.dir;
    const cards = changeCards(view);
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
        // After the fold opens: the block of a finished change mounts with it.
        requestAnimationFrame(() => {
            const block = list.current?.querySelector(`[data-change="${focused.id}"]`);
            block?.scrollIntoView({ block: "start", behavior: "smooth" });
        });
    }, [focus?.seq]);
    const card = (change: ChangeView) => (
        <ChangeCard
            key={change.id}
            dir={dir}
            stack={hasStack(view)}
            change={change}
            busy={busy}
            run={run}
            onDialog={setDialog}
        />
    );
    const close = () => setDialog(null);
    return (
        <div className="changes-rail" aria-label="Pull requests" ref={list}>
            {cards.open.length === 0 && cards.finished.length === 0 && (
                <p className="muted">No change yet. Tell the agent what to build.</p>
            )}
            <ul className="change-list">{cards.open.map(card)}</ul>
            {cards.finished.length > 0 && (
                <>
                    <button
                        className="link changes-finished-toggle"
                        aria-expanded={showFinished}
                        onClick={() => setShowFinished(!showFinished)}
                    >
                        {showFinished ? "▾" : "▸"} {cards.finished.length} finished
                    </button>
                    {showFinished && (
                        <ul className="change-list change-list-finished">
                            {cards.finished.map(card)}
                        </ul>
                    )}
                </>
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
