// The side panel (s020, round 2): VS Code's shape. The rail (`ActivityBar`) stays at the far
// left; this panel beside it shows the one view the rail picked: sessions, reviews or
// settings. A title row names the view with its count; the sessions and reviews views pin
// their `+ New …` button under it and scroll their list below. The needs-you badge lives on
// the rail icon alone (dogfood row 2): a second pill on the title row said the same thing.
// The panel resizes with the layout's divider; a drag past the snap point folds it, and the
// rail stays.
import type { ReactNode } from "react";

import type { SidebarView, WidthLevel } from "./sidebar.ts";

/** What the title row shows beside a list view's name. */
export interface ViewFacts {
    /** The rows in the view's list. */
    count: number;
}

export interface SidebarProps {
    view: SidebarView;
    /** The cards' detail at the panel's width (`widthLevel`), as `data-level` for the CSS. */
    level: WidthLevel;
    /** The count of the list views; settings shows its name alone. */
    facts: ViewFacts | undefined;
    /** The view's pane without a head of its own. */
    children: ReactNode;
}

const TITLES: Record<SidebarView, string> = {
    sessions: "Sessions", prs: "Pull requests", plans: "Plans", reviews: "Reviews",
    settings: "Settings",
};

function TitleRow({ view, facts }: { view: SidebarView; facts: ViewFacts | undefined }) {
    return (
        <header className="side-title" data-view={view}>
            <h2 className="side-title-label">{TITLES[view]}</h2>
            {facts !== undefined && (
                <span className="muted side-title-count">{facts.count}</span>
            )}
        </header>
    );
}

/**
 * The pinned "+ New …" button of a section that opens the composer in the working area
 * (s038). It is pressed while the composer it opens shows.
 */
export function NewButton(props: { label: string; active: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            className="side-add"
            onClick={props.onClick}
            aria-label={props.label}
            aria-pressed={props.active}
        >
            + {props.label}
        </button>
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
