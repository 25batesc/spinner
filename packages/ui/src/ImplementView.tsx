// The Implement view (docs/designs/session-workspace.md, T6, L1): the one place where the
// operator reads the tasks and their status. A goal block (the doc's first Overview paragraph
// on the design track, the editable goal otherwise), a sticky header with the entry counts
// and the `doing` filter, the Plan as a phase-first list (one collapsible section per phase,
// one row per item with a state dot), a rail with the roster's live dots, the questions and
// the contracts, then the Log across the width. The view never fetches and never writes:
// `MissionWorkspace` owns the data; `implement.ts` holds the rules.
import { useMemo, useState, type ReactNode } from "react";

import { scan, type AgentSpec, type DesignView, type PlanScan } from "@spinner/protocol";

import {
    GOAL_CLAMP_CHARS, goalParagraph, goalSource, headerText, implementState, needsAgent,
    phaseGroups, railState, type PhaseGroup, type PlanRow, type RailState,
} from "./implement.ts";
import {
    AgentOrder, Contracts, DoneWhen, doneKeys, EditableText, Item, itemKey, LogFeed, Pulse,
    Questions, RosterChip, Section, useArrivals, isBlocked, type MissionWorkspaceViewProps,
    type RowContext,
} from "./MissionWorkspaceView.tsx";

export interface ImplementViewProps extends MissionWorkspaceViewProps {
    /** The design doc's text from the agents pane (D15); null before the fetch or without one. */
    docText: string | null;
    design: DesignView | undefined;
    /** The agents the daemon hosts now. */
    agentsRunning: readonly string[];
    agentSpecs: Record<string, AgentSpec>;
    /** The session's `needs_human` line, or null. */
    needs: string | null;
    /** Opens the Agents view with the agent picked: a rail chip. */
    onOpenAgent: (name: string) => void;
    /** Opens another view: `open in Draft`. */
    onOpenView: (id: "draft") => void;
}

export function ImplementView(props: ImplementViewProps) {
    const { mission, docText, design } = props;
    const ticked = useArrivals(doneKeys(mission));
    const rows: RowContext = { ...props, ticked };
    const [doingOnly, setDoingOnly] = useState(false);
    const source = goalSource(design);
    // The scan runs once per doc text; the groups once per scan and Plan (T6).
    const parsed = useMemo<PlanScan | null>(
        () => (source === "doc" && docText !== null ? scan(docText) : null),
        [source, docText],
    );
    const groups = useMemo(() => phaseGroups(mission.plan, parsed), [parsed, mission.plan]);
    const state = implementState(design, parsed);
    const entries = source === "doc" ? headerText(state, parsed, mission.plan) : null;
    const authors = [...new Set([...props.agents, ...mission.log.map((line) => line.author)])];
    return (
        <AgentOrder.Provider value={authors}>
            <div className="mw im" aria-label="Implement" data-state={state}>
                {props.error !== null && <p className="mw-error" role="alert">{props.error}</p>}
                <div className="im-grid">
                    <div className="im-main">
                        <GoalBlock
                            mission={mission}
                            rows={rows}
                            source={source}
                            docText={docText}
                            onOpenDraft={() => props.onOpenView("draft")}
                        />
                        <div className="im-header" aria-label="State of the work">
                            <Pulse
                                mission={mission}
                                counts={{ entries, doneWhen: source === "mission" }}
                            />
                            <button
                                type="button"
                                className={doingOnly
                                    ? "pill pill-accent im-doing-filter"
                                    : "pill im-doing-filter"}
                                aria-pressed={doingOnly}
                                title="Show only the rows an agent is on"
                                onClick={() => setDoingOnly(!doingOnly)}
                            >
                                doing
                            </button>
                        </div>
                        <PlanList groups={groups} rows={rows} doingOnly={doingOnly} />
                        {source === "mission" && <DoneWhen items={mission.done_when} rows={rows} />}
                    </div>
                    <aside className="im-rail" aria-label="Roster">
                        <RosterRail {...props} />
                        <Questions
                            questions={mission.questions}
                            pending={props.pending}
                            onAnswer={props.onAnswer}
                        />
                        <Contracts contracts={mission.contracts} rows={rows} />
                    </aside>
                    <LogFeed
                        log={mission.log}
                        agents={authors}
                        filter={props.filter}
                        onFilter={props.onFilter}
                    />
                </div>
            </div>
        </AgentOrder.Provider>
    );
}

