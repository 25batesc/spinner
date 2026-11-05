// The middle pane of a session (docs/designs/session-workspace.md, T5, D15): one row of view
// tabs in EGM step order, each EGM tab marked with its step's state, and one view at a time:
// Agents (the chips, the gate card, the chat or terminal), Brainstorm, Draft, Review, Files,
// History, Implement, Threads, Services. The pane fetches the design doc once per reload key
// and hands the text to the Draft and Implement views; a `mission.changed` never refetches it.
import { useMemo, useState, type ReactNode } from "react";

import { agentState, showsTerminal } from "./agent-view.ts";
import { AddAgent, AgentChat } from "./AgentChat.tsx";
import { AgentTerminal } from "./AgentTerminal.tsx";
import { postAgent } from "./events-client.ts";
import { ContextTab } from "./ContextTab.tsx";
import { compactLabel, designSteps, gateCard, stepperText } from "./design.ts";
import { DesignBrief } from "./DesignBrief.tsx";
import { DesignDoc } from "./DesignDoc.tsx";
import { DesignFiles } from "./DesignFiles.tsx";
import { DesignGate } from "./DesignGate.tsx";
import { DesignHistory } from "./DesignHistory.tsx";
import { DesignReview } from "./DesignReview.tsx";
import {
    docSource, EGM_VIEWS, reloadKey, shownView, stepTab, TAB_LABELS, tabMarks, viewTabs,
    type ViewId,
} from "./design-workspace.ts";
import { GoldfishChips, type GoldfishPick } from "./GoldfishChips.tsx";
import { GoldfishTranscript } from "./GoldfishTranscript.tsx";
import { capLine } from "./goldfish.ts";
import { MissionWorkspace } from "./MissionWorkspace.tsx";
import type { IconButtonProps } from "./PaneHead.tsx";
import { fetchDesignDoc, fetchDesignFile, useLoaded } from "./remote.ts";
import { needsHuman, type Revisions } from "./state.ts";
import { ThreadsPanel } from "./ThreadsPanel.tsx";
import { ServiceTable } from "./ServiceTable.tsx";
import { Tabs } from "./Tabs.tsx";
import type { Transcript } from "./transcript.ts";
import type { UsageSample } from "./usage.ts";
import { ViewTabs, type ViewTabFold } from "./ViewTabs.tsx";
import {
    EGM_NOTICE, tty_path, type AgentCost, type MissionView, type SessionView,
} from "@spinner/protocol";

import { formatUsd } from "./costs.ts";

import type { RunAction } from "./SessionForms.tsx";

export interface AgentsPaneProps {
    view: SessionView | undefined;
    /** True while a job runs on this session; the action buttons wait. */
    busy: boolean;
    run: RunAction;
    /** Folded `agent.event` stream per agent name for the selected session. */
    transcripts: Record<string, Transcript>;
    /** The last usage sample, for the services view. */
    usage: UsageSample | null;
    revisions: Revisions;
    /** The structured mission from the last `mission.changed`, for the mission view. */
    mission: MissionView | undefined;
    /** The activity drawer, at the bottom of the pane. */
    children?: ReactNode;
    /** Header icons; absent when the pane is rendered alone by the `?pane=` route. */
    controls?: IconButtonProps[] | undefined;
    /** The side-panel toggle, at the left of the title. */
    leading?: IconButtonProps | undefined;
    /**
     * The shown view and the picked agent, held by the App (entry 3.22): the `needs you` pill
     * switches to the `agents` view and picks `lead` when a gate card shows.
     */
    shown: string;
    onShown: (view: string) => void;
    picked: string | undefined;
    onPicked: (name: string | undefined) => void;
    /** Opens the Agents view with `name` picked: the compact gate line, a rail chip. */
    onOpenAgent: (name: string) => void;
    /** Opens another view: `open in Draft` on Implement, the round badge. */
    onOpenView: (id: ViewId) => void;
    /** Where a refused gate answer goes: the drawer, as a failed job's error does. */
    onError: (message: string) => void;
}

