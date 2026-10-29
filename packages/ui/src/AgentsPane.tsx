import { useState, type ReactNode } from "react";

import type { FeedLine } from "./state.ts";
import { AddAgent, AgentChat } from "./AgentChat.tsx";
import { ContextTab } from "./ContextTab.tsx";
import { MissionPanel } from "./MissionPanel.tsx";
import { PaneHead, type IconButtonProps } from "./PaneHead.tsx";
import { PipelineActions } from "./PipelineActions.tsx";
import type { Revisions } from "./state.ts";
import { ThreadsPanel } from "./ThreadsPanel.tsx";
import { ServiceTable } from "./ServiceTable.tsx";
import { Tabs } from "./Tabs.tsx";
import type { Transcript } from "./transcript.ts";
import type { SessionView } from "@spinner/protocol";

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

const VIEWS = ["agents", "mission", "threads"];

export function AgentsPane(props: AgentsPaneProps) {
    const { view, busy, run, transcripts, feed, revisions, children } = props;
    const { controls, leading, compose } = props;
    const [picked, setPicked] = useState<string | undefined>(undefined);
    const [shown, setShown] = useState("agents");
    const [agentTab, setAgentTab] = useState("chat");
    const session = view?.summary.session;
    const names = session === undefined ? [] : Object.keys(session.agents);
    const selected = picked !== undefined && names.includes(picked) ? picked : names[0];
    const agent = selected === undefined ? undefined : session?.agents[selected];

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
                    {shown === "agents" && (
                        <>
                            <Tabs labels={names} selected={selected} onSelect={setPicked} />
                            {agent === undefined || view === undefined || selected === undefined ? (
                                <p className="muted">This session has no agents.</p>
                            ) : (
                                <>
                                    <p className="muted">
                                        {agent.harness} · {agent.model} · {agent.process}
                                    </p>
                                    <Tabs
                                        labels={["chat", "context"]}
                                        selected={agentTab}
                                        onSelect={setAgentTab}
                                    />
                                    {agentTab === "context" ? (
                                        <ContextTab
                                            base={agentBase(view.summary.dir, selected)}
                                            revision={agent.process}
                                        />
                                    ) : (
                                        <AgentChat
                                            view={view}
                                            agent={selected}
                                            transcript={transcripts[selected]}
                                        />
                                    )}
                                </>
                            )}
                            {view !== undefined && <AddAgent view={view} run={run} />}
                            {view !== undefined && <ServiceTable view={view} />}
                        </>
                    )}
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