/**
 * The goal block (D4): on the design track the first paragraph of the doc's Overview,
 * clamped as the Goal card was, read-only, with `open in Draft`; else the editable goal.
 */
function GoalBlock(props: {
    mission: MissionWorkspaceViewProps["mission"];
    rows: RowContext;
    source: "doc" | "mission";
    docText: string | null;
    onOpenDraft: () => void;
}) {
    const { mission, rows, source, docText, onOpenDraft } = props;
    const [expanded, setExpanded] = useState(false);
    if (source === "mission") {
        return (
            <section className="mw-section mw-goal im-goal" data-section="goal" aria-label="Goal">
                <h3 className="mw-label">Goal</h3>
                <h2 className="mw-title">{mission.title}</h2>
                <EditableText
                    id="goal"
                    text={mission.goal}
                    multiline
                    empty="The lead writes the goal here from the first message."
                    pending={rows.pending === itemKey("goal", 0)}
                    onSave={(text) => rows.onEdit("goal", 0, text)}
                />
            </section>
        );
    }
    const paragraph = docText === null ? null : goalParagraph(docText);
    const long = paragraph !== null && paragraph.length > GOAL_CLAMP_CHARS;
    let body: ReactNode;
    if (docText === null) {
        body = <p className="mw-empty">Loading the design doc…</p>;
    } else if (paragraph === null) {
        body = <p className="mw-empty">The design doc has no Overview yet.</p>;
    } else {
        const clamped = long && !expanded;
        body = (
            <p className={clamped ? "mw-text im-goal-text mw-clamped" : "mw-text im-goal-text"}>
                {paragraph}
            </p>
        );
    }
    return (
        <section className="mw-section mw-goal im-goal" data-section="goal" aria-label="Goal">
            <h3 className="mw-label">
                Goal
                <button type="button" className="link im-open-draft" onClick={onOpenDraft}>
                    open in Draft
                </button>
            </h3>
            <h2 className="mw-title">{mission.title}</h2>
            {body}
            {long && (
                <button className="mw-ghost mw-more" onClick={() => setExpanded(!expanded)}>
                    {expanded ? "show less" : "show all"}
                </button>
            )}
        </section>
    );
}

/** The Plan as phase sections (L1); with `doingOnly`, every row that is not doing hides. */
function PlanList(props: { groups: PhaseGroup[]; rows: RowContext; doingOnly: boolean }) {
    const { groups, rows, doingOnly } = props;
    const total = groups.reduce((sum, group) => sum + group.total, 0);
    const done = groups.reduce((sum, group) => sum + group.done, 0);
    return (
        <Section
            section="plan"
            label="Plan"
            className="im-plan"
            count={total === 0 ? undefined : `${done} / ${total}`}
        >
            {total === 0 ? (
                <p className="mw-empty">
                    The Plan is seeded at approval; the lead adds items here.
                </p>
            ) : (
                groups.map((group) => (
                    <PhaseSection key={group.id} group={group} rows={rows} doingOnly={doingOnly} />
                ))
            )}
        </Section>
    );
}

