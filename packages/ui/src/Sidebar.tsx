// The side panel (s020, round 2): VS Code's shape. The rail (`ActivityBar`) stays at the far
// left; this panel beside it shows the one view the rail picked: sessions, reviews or
// settings. A title row names the view with its count and needs-you pill; the sessions and
// reviews views pin their `+ New …` button under it and scroll their list below. The panel
// resizes with the layout's divider; a drag past the snap point folds it, and the rail stays.
import { useState, type ReactNode } from "react";

import { IconButton } from "./PaneHead.tsx";
import type { SidebarView, WidthLevel } from "./sidebar.ts";

/** What the title row shows beside a list view's name. */
export interface ViewFacts {
    /** The rows in the view's list. */
    count: number;
    /** The rows that wait on the operator: a warn pill when not zero. */
    needs: number;
}

export interface SidebarProps {
    view: SidebarView;
    /** The cards' detail at the panel's width (`widthLevel`), as `data-level` for the CSS. */
    level: WidthLevel;
    /** The count and the needs pill of the list views; settings shows its name alone. */
    facts: ViewFacts | undefined;
    /** The view's pane without a head of its own. */
    children: ReactNode;
}

const TITLES: Record<SidebarView, string> = {
    sessions: "Sessions", reviews: "Reviews", settings: "Settings",
};

function TitleRow({ view, facts }: { view: SidebarView; facts: ViewFacts | undefined }) {
    const needs = facts === undefined ? 0 : facts.needs;
    return (
        <header className="side-title" data-view={view}>
            <h2 className="side-title-label">{TITLES[view]}</h2>
            {facts !== undefined && (
                <span className="muted side-title-count">{facts.count}</span>
            )}
            {needs > 0 && (
                <span
                    className="pill pill-warn side-title-needs"
                    title={needs === 1 ? "1 needs you" : `${needs} need you`}
                >
                    {needs}
                </span>
            )}
        </header>
    );
}

/**
 * The pinned "+ New …" button of a section. A click opens the form in its place with a
 * cancel at its head; the form closes itself after a start through `close`, and a cancel
 * keeps whatever draft the caller holds.
 */
export function AddNew(props: { label: string; children: (close: () => void) => ReactNode }) {
    const { label, children } = props;
    const [open, setOpen] = useState(false);
    const close = () => setOpen(false);
    if (!open) {
        return (
            <button
                type="button"
                className="side-add"
                onClick={() => setOpen(true)}
                aria-label={label}
            >
                + {label}
            </button>
        );
    }
    return (
        <div className="side-add-open" aria-label={`${label} form`}>
            <div className="side-add-head">
                <span className="side-add-title">{label}</span>
                <IconButton icon="close" label={`Cancel ${label.toLowerCase()}`} onClick={close} />
            </div>
            {children(close)}
        </div>
    );
}

export function Sidebar({ view, level, facts, children }: SidebarProps) {
    return (
        <nav className="sidebar" aria-label="Sidebar" data-level={level} data-view={view}>
            <TitleRow view={view} facts={facts} />
            <div className="side-body">{children}</div>
        </nav>
    );
}
