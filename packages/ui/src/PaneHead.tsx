// The chrome around the panes: the icon set (inline SVG, no dependency), the icon button, a
// pane header, the strip of a collapsed or popped-out pane and the context bar that names the
// active session. Chrome shows icons with tooltips, never link text.
import type { PrFacts, SessionView } from "@spinner/protocol";

import type { PaneName } from "./layout.ts";
import { needsHuman, stageOf } from "./state.ts";

export type IconName =
    | "sessions"
    | "panel-left"
    | "panel-right"
    | "expand"
    | "shrink"
    | "pop-out"
    | "globe"
    | "reload"
    | "devtools"
    | "back"
    | "forward"
    | "more"
    | "close";

/** 16 px glyphs on a 16-unit grid, stroked in `currentColor`. */
const GLYPHS: Record<IconName, string> = {
    sessions: "M2 4h2M6 4h8M2 8h2M6 8h8M2 12h2M6 12h8",
    "panel-left": "M2.5 3.5h11v9h-11zM6 3.5v9",
    "panel-right": "M2.5 3.5h11v9h-11zM10 3.5v9",
    expand: "M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9",
    shrink: "M13.5 6.5h-4v-4M9.5 6.5L14 2M2.5 9.5h4v4M6.5 9.5L2 14",
    "pop-out": "M7 3H3v10h10V9M9.5 2.5h4v4M13.5 2.5L8 8",
    globe:
        "M8 2a6 6 0 1 0 0 12a6 6 0 1 0 0-12M2 8h12" +
        "M8 2c-2.5 2.5-2.5 9.5 0 12M8 2c2.5 2.5 2.5 9.5 0 12",
    reload: "M13 8a5 5 0 1 1-1.6-3.7M13.5 2.5v3h-3",
    devtools: "M6 4L2 8l4 4M10 4l4 4-4 4",
    back: "M10 3L5 8l5 5",
    forward: "M6 3l5 5-5 5",
    more: "M3 8h.01M8 8h.01M13 8h.01",
    close: "M4 4l8 8M12 4l-8 8",
};

export function Icon({ name }: { name: IconName }) {
    return (
        <svg
            className="icon"
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d={GLYPHS[name]} />
        </svg>
    );
}

export interface IconButtonProps {
    icon: IconName;
    /** The tooltip and the accessible name. */
    label: string;
    onClick: () => void;
    /** True when the button shows an "on" state, for example a shown panel. */
    active?: boolean | undefined;
    className?: string | undefined;
}

export function IconButton({ icon, label, onClick, active, className }: IconButtonProps) {
    const classes = ["icon-button", active === true ? "icon-on" : "", className ?? ""];
    return (
        <button
            type="button"
            className={classes.join(" ").trim()}
            onClick={onClick}
            title={label}
            aria-label={label}
            aria-pressed={active}
        >
            <Icon name={icon} />
        </button>
    );
}

export interface PaneHeadProps {
    name: PaneName;
    /** The icon buttons at the right; none when the `?pane=` route renders the pane alone. */
    controls: IconButtonProps[] | undefined;
    /** An icon button at the left of the title, for example the side-panel toggle. */
    leading?: IconButtonProps | undefined;
}

export function PaneHead({ name, controls, leading }: PaneHeadProps) {
    return (
        <header className="pane-head">
            <span className="pane-title">
                {leading !== undefined && <IconButton {...leading} />}
                <h2>{name}</h2>
            </span>
            {controls !== undefined && controls.length > 0 && (
                <span className="pane-controls">
                    {controls.map((control) => (
                        <IconButton key={control.label} {...control} />
                    ))}
                </span>
            )}
        </header>
    );
}

export interface PaneStripProps {
    name: PaneName;
    popped: boolean;
    /** Restores a collapsed pane, or docks a popped-out one back. */
    onRestore: () => void;
}

/** The 24 px strip that stands in for a collapsed or popped-out pane. */
export function PaneStrip({ name, popped, onRestore }: PaneStripProps) {
    const verb = popped ? "Dock" : "Restore";
    return (
        <button
            className={popped ? "strip strip-popped" : "strip"}
            onClick={onRestore}
            aria-label={`${verb} ${name}`}
            title={popped ? `${name} is in its own window; click to dock it back` : `Show ${name}`}
            data-pane={name}
        >
            {popped ? `${name} · popped out` : name}
        </button>
    );
}

/**
 * A view of the left panel. Today there is one; the board, threads and settings come later as
 * tabs inside the panel. The panel itself shows and hides from the top bar's toggle.
 */
export interface PanelView {
    id: "sessions";
    icon: IconName;
    label: string;
}

export const PANEL_VIEWS: readonly PanelView[] = [
    { id: "sessions", icon: "sessions", label: "Sessions" },
];

/** `⑂ 4`: the session's PR count; green once every PR's checks are green. */
export function PrBadge({ prs }: { prs: PrFacts[] }) {
    if (prs.length === 0) {
        return null;
    }
    const green = prs.every((pr) => pr.checks === "green");
    const title = green ? "All checks green" : "Checks pending or red";
    return (
        <span className={green ? "pr-badge pr-badge-green" : "pr-badge"} title={title}>
            ⑂ {prs.length}
        </span>
    );
}

/**
 * The bar above the panes, always visible: the active session's title, stage, stack, PR count
 * and `needs you` line, from `SessionView` alone. One line, the title truncated; no controls.
 */
export function ContextBar({ view }: { view: SessionView | undefined }) {
    if (view === undefined) {
        return <div className="context-bar muted">No session selected.</div>;
    }
    const needs = needsHuman(view);
    return (
        <div className="context-bar" aria-label="Session">
            <span className="context-title" title={view.summary.session.title}>
                {view.summary.session.title}
            </span>
            <span className="badge">{stageOf(view)}</span>
            <span className={`dot dot-${view.stack.state}`} />
            <span className="muted">stack {view.stack.state}</span>
            <PrBadge prs={view.board?.prs ?? []} />
            {needs !== null && <span className="needs-human">{needs}</span>}
        </div>
    );
}
