import { useState, type ReactNode } from "react";

import { showsTerminal } from "./agent-view.ts";
import { AddAgent, AgentChat } from "./AgentChat.tsx";
import { AgentTerminal } from "./AgentTerminal.tsx";
import { postAgent } from "./events-client.ts";
import { ContextTab } from "./ContextTab.tsx";
import { MissionPanel } from "./MissionPanel.tsx";
import type { IconButtonProps } from "./PaneHead.tsx";
import { PipelineActions } from "./PipelineActions.tsx";
import type { Revisions } from "./state.ts";
import { ThreadsPanel } from "./ThreadsPanel.tsx";
import { ServiceTable } from "./ServiceTable.tsx";
import { Tabs } from "./Tabs.tsx";
import type { Transcript } from "./transcript.ts";
import type { UsageSample } from "./usage.ts";
import { ViewTabs } from "./ViewTabs.tsx";
import { tty_path, type AgentCost, type AgentSpec, type SessionView } from "@spinner/protocol";

import { formatUsd } from "./costs.ts";

import { ComposeForm, type ComposeKind, type RunAction } from "./SessionForms.tsx";

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
    /** The activity drawer, at the bottom of the pane. */
    children?: ReactNode;
    /** Header icons; absent when the pane is rendered alone by the `?pane=` route. */
    controls?: IconButtonProps[] | undefined;
    /** The side-panel toggle, at the left of the title. */
    leading?: IconButtonProps | undefined;
    /** The `new` or `adopt` form as the pane's view, in place of the agents tabs. */
    compose?: { kind: ComposeKind; onCancel: () => void } | undefined;
}

/** One sentence per session button, as its tooltip. */
const SESSION_TIPS = {
    up: "Start this session's stack on this machine.",
    down: "Stop the local stack; the database and the volumes stay.",
    reset: "Start the next round: a new branch from a fresh base, the facts cleared.",
    close: "Remove the containers, the database and the worktrees, and archive the session.",
} as const;

/**
 * The toolbar under the view tabs: the local stack, the pipeline, then the two that end a
 * round or the session. `land`, `reset` and `close` are the irreversible ones and look it.
 */
function Toolbar(props: {
    dir: string | undefined;
    busy: boolean;
    run: RunAction;
    revision: number;
}) {
    const { dir, busy, run } = props;
    const off = dir === undefined || busy;
    const post = (action: keyof typeof SESSION_TIPS) => () =>
        void run(`/sessions/${dir}/${action}`);
    const button = (action: keyof typeof SESSION_TIPS, label: string, danger = false) => (
        <button
            disabled={off}
            title={SESSION_TIPS[action]}
            className={danger ? "danger" : undefined}
            onClick={post(action)}
        >
            {label}
        </button>
    );
    return (
        <div className="actions toolbar" role="toolbar" aria-label="Session actions">
            <span className="toolbar-group">
                {button("up", "run local")}
                {button("down", "stop local")}
            </span>
            <span className="toolbar-sep" />
            <span className="toolbar-group">
                <PipelineActions dir={dir} busy={busy} run={run} revision={props.revision} />
            </span>
            <span className="toolbar-sep" />
            <span className="toolbar-group">
                {button("reset", "reset", true)}
                {button("close", "close", true)}
            </span>
        </div>
    );
}

/** The chip's dot: in a turn, hosted and idle, or not hosted at all. */
export function agentState(spec: AgentSpec, hosted: boolean): "working" | "idle" | "off" {
    if (!hosted) {
        return "off";
    }
    return spec.process === "running" ? "working" : "idle";
}

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

const VIEWS = ["agents", "mission", "threads", "services"];

export function AgentsPane(props: AgentsPaneProps) {
    const { view, busy, run, transcripts, usage, revisions, children } = props;
    const { controls, leading, compose } = props;
    const [picked, setPicked] = useState<string | undefined>(undefined);
    const [shown, setShown] = useState("agents");
    const [agentTab, setAgentTab] = useState("chat");
    // The `+` chip at the end of the agent row: the add-agent form as the pane's view.
    const [adding, setAdding] = useState(false);
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
                          shown === "agents" && !adding && agentTab !== "context" &&
                          name === selected
                      }
                  />
              ));
    const mainTab = selected !== undefined && terminalFor(selected) ? "terminal" : "chat";

    if (compose !== undefined) {
        return (
            <section className="pane agents-pane" aria-label="Agents">
                <div className="chat">
                    <ComposeForm kind={compose.kind} run={run} onCancel={compose.onCancel} />
                    {children}
                </div>
            </section>
        );
    }
    return (
        <section className="pane agents-pane" aria-label="Agents">
            <ViewTabs
                labels={VIEWS}
                shown={shown}
                onSelect={setShown}
                controls={controls}
                leading={leading}
            />
            <Toolbar
                dir={view?.summary.dir}
                busy={busy}
                run={run}
                revision={revisions.pipeline}
            />
            <div className="chat">
                {view !== undefined && shown === "mission" && (
                    <MissionPanel dir={view.summary.dir} revision={revisions.mission} />
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
                    {view !== undefined && (
                        <AgentChips
                            view={view}
                            selected={selected}
                            adding={adding}
                            onPick={(name) => {
                                setPicked(name);
                                setAdding(false);
                            }}
                            onAdd={() => setAdding(true)}
                            onStop={(name) =>
                                void postAgent(`${agentBase(view.summary.dir, name)}/stop`, {})
                            }
                        />
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
                    {!adding && (agent === undefined || view === undefined ||
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
