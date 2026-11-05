// The chrome around the panes: the icon set (inline SVG, no dependency), the icon button, a
// pane header, the strip of a collapsed or popped-out pane, the activity bar at the far left
// and the context bar that names the active session. Chrome shows icons with tooltips, never
// link text.
import type { ReactNode } from "react";

import type { CostTotals, DesignTrack, PrFacts, SessionView } from "@spinner/protocol";

import { formatTokens, formatUsd } from "./costs.ts";
import { trackChoices } from "./design.ts";
import type { PaneName } from "./layout.ts";
import {
    ciPill, decisionPill, draftPill, reviewFacts, reviewStatePill, type Pill, type ReviewFacts,
} from "./review.ts";
import { fetchEgm, putDesignTrack, useLoaded } from "./remote.ts";
import { roundBadge, roundTooltip } from "./rounds.ts";
import { needsHuman, stageOf } from "./state.ts";
import {
    machineLine,
    memoryLow,
    stackLine,
    stackUsageOf,
    type UsageSample,
} from "./usage.ts";
import { useMenu } from "./useMenu.ts";

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
    /** The pane, or a view that takes a pane's place (`reviews`, `settings` in the side panel). */
    name: PaneName | "reviews" | "settings";
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
 * A view of the left panel, one icon each in the activity bar: the sessions, the reviews of
 * the peers' PRs (s015), and settings at the bottom.
 */
export interface PanelView {
    id: "sessions" | "reviews" | "settings";
    icon: IconName;
    label: string;
    /** Drawn at the bottom of the bar, apart from the views above. */
    bottom?: boolean;
}

export const PANEL_VIEWS: readonly PanelView[] = [
    { id: "sessions", icon: "sessions", label: "Sessions" },
    { id: "reviews", icon: "pull-request", label: "Reviews" },
    { id: "settings", icon: "gear", label: "Settings", bottom: true },
];

export interface ActivityBarProps {
    /** The view the side panel shows on screen, or undefined while it is collapsed. */
    shown: PanelView["id"] | undefined;
    /** True when the left panel lives in its own window; its icon then docks it back. */
    popped: boolean;
    onPick: (view: PanelView["id"]) => void;
    /** The needs-you count of each list view: a badge on its icon when not zero, always. */
    needs: Record<"sessions" | "reviews", number>;
    /** True while the middle pane shows the operator agent's terminal in place of the session. */
    operatorShown: boolean;
    /** False hides the headset: the operator agent is off and not running (s014). */
    operatorAvailable: boolean;
    /** Shows the operator tab, or the session again when it is shown. */
    onOperator: () => void;
}

/**
 * The rail, always at the far left (s020, round 2: VS Code's activity bar). A click on an icon
 * opens its view in the side panel; a click on the lit icon collapses the panel. The operator
 * icon, above the gear, is not a view: it swaps the middle pane between the session and the
 * operator.
 */
