// The session's actions, at the right end of the context bar: the local stack, the pipeline,
// and behind a `⋯` menu the two that end a round or the session: `reset`, and `archive`, which
// runs the `close` job after one in-place confirm (s038). It left the middle pane so
// that a switch between the agents, mission and threads views changes the whole pane. On a
// narrow window every button moves into the menu, so the bar keeps its title and pills.
import { useEffect, useState } from "react";

import type { SessionView } from "@spinner/protocol";

import { ARCHIVE_QUESTION } from "./CardArchive.tsx";
import { DesignActions } from "./DesignActions.tsx";
import { IconButton } from "./PaneHead.tsx";
import { PipelineActions } from "./PipelineActions.tsx";
import type { RunAction } from "./SessionForms.tsx";

export interface SessionToolbarProps {
    dir: string | undefined;
    /** True when the session has an open PR, which `review` needs. */
    openPr: boolean;
    /** True while a job runs on this session; the buttons wait. */
    busy: boolean;
    run: RunAction;
    /** Moves on pipeline events; the confirm dialogs read the daemon's preview again. */
    revision: number;
    /**
     * The selected session. With a `design` block the design group (entry 3.20) renders left
     * of the stack group. The whole view, not only `design`, because the dialogs prefill
     * absolute paths from the session's path and worktrees.
     */
    view?: SessionView | undefined;
    /** Where a refused design run goes: the drawer, as a failed job's error does. */
    onError?: ((message: string) => void) | undefined;
    /** The confirmed `archive`: the caller runs `close` and moves the selection. */
    onArchive: (dir: string) => void;
}

/** Under this window width the whole toolbar is the menu. */
export const TOOLBAR_COMPACT_PX = 1200;

/** One sentence per session button, as its tooltip. */
const SESSION_TIPS = {
    up: "Start this session's stack on this machine.",
    down: "Stop the local stack; the database and the volumes stay.",
    reset: "Start the next round: a new branch from a fresh base, the facts cleared.",
} as const;

const ARCHIVE_TIP =
    "Archive the session: its agents stop; the containers, the database and the worktrees go.";

type SessionAction = keyof typeof SESSION_TIPS;

/** True under `TOOLBAR_COMPACT_PX`; the toolbar folds on it. */
export function useCompact(): boolean {
    const [compact, setCompact] = useState(window.innerWidth < TOOLBAR_COMPACT_PX);
    useEffect(() => {
        const onResize = () => setCompact(window.innerWidth < TOOLBAR_COMPACT_PX);
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);
    return compact;
}

export function SessionToolbar(props: SessionToolbarProps) {
    const { dir, busy, openPr, run, view } = props;
    const compact = useCompact();
    const [open, setOpen] = useState(false);
    // The `archive` item asks once inside the menu; a closed menu forgets the question.
    const [asking, setAsking] = useState(false);
    const toggleMenu = () => {
        setOpen(!open);
        setAsking(false);
    };
    const off = dir === undefined || busy;
    const post = (action: SessionAction) => () => {
        setOpen(false);
        void run(`/sessions/${dir}/${action}`);
    };
    const button = (action: SessionAction, label: string, danger = false) => (
        <button
            disabled={off}
            title={SESSION_TIPS[action]}
            className={danger ? "danger" : undefined}
            onClick={post(action)}
        >
            {label}
        </button>
    );
    const stack = (
        <span className="toolbar-group">
            {button("up", "run local")}
            {button("down", "stop local")}
        </span>
    );
    const pipeline = (
        <span className="toolbar-group">
            <PipelineActions
                dir={dir}
                busy={busy}
                openPr={openPr}
                run={run}
                revision={props.revision}
            />
        </span>
    );
    const design = view?.design === undefined ? null : (
        <DesignActions view={view} inMenu={compact} onError={props.onError ?? (() => undefined)} />
    );
    const archive = () => {
        setOpen(false);
        setAsking(false);
        if (dir !== undefined) {
            props.onArchive(dir);
        }
    };
    const end = (
        <span className="toolbar-group">
            {button("reset", "reset", true)}
            {asking ? (
                <span className="menu-confirm" role="group" aria-label="Confirm archive">
                    <span className="menu-confirm-text">{ARCHIVE_QUESTION}</span>
                    <span className="card-confirm-actions">
                        <button type="button" className="danger" disabled={off} onClick={archive}>
                            archive
                        </button>
                        <button type="button" onClick={() => setAsking(false)}>
                            cancel
                        </button>
                    </span>
                </span>
            ) : (
                <button
                    disabled={off}
                    title={ARCHIVE_TIP}
                    className="danger"
                    onClick={() => setAsking(true)}
                >
                    archive
                </button>
            )}
        </span>
    );
    return (
        <div
            className={compact ? "actions toolbar toolbar-compact" : "actions toolbar"}
            role="toolbar"
            aria-label="Session actions"
        >
            {!compact && design}
            {!compact && design !== null && <span className="toolbar-sep" />}
            {!compact && stack}
            {!compact && <span className="toolbar-sep" />}
            {!compact && pipeline}
            {!compact && <span className="toolbar-sep" />}
            <span className="toolbar-group toolbar-menu">
                <IconButton
                    icon="more"
                    label="More session actions"
                    active={open}
                    onClick={toggleMenu}
                />
                {open && (
                    // The stack and end buttons close the menu themselves. The pipeline
                    // buttons do not: their confirm dialogs render inside the group, and a
                    // close would unmount them.
                    <div className="menu" role="menu" aria-label="Session actions">
                        {compact && design}
                        {compact && stack}
                        {compact && pipeline}
                        {end}
                    </div>
                )}
            </span>
        </div>
    );
}
