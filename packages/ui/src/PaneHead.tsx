// The chrome around the panes: the icon set (inline SVG, no dependency), the icon button, a
// pane header, the strip of a collapsed or popped-out pane, the activity bar at the far left
// and the context bar that names the active session. Chrome shows icons with tooltips, never
// link text.
import type { CostTotals, PrFacts, SessionView } from "@spinner/protocol";

import { formatTokens, formatUsd } from "./costs.ts";
import type { PaneName } from "./layout.ts";
import { needsHuman, stageOf } from "./state.ts";
import {
    machineLine,
    memoryLow,
    stackLine,
    stackUsageOf,
    type UsageSample,
} from "./usage.ts";

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
    | "close"
    | "minimize"
    | "gear"
    | "operator"
    | "pull-request";

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
    minimize: "M3 11h10",
    gear:
        "M8 5.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" +
        "M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4",
    "pull-request":
        "M4 5v8M4 5a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3M4 13a1.5 1.5 0 1 0 0 3" +
        "M12 13V8a3 3 0 0 0-3-3H7M9 3L7 5l2 2M12 13a1.5 1.5 0 1 0 0 3",
    // A headset: the operator agent, the one that talks back.
    operator:
        "M3 9V8a5 5 0 0 1 10 0v1M2.5 9h2v4h-2zM11.5 9h2v4h-2z" +
        "M13.5 13a2 2 0 0 1-2 1.5H9.5",
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
    /** The pane, or a view that takes a pane's place (`settings` in the side panel). */
    name: PaneName | "settings";
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
 * A view of the left panel, one icon each in the activity bar. Today there is one; the board,
 * threads and settings come later.
 */
export interface PanelView {
    id: "sessions" | "settings";
    icon: IconName;
    label: string;
    /** Drawn at the bottom of the bar, apart from the views above. */
    bottom?: boolean;
}

export const PANEL_VIEWS: readonly PanelView[] = [
    { id: "sessions", icon: "sessions", label: "Sessions" },
    { id: "settings", icon: "gear", label: "Settings", bottom: true },
];

export interface ActivityBarProps {
    /** The view the left panel shows, or undefined while the panel is hidden. */
    shown: PanelView["id"] | undefined;
    /** True when the left panel lives in its own window; its icon then docks it back. */
    popped: boolean;
    onPick: (view: PanelView["id"]) => void;
    /** True while the middle pane shows the operator agent's terminal in place of the session. */
    operatorShown: boolean;
    /** Shows the operator tab, or the session again when it is shown. */
    onOperator: () => void;
}

/**
 * The narrow bar at the left, one icon per left-panel view. A click on the active icon hides
 * the panel; a click on any icon shows the panel on that view. The operator icon, above the
 * gear, is not a panel view: it swaps the middle pane between the session and the operator.
 */
export function ActivityBar(props: ActivityBarProps) {
    const { shown, popped, onPick, operatorShown, onOperator } = props;
    const operator = (
        <IconButton
            key="operator"
            icon="operator"
            label={operatorShown ? "Hide operator" : "Show operator"}
            active={operatorShown}
            className="bar-bottom bar-operator"
            onClick={onOperator}
        />
    );
    return (
        <nav className="activity-bar" aria-label="Views">
            {PANEL_VIEWS.map((view) => {
                const on = shown === view.id;
                const label = popped
                    ? `Dock ${view.label.toLowerCase()} back`
                    : `${on ? "Hide" : "Show"} ${view.label.toLowerCase()}`;
                const classes = [popped ? "bar-popped" : ""];
                const button = (
                    <IconButton
                        key={view.id}
                        icon={view.icon}
                        label={label}
                        active={on}
                        className={classes.join(" ").trim()}
                        onClick={() => onPick(view.id)}
                    />
                );
                // The first bottom view takes the operator icon above it.
                return view.bottom === true ? [operator, button] : button;
            })}
        </nav>
    );
}

/**
 * `$1.23`: what a session (or the operator agent) has spent, beside the usage line of a card
 * and the context bar; the tokens in the tooltip. Nothing from a daemon before s013.
 */
export function CostFigure({ cost }: { cost: CostTotals | undefined }) {
    if (cost === undefined) {
        return null;
    }
    const tokens = `${formatTokens(cost.tokens_in)} in · ${formatTokens(cost.tokens_out)} out`;
    return (
        <span className="muted usage-cost" title={tokens}>
            {formatUsd(cost.usd)}
        </span>
    );
}

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
export interface ContextBarProps {
    view: SessionView | undefined;
    /** The last usage sample: the session's line and the machine line. */
    usage: UsageSample | null;
    /** The operator agent's notice when it is not running, with the way to start it again. */
    operator?: { notice: string; onResume: () => void } | undefined;
}

/** `operator agent not running · resume`: the only control the context bar has. */
function OperatorNotice({ operator }: Pick<ContextBarProps, "operator">) {
    if (operator === undefined) {
        return null;
    }
    return (
        <span className="needs-human operator-notice">
            {operator.notice}{" "}
            <button type="button" className="link" onClick={operator.onResume}>
                resume
            </button>
        </span>
    );
}

/** The machine line: `machine 9.8 / 32 GB · 3 stacks up`, red when free memory is low. */
function MachineLine({ usage }: { usage: UsageSample | null }) {
    if (usage === null) {
        return null;
    }
    const low = memoryLow(usage.machine);
    return (
        <span
            className={low ? "needs-human machine-line" : "muted machine-line"}
            title={low ? "Free memory is under 10 %" : "Memory used of the total"}
        >
            {machineLine(usage.machine)}
        </span>
    );
}

export function ContextBar({ view, usage, operator }: ContextBarProps) {
    if (view === undefined) {
        return (
            <div className="context-bar muted">
                No session selected. <MachineLine usage={usage} />
                <OperatorNotice operator={operator} />
            </div>
        );
    }
    const needs = needsHuman(view);
    const stack = stackUsageOf(view, usage);
    return (
        <div className="context-bar" aria-label="Session">
            <span className="context-title" title={view.summary.session.title}>
                {view.summary.session.title}
            </span>
            <span className="badge">{stageOf(view)}</span>
            <span className="pill context-stack">
                <span className={`dot dot-${view.stack.state}`} />
                stack {view.stack.state}
            </span>
            {stack !== null && <span className="muted usage-line">{stackLine(stack)}</span>}
            <CostFigure cost={view.cost} />
            <MachineLine usage={usage} />
            <PrBadge prs={view.board?.prs ?? []} />
            {needs !== null && (
                <span className="needs-human pill pill-warn context-needs" title={needs}>
                    {needs}
                </span>
            )}
            <OperatorNotice operator={operator} />
        </div>
    );
}
