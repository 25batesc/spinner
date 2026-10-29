import { useState, type ReactNode } from "react";

import type { FeedLine } from "./state.ts";
import { showsTerminal } from "./agent-view.ts";
import { AddAgent, AgentChat } from "./AgentChat.tsx";
import { AgentTerminal } from "./AgentTerminal.tsx";
import { ContextTab } from "./ContextTab.tsx";
import { MissionPanel } from "./MissionPanel.tsx";
import { PaneHead, type IconButtonProps } from "./PaneHead.tsx";
import { PipelineActions } from "./PipelineActions.tsx";
import type { Revisions } from "./state.ts";
import { ThreadsPanel } from "./ThreadsPanel.tsx";
import { ServiceTable } from "./ServiceTable.tsx";
import { Tabs } from "./Tabs.tsx";
import type { Transcript } from "./transcript.ts";
import { tty_path, type SessionView } from "@spinner/protocol";

import { ComposeForm, type ComposeKind, type RunAction } from "./SessionForms.tsx";

export interface AgentsPaneProps {
    view: SessionView | undefined;
    /** True while a job runs on this session; the action buttons wait. */
    busy: boolean;
    run: RunAction;
    /** Folded `agent.event` stream per agent name for the selected session. */
    transcripts: Record<string, Transcript>;
    feed: FeedLine[];
    revisions: Revisions;
    /** The job drawer, drawn above the prompt. */
    children?: ReactNode;
    /** Header icons; absent when the pane is rendered alone by the `?pane=` route. */
    controls?: IconButtonProps[] | undefined;
    /** The side-panel toggle, at the left of the title. */
    leading?: IconButtonProps | undefined;
    /** The `new` or `adopt` form as the pane's view, in place of the agents tabs. */
    compose?: { kind: ComposeKind; onCancel: () => void } | undefined;
}

function Actions(props: {
    dir: string | undefined;
    busy: boolean;
    run: RunAction;
    revision: number;
}) {
    const { dir, busy, run } = props;
    const off = dir === undefined || busy;
    const post = (action: string) => () => void run(`/sessions/${dir}/${action}`);
    return (
        <div className="actions">
            <PipelineActions dir={dir} busy={busy} run={run} revision={props.revision} />
            <button disabled={off} onClick={post("up")}>run local</button>
            <button disabled={off} onClick={post("down")}>stop local</button>
            <button disabled={off} onClick={post("close")}>close</button>
        </div>
    );
}

function agentBase(dir: string, agent: string): string {
    return `/sessions/${dir}/agents/${agent}`;
}

const VIEWS = ["agents", "mission", "threads", "services"];

export function AgentsPane(props: AgentsPaneProps) {
    const { view, busy, run, transcripts, feed, revisions, children } = props;
    const { controls, leading, compose } = props;
    const [picked, setPicked] = useState<string | undefined>(undefined);
    const [shown, setShown] = useState("agents");
    const [agentTab, setAgentTab] = useState("chat");
    // The `+` tab at the end of the agent row: the add-agent form as the pane's view.
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
                <PaneHead name="agents" controls={controls} leading={leading} />
                <div className="agents-top">
                    <div className="chat">
                        <ComposeForm kind={compose.kind} run={run} onCancel={compose.onCancel} />
                        {children}
                    </div>
                </div>
            </section>
        );
    }
    return (
        <section className="pane agents-pane" aria-label="Agents">
            <PaneHead name="agents" controls={controls} leading={leading} />
            <div className="agents-top">
                <div className="chat">
                    <Tabs labels={VIEWS} selected={shown} onSelect={setShown} />
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
                    {view !== undefined && shown === "services" && <ServiceTable view={view} />}
                    {/* Hidden, not unmounted, while another view shows: the terminals keep
                        their sockets and buffers. */}
                    <div className="agents-view" hidden={shown !== "agents"}>
                        <div className="tabs-row">
                            <Tabs
                                labels={names}
                                selected={adding ? undefined : selected}
                                onSelect={(name) => {
                                    setPicked(name);
                                    setAdding(false);
                                }}
                            />
                            {view !== undefined && (
                                <button
                                    type="button"
                                    className={adding ? "tab tab-add tab-selected" : "tab tab-add"}
                                    aria-label="Add agent"
                                    aria-pressed={adding}
                                    onClick={() => setAdding(true)}
                                >
                                    +
                                </button>
                            )}
                        </div>
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
                                    <p className="muted">
                                        {agent.harness} · {agent.model} · {agent.process}
                                    </p>
                                    <Tabs
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
                <Actions
                    dir={view?.summary.dir}
                    busy={busy}
                    run={run}
                    revision={revisions.pipeline}
                />
            </div>
            <div className="feed" aria-label="Activity">
                <h2>Activity</h2>
                <ul>
                    {[...feed].reverse().map((line, index) => (
                        <li key={index}>
                            <span className="muted">{line.session}</span> {line.text}
                        </li>
                    ))}
                </ul>
            </div>
        </section>
    );
}
