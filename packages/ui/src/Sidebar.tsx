// The sidebar column (s020): the rail pulled out. Each rail icon is a header in the same
// column: `sessions` and `reviews` open and close their section, both may be open, and each
// open section pins its compose box under the header and scrolls its list below it. The
// gear at the foot shows the settings view below the headers. The column resizes with the
// layout's divider; a drag past the snap point folds it back to the rail (`ActivityBar`).
import type { ReactNode } from "react";

import { Icon, IconButton, type IconName } from "./PaneHead.tsx";
import { sectionOpen, type SectionId, type SidebarState } from "./sidebar.ts";

export interface SectionContent {
    /** The rows in the section's list. */
    count: number;
    /** The rows that wait on the operator: a warn pill on the header when not zero. */
    needs: number;
    /** The pane without its head: the compose box and the list. */
    body: ReactNode;
}

export interface SidebarProps {
    state: SidebarState;
    onToggle: (id: SectionId) => void;
    onSettings: () => void;
    sessions: SectionContent;
    reviews: SectionContent;
    settings: ReactNode;
    /** The operator agent's icon at the foot; absent while the agent is off and stopped. */
    operator: { shown: boolean; onToggle: () => void } | undefined;
    /** Folds the column to the rail; absent in the `?pane=` route, which has no rail. */
    onCollapse: (() => void) | undefined;
}

const SECTIONS: readonly { id: SectionId; icon: IconName; label: string }[] = [
    { id: "sessions", icon: "sessions", label: "Sessions" },
    { id: "reviews", icon: "pull-request", label: "Reviews" },
];

function SectionHead(props: {
    id: SectionId;
    icon: IconName;
    label: string;
    open: boolean;
    content: SectionContent;
    onToggle: (id: SectionId) => void;
}) {
    const { id, icon, label, open, content, onToggle } = props;
    const verb = open ? "Hide" : "Show";
    const needs = content.needs === 1 ? "1 needs you" : `${content.needs} need you`;
    return (
        <button
            type="button"
            className="side-head"
            aria-expanded={open}
            aria-controls={`side-${id}`}
            aria-label={`${verb} ${label.toLowerCase()}`}
            title={`${verb} ${label.toLowerCase()}`}
            onClick={() => onToggle(id)}
            data-section={id}
        >
            <Icon name={icon} />
            <span className="side-head-label">{label}</span>
            <span className="muted side-head-count">{content.count}</span>
            {content.needs > 0 && (
                <span className="pill pill-warn side-head-needs" title={needs}>
                    {content.needs}
                </span>
            )}
            <span className="side-head-chevron" aria-hidden="true">
                {open ? "\u25be" : "\u25b8"}
            </span>
        </button>
    );
}

export function Sidebar(props: SidebarProps) {
    const { state, onToggle, onSettings, settings, operator, onCollapse } = props;
    return (
        <nav className="sidebar" aria-label="Sidebar" data-settings={state.settings || undefined}>
            {SECTIONS.map(({ id, icon, label }) => {
                const open = sectionOpen(state, id);
                const content = props[id];
                return (
                    <div
                        key={id}
                        className={open ? "side-section side-section-open" : "side-section"}
                        data-section={id}
                    >
                        <SectionHead
                            id={id}
                            icon={icon}
                            label={label}
                            open={open}
                            content={content}
                            onToggle={onToggle}
                        />
                        {open && (
                            <div className="side-body" id={`side-${id}`}>
                                {content.body}
                            </div>
                        )}
                    </div>
                );
            })}
            {state.settings && <div className="side-settings">{settings}</div>}
            <footer className="side-foot">
                {onCollapse !== undefined && (
                    <IconButton
                        icon="panel-left"
                        label="Collapse sidebar"
                        onClick={onCollapse}
                    />
                )}
                <span className="side-foot-gap" />
                {operator !== undefined && (
                    <IconButton
                        icon="operator"
                        label={operator.shown ? "Hide operator" : "Show operator"}
                        active={operator.shown}
                        className="bar-operator"
                        onClick={operator.onToggle}
                    />
                )}
                <IconButton
                    icon="gear"
                    label={state.settings ? "Hide settings" : "Show settings"}
                    active={state.settings}
                    onClick={onSettings}
                />
            </footer>
        </nav>
    );
}