export function ActivityBar(props: ActivityBarProps) {
    const { shown, popped, onPick, needs, operatorShown, operatorAvailable, onOperator } = props;
    const operator = !operatorAvailable ? null : (
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
                const classes = [
                    popped ? "bar-popped" : "", view.bottom === true ? "bar-bottom" : "",
                ];
                const button = (
                    <IconButton
                        key={view.id}
                        icon={view.icon}
                        label={label}
                        active={on}
                        className={classes.join(" ").trim() || undefined}
                        onClick={() => onPick(view.id)}
                    />
                );
                // The first bottom view takes the operator icon above it.
                if (view.bottom === true) {
                    return [operator, button];
                }
                const count = view.id === "settings" ? 0 : needs[view.id];
                return (
                    <span key={view.id} className="bar-item">
                        {button}
                        {count > 0 && (
                            <span
                                className="bar-badge"
                                data-section={view.id}
                                title={count === 1 ? "1 needs you" : `${count} need you`}
                            >
                                {count}
                            </span>
                        )}
                    </span>
                );
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

/** A state pill of a review (s015): the CI state, the review decision. */
export function StatePill({ pill, className }: { pill: Pill; className: string }) {
    return (
        <span className={`pill ${pill.tone} ${className}`.trim()} title={pill.title}>
            {pill.text}
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
 * and `needs you` line, from `SessionView` alone, then the session's toolbar at the right end.
 * One line, the title truncated.
 */
export interface ContextBarProps {
    view: SessionView | undefined;
    /** The last usage sample: the session's line and the machine line. */
    usage: UsageSample | null;
    /** The operator agent's notice when it is not running, with the way to start it again. */
    operator?: { notice: string; onResume: () => void } | undefined;
    /** The session's actions (`SessionToolbar`), after the needs-you pill. */
    toolbar?: ReactNode;
    /** Where a failed track switch goes: the drawer, as a failed job's error does. */
    onError?: ((message: string) => void) | undefined;
    /**
     * Set while a gate card or the resolve card shows (entry 3.22): the `needs you` pill is a
     * button that opens the card, in the `agents` view with `lead` picked.
     */
    onNeeds?: (() => void) | undefined;
    /** Set for a session with a `design` block (entry 5.11): the round badge opens History. */
    onRound?: (() => void) | undefined;
}

/** The `needs you` pill: a button that opens the gate card when `onNeeds` is set. */
function NeedsPill({ needs, onNeeds }: { needs: string; onNeeds: (() => void) | undefined }) {
    if (onNeeds === undefined) {
        return (
            <span className="needs-human pill pill-warn context-needs" title={needs}>
                {needs}
            </span>
        );
    }
    return (
        <button
            type="button"
            className="needs-human pill pill-warn context-needs context-needs-button"
            title={`${needs} · open the question`}
            onClick={onNeeds}
        >
            {needs}
        </button>
    );
}

/**
 * `r3` after the title from round 2 on (entry 2.47), on every session; the tooltip lists the
 * PRs of each earlier round.
 */
export function RoundBadge(
    { view, onRound }: { view: SessionView; onRound?: (() => void) | undefined },
) {
    const badge = roundBadge(view);
    if (badge === null) {
        return null;
    }
    const title = roundTooltip(view.rounds ?? []);
    if (onRound !== undefined) {
        return (
            <button
                type="button"
                className="badge round-badge round-badge-button"
                title={title}
                onClick={onRound}
            >
                {badge}
            </button>
        );
    }
    return (
        <span className="badge round-badge" title={title}>
            {badge}
        </span>
    );
}

/**
 * The track chip (entry 2.33): the session's track and, behind the chevron, the other tracks
 * that `GET /egm` allows. `design` is offered only while EGM is ready with pi-subagents. An
 * empty menu shows no chevron. A pick sends `PUT .../design/track`; the daemon's
 * `session.updated` moves the chip, and a refusal goes to the drawer.
 */
function TrackChip(props: {
    dir: string;
    track: DesignTrack;
    onError: ((message: string) => void) | undefined;
}) {
    const { dir, track, onError } = props;
    const egm = useLoaded(`egm#${dir}`, fetchEgm).value?.egm ?? null;
    const menu = useMenu<HTMLSpanElement>();
    const others = trackChoices(egm).filter((choice) => choice !== track);
    const pick = (choice: DesignTrack) => {
        menu.close();
        putDesignTrack(dir, choice).catch((failure: unknown) => onError?.(String(failure)));
    };
    if (others.length === 0) {
        return (
            <span className="pill track-chip" title="The session's track">
                {track}
            </span>
        );
    }
    return (
        <span className="track-menu" ref={menu.ref}>
            <button
                type="button"
                className="pill track-chip"
                title="The session's track; click to switch"
                aria-expanded={menu.open}
                onClick={menu.toggle}
            >
                {track} {"\u25be"}
            </button>
            {menu.open && (
                <div className="menu" role="menu" aria-label="Track">
                    {others.map((choice) => (
                        <button key={choice} type="button" onClick={() => pick(choice)}>
                            {choice}
                        </button>
                    ))}
                </div>
            )}
        </span>
    );
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

/**
 * The review state pill and the draft's count or `approve` (s018), the same on the card,
 * the PR header and the context bar. `reviewing` carries a working dot.
 */
export function ReviewStatePills({ facts }: { facts: ReviewFacts }) {
    const state = reviewStatePill(facts.state);
    const draft = draftPill(facts);
    return (
        <>
            {state !== null && (
                <span
                    className={`pill ${state.tone} rv-state rv-state-${facts.state}`}
                    title={state.title}
                    data-state={facts.state}
                >
                    {facts.state === "reviewing" && <span className="dot rv-state-dot" />}
                    {state.text}
                </span>
            )}
            {draft !== null && <StatePill pill={draft} className="rv-draft-pill" />}
        </>
    );
}

/** The pills of a review card and PR header: CI, the decision, the threads, the state, the cost. */
export function ReviewPills({ facts }: { facts: ReviewFacts }) {
    return (
        <span className="badges rv-pills">
            <StatePill pill={ciPill(facts.checks, facts.failing)} className="rv-ci" />
            <StatePill pill={decisionPill(facts.decision)} className="rv-decision" />
            <span className="pill rv-threads" title={`${facts.threads} review threads`}>
                ⑂ {facts.threads}
            </span>
            <ReviewStatePills facts={facts} />
            {facts.usd !== null && (
                <span className="muted usage-cost rv-cost">{formatUsd(facts.usd)}</span>
            )}
        </span>
    );
}

export function ContextBar(props: ContextBarProps) {
    const { view, usage, operator, toolbar, onError, onNeeds, onRound } = props;
    if (view === undefined) {
        return (
            <div className="context-bar muted">
                No session selected. <MachineLine usage={usage} />
                <OperatorNotice operator={operator} />
                {toolbar}
            </div>
        );
    }
    const review = reviewFacts(view);
    const needs = needsHuman(view);
    if (review !== null) {
        // A review: the PR's facts in place of the stage and the stack; `review` as the toolbar.
        // `needs_human` is the lead's draft waiting for `post` or `drop` (s016).
        return (
            <div className="context-bar rv-context" aria-label="Review">
                <span className="context-title" title={review.title}>
                    {review.title}
                </span>
                <RoundBadge view={view} />
                <span className="badge">review</span>
                <code className="muted rv-branches">{review.branch} → {review.base}</code>
                <StatePill pill={ciPill(review.checks, review.failing)} className="rv-ci" />
                <StatePill pill={decisionPill(review.decision)} className="rv-decision" />
                <span className="pill rv-threads" title={`${review.threads} review threads`}>
                    ⑂ {review.threads}
                </span>
                <ReviewStatePills facts={review} />
                <CostFigure cost={view.cost} />
                <MachineLine usage={usage} />
                {needs !== null && (
                    <span className="needs-human pill pill-warn context-needs" title={needs}>
                        {needs}
                    </span>
                )}
                <OperatorNotice operator={operator} />
                {toolbar}
            </div>
        );
    }
    const stack = stackUsageOf(view, usage);
    return (
        <div className="context-bar" aria-label="Session">
            <span className="context-title" title={view.summary.session.title}>
                {view.summary.session.title}
            </span>
            <RoundBadge view={view} onRound={onRound} />
            <span className="badge">{stageOf(view)}</span>
            <span className="pill context-stack">
                <span className={`dot dot-${view.stack.state}`} />
                stack {view.stack.state}
            </span>
            {stack !== null && <span className="muted usage-line">{stackLine(stack)}</span>}
            <CostFigure cost={view.cost} />
            <MachineLine usage={usage} />
            <PrBadge prs={view.board?.prs ?? []} />
            {needs !== null && <NeedsPill needs={needs} onNeeds={onNeeds} />}
            <OperatorNotice operator={operator} />
            {view.design !== undefined && (
                <TrackChip dir={view.summary.dir} track={view.design.track} onError={onError} />
            )}
            {toolbar}
        </div>
    );
}