/** One phase: a header button with `aria-expanded`, the counts, then its rows when open. */
function PhaseSection(props: { group: PhaseGroup; rows: RowContext; doingOnly: boolean }) {
    const { group, rows, doingOnly } = props;
    // The default follows the rule of T6 until the operator toggles the section.
    const [toggled, setToggled] = useState<boolean | null>(null);
    const open = toggled ?? group.open;
    const shown = doingOnly ? group.rows.filter((row) => row.item.state === "doing") : group.rows;
    if (doingOnly && shown.length === 0) {
        return null;
    }
    return (
        <section className="im-phase" data-phase={group.id} data-open={open}>
            <h4 className="im-phase-head">
                <button
                    type="button"
                    className="im-phase-toggle"
                    aria-expanded={open}
                    onClick={() => setToggled(!open)}
                >
                    <span className="im-phase-chevron" aria-hidden="true">
                        {open ? "\u25be" : "\u25b8"}
                    </span>
                    <span className="im-phase-label">{group.label}</span>
                    <span className="mw-count">{`${group.done} / ${group.total}`}</span>
                    {group.doing > 0 && (
                        <span className="pill pill-accent im-phase-doing">
                            {`${group.doing} doing`}
                        </span>
                    )}
                </button>
            </h4>
            {open && (
                <ul className="mw-list im-rows">
                    {shown.map((row) => <PlanRowItem key={row.item.id} row={row} rows={rows} />)}
                </ul>
            )}
        </section>
    );
}

/** One row: the state dot, the item (box, text, owner, time), the entry badges. */
function PlanRowItem({ row, rows }: { row: PlanRow; rows: RowContext }) {
    const { item } = row;
    const badges: ReactNode[] = [];
    if (row.orphan) {
        badges.push(
            <span key="orphan" className="pill pill-warn im-orphan"
                title={`entry ${item.entry ?? ""} is not in the doc`}>
                orphan
            </span>,
        );
    }
    if (row.stale) {
        badges.push(
            <span key="stale" className="pill pill-warn im-stale"
                title={`entry ${item.entry ?? ""} changed`}>
                stale
            </span>,
        );
    }
    const number = item.entry === null ? String(item.id) : `${item.id} [${item.entry}]`;
    return (
        <li className="im-row" data-state={item.state} data-entry={item.entry ?? undefined}>
            <span className={`im-dot im-dot-${item.state}`} aria-label={item.state} />
            <ul className="mw-list im-row-item">
                <Item
                    section="plan"
                    id={item.id}
                    number={number}
                    text={item.text}
                    owner={item.owner}
                    time={item.state === "done" ? item.ticked_at : null}
                    done={item.state === "done"}
                    rows={rows}
                />
            </ul>
            {badges.length > 0 && <span className="im-badges">{badges}</span>}
        </li>
    );
}

const RAIL_LABEL: Record<RailState, string> = {
    working: "working", idle: "idle", blocked: "blocked", "needs-you": "needs you", off: "off",
};

/** The roster in the rail (D14): one chip per agent with its live dot; a click opens Agents. */
function RosterRail(props: ImplementViewProps) {
    const { mission, agentSpecs, agentsRunning, needs, onOpenAgent } = props;
    return (
        <Section section="roster" label="Roster" className="im-roster">
            {mission.roster.length === 0 ? (
                <p className="mw-empty">The lead adds agents here when the work splits.</p>
            ) : (
                <ul className="mw-agents im-agents">
                    {mission.roster.map((row) => {
                        const state = railState(
                            agentSpecs[row.agent],
                            agentsRunning.includes(row.agent),
                            isBlocked(row.blocked),
                            needsAgent(needs, row.agent),
                        );
                        const dot = (
                            <span
                                className={`dot chip-dot dot-${state} im-live`}
                                data-state={state}
                                title={RAIL_LABEL[state]}
                                aria-label={RAIL_LABEL[state]}
                            />
                        );
                        return (
                            <RosterChip
                                key={row.agent}
                                row={row}
                                dot={dot}
                                onOpen={() => onOpenAgent(row.agent)}
                            />
                        );
                    })}
                </ul>
            )}
        </Section>
    );
}