/**
 * The gate card or the resolve card above the agent chips (entries 3.21, 3.22), or null when
 * the lead asks nothing.
 */
function GateCard({ view, onError }: { view: SessionView; onError: (message: string) => void }) {
    const design = view.design;
    const dir = view.summary.dir;
    const card = gateCard(design, needsHuman(view));
    if (card === "gate" && design?.gate !== null && design?.gate !== undefined) {
        const gate = design.gate;
        return <DesignGate key={gate.asked} kind="gate" dir={dir} gate={gate} onError={onError} />;
    }
    if (card === "resolve") {
        return <DesignGate key="resolve" kind="resolve" dir={dir} onError={onError} />;
    }
    return null;
}

// The chip's dot rule lives in `agent-view.ts` (pure), so the Implement rail can wrap it
// (session-workspace.md, D14) without this module's terminals.
export { agentState } from "./agent-view.ts";

/**
 * The agent row: one chip per agent (a state dot, the name; the harness, model and state as
 * the tooltip), the selected one filled with an × that stops it, and the `+` chip at the end.
 */
function AgentChips(props: {
    view: SessionView;
    selected: string | undefined;
    adding: boolean;
    onPick: (name: string) => void;
    onAdd: () => void;
    onStop: (name: string) => void;
}) {
    const { view, selected, adding, onPick, onAdd, onStop } = props;
    const agents = view.summary.session.agents;
    return (
        <div className="chips" role="tablist" aria-label="Agents">
            {Object.entries(agents).map(([name, spec]) => {
                const hosted = view.agents_running.includes(name);
                const state = agentState(spec, hosted);
                const current = !adding && name === selected;
                const classes = ["chip", `chip-${state}`, current ? "chip-selected" : ""];
                const cost = view.cost?.agents[name];
                const spent = cost === undefined ? "" : ` · ${chipCost(cost)}`;
                return (
                    <span key={name} className={classes.join(" ").trim()}>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={current}
                            className={current ? "tab chip-name tab-selected" : "tab chip-name"}
                            title={`${spec.harness} · ${spec.model} · ${state}${spent}`}
                            data-name={name}
                            onClick={() => onPick(name)}
                        >
                            <span className={`dot chip-dot dot-${state}`} />
                            {name}
                        </button>
                        {current && hosted && (
                            <button
                                type="button"
                                className="chip-stop"
                                aria-label={`Stop ${name}`}
                                title="Stop the agent's process; its transcript stays"
                                onClick={() => onStop(name)}
                            >
                                ×
                            </button>
                        )}
                    </span>
                );
            })}
            <button
                type="button"
                className={adding ? "tab tab-add tab-selected" : "tab tab-add"}
                aria-label="Add agent"
                aria-pressed={adding}
                onClick={onAdd}
            >
                +
            </button>
        </div>
    );
}

/** `$0.42 · anthropic/claude-x`: the chip tooltip's tail; the model pi last answered with. */
function chipCost(cost: AgentCost): string {
    return cost.model === null ? formatUsd(cost.usd) : `${formatUsd(cost.usd)} · ${cost.model}`;
}

function agentBase(dir: string, agent: string): string {
    return `/sessions/${dir}/agents/${agent}`;
}

/**
 * The doc the Draft and Implement views read (D15): the named doc, else the draft, fetched
 * once per reload key. The key never carries the mission revision, so a tick does not refetch.
 */
function useDesignDoc(view: SessionView | undefined) {
    const design = view?.design;
    const source = design === undefined ? null : docSource(design);
    const dir = view?.summary.dir ?? "";
    const reload = design === undefined ? dir : reloadKey(dir, design);
    return useLoaded(`${reload}#doc#${source?.kind ?? "none"}`, (signal) => {
        if (source === null) {
            return Promise.resolve("");
        }
        return source.kind === "doc"
            ? fetchDesignDoc(dir, signal)
            : fetchDesignFile(dir, source.name, signal);
    });
}

export function AgentsPane(props: AgentsPaneProps) {
    const { view, busy, run, transcripts, usage, revisions, mission, children } = props;
    const { controls, leading, picked, onOpenAgent, onOpenView } = props;
    // A session off the design track has no EGM views; its pick falls back to the default.
    const shown = shownView(view, props.shown);
    const setShown = props.onShown;
    const setPicked = props.onPicked;
    const [agentTab, setAgentTab] = useState("chat");
    // The `+` chip at the end of the agent row: the add-agent form as the pane's view.
    const [adding, setAdding] = useState(false);
    // The picked Goldfish chip (entry 4.16), per session: its transcript replaces the agent's
    // tabs until an agent chip or `+` is picked.
    const [fish, setFish] = useState<(GoldfishPick & { dir: string }) | null>(null);
    const design = view?.design;
    const fishView = fish === null || fish.dir !== view?.summary.dir
        ? undefined
        : design?.goldfish.find((item) => item.run === fish.run && item.step === fish.step);
    const showsFish = !adding && fishView !== undefined;
    const session = view?.summary.session;
    const names = session === undefined ? [] : Object.keys(session.agents);
    const selected = picked !== undefined && names.includes(picked) ? picked : names[0];
    const agent = selected === undefined ? undefined : session?.agents[selected];
    const terminalFor = (name: string) =>
        showsTerminal(session?.agents[name]?.harness ?? "rpc", window.location.search);
    // Every tty agent's terminal stays mounted; only the picked one shows. A switch to
    // another agent, to the Context tab or to another view hides it and keeps its buffer.
    const terminals =
        view === undefined
            ? []
            : names.filter(terminalFor).map((name) => (
                  <AgentTerminal
                      key={`${view.summary.dir}/${name}`}
                      path={tty_path(view.summary.dir, name)}
                      running={view.agents_running.includes(name)}
                      onResume={() => postAgent(`/sessions/${view.summary.dir}/agents`, { name })}
                      visible={
                          shown === "agents" && !adding && !showsFish &&
                          agentTab !== "context" && name === selected
                      }
                  />
              ));
    const mainTab = selected !== undefined && terminalFor(selected) ? "terminal" : "chat";
    const needs = view === undefined ? null : needsHuman(view);
    const reload = view === undefined || design === undefined
        ? ""
        : reloadKey(view.summary.dir, design);
    const doc = useDesignDoc(view);
    // The step marks and the fold of the EGM tabs (T5): only on the design track.
    const steps = useMemo(
        () => (design?.track === "design" ? designSteps(design, needs) : null),
        [design, needs],
    );
    const marks = useMemo(() => {
        if (steps === null || design === undefined) {
            return undefined;
        }
        const egm = tabMarks(steps, design);
        const brainstorm = egm.brainstorm;
        if (brainstorm !== undefined) {
            brainstorm.title = `${EGM_NOTICE}\n${brainstorm.title}`;
        }
        return egm;
    }, [steps, design]);
    let fold: ViewTabFold | undefined;
    if (steps !== null) {
        const current = steps.find((step) => step.state !== "done") ?? steps[steps.length - 1];
        fold = {
            ids: EGM_VIEWS,
            label: compactLabel(steps),
            opens: stepTab(current?.id ?? "build"),
            title: `${EGM_NOTICE}\n${stepperText(steps)}`,
        };
    }
    const tabs = viewTabs(view).map((id) => ({ id, label: TAB_LABELS[id] }));

    return (
        <section className="pane agents-pane" aria-label="Agents">
            <ViewTabs
                key={view?.summary.dir ?? ""}
                tabs={tabs}
                shown={shown}
                onSelect={setShown}
                controls={controls}
                leading={leading}
                marks={marks}
                fold={fold}
            />
            <div className="chat">
                {view !== undefined && shown === "brainstorm" && (
                    <DesignBrief view={view} reload={reload} onOpenAgent={onOpenAgent} />
                )}
                {view !== undefined && shown === "draft" && (
                    <DesignDoc view={view} doc={doc} mission={mission} onError={props.onError} />
                )}
                {view !== undefined && shown === "review" && (
                    <DesignReview
                        view={view}
                        reload={reload}
                        needs={needs}
                        onOpenAgent={onOpenAgent}
                    />
                )}
                {view !== undefined && shown === "files" && (
                    <DesignFiles view={view} reload={reload} />
                )}
                {view !== undefined && shown === "history" && <DesignHistory view={view} />}
                {view !== undefined && shown === "implement" && (
                    <MissionWorkspace
                        dir={view.summary.dir}
                        revision={revisions.mission}
                        mission={mission}
                        view={view}
                        docText={design?.doc === null || design === undefined
                            ? null
                            : doc.value ?? null}
                        running={view.agents_running}
                        onOpenAgent={onOpenAgent}
                        onOpenView={onOpenView}
                    />
                )}
                {view !== undefined && shown === "threads" && (
                    <ThreadsPanel
                        dir={view.summary.dir}
                        revision={revisions.threads}
                        busy={busy}
                        run={run}
                    />
                )}
                {view !== undefined && shown === "services" && (
                    <ServiceTable view={view} usage={usage} run={run} />
                )}
                {/* Hidden, not unmounted, while another view shows: the terminals keep
                    their sockets and buffers. */}
                <div className="agents-view" hidden={shown !== "agents"}>
                    {view !== undefined && <GateCard view={view} onError={props.onError} />}
                    {view !== undefined && (
                        <AgentChips
                            view={view}
                            selected={showsFish ? undefined : selected}
                            adding={adding}
                            onPick={(name) => {
                                setPicked(name);
                                setAdding(false);
                                setFish(null);
                            }}
                            onAdd={() => {
                                setAdding(true);
                                setFish(null);
                            }}
                            onStop={(name) =>
                                void postAgent(`${agentBase(view.summary.dir, name)}/stop`, {})
                            }
                        />
                    )}
                    {view !== undefined && design !== undefined &&
                        (design.goldfish.length > 0 || capLine(design.goldfish_live) !== null) && (
                        <GoldfishChips
                            design={design}
                            selected={showsFish ? fish : null}
                            onPick={(pick) => {
                                setFish({ ...pick, dir: view.summary.dir });
                                setAdding(false);
                            }}
                        />
                    )}
                    {view !== undefined && !adding && fishView !== undefined && (
                        <GoldfishTranscript dir={view.summary.dir} view={fishView} />
                    )}
                    {view !== undefined && adding && (
                        <AddAgent
                            view={view}
                            run={run}
                            onDone={(name) => {
                                setPicked(name);
                                setAdding(false);
                            }}
                            onCancel={() => setAdding(false)}
                        />
                    )}
                    {!adding && !showsFish && (agent === undefined || view === undefined ||
                        selected === undefined ? (
                            <p className="muted">This session has no agents.</p>
                        ) : (
                            <>
                                <Tabs
                                    variant="sub"
                                    labels={[mainTab, "context"]}
                                    selected={agentTab === "context" ? "context" : mainTab}
                                    onSelect={setAgentTab}
                                />
                                {agentTab === "context" && (
                                    <ContextTab
                                        base={agentBase(view.summary.dir, selected)}
                                        revision={agent.process}
                                    />
                                )}
                                {agentTab !== "context" && mainTab === "chat" && (
                                    <AgentChat
                                        view={view}
                                        agent={selected}
                                        transcript={transcripts[selected]}
                                    />
                                )}
                            </>
                        ))}
                    {terminals}
                </div>
                {children}
            </div>
        </section>
    );
}
