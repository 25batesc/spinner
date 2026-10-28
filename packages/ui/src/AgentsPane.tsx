import { useState, type ReactNode } from "react";

import type { FeedLine } from "./state.ts";
import { AddAgent, AgentChat } from "./AgentChat.tsx";
import { ServiceTable } from "./ServiceTable.tsx";
import { Tabs } from "./Tabs.tsx";
import type { Transcript } from "./transcript.ts";
import type { SessionView } from "@spinner/protocol";

import type { RunAction } from "./SessionsPane.tsx";

export interface AgentsPaneProps {
    view: SessionView | undefined;
    /** True while a job runs on this session; the action buttons wait. */
    busy: boolean;
    run: RunAction;
    /** Folded `agent.event` stream per agent name for the selected session. */
    transcripts: Record<string, Transcript>;
    feed: FeedLine[];
    /** The job drawer, drawn above the prompt. */
    children?: ReactNode;
}

function Actions({ dir, busy, run }: { dir: string | undefined; busy: boolean; run: RunAction }) {
    const off = dir === undefined || busy;
    const post = (action: string) => () => void run(`/sessions/${dir}/${action}`);
    return (
        <div className="actions">
            <button disabled title="Needs the PR flow (M2).">create PR</button>
            <button disabled={off} onClick={post("up")}>run local</button>
            <button disabled={off} onClick={post("down")}>stop local</button>
            <button disabled={off} onClick={post("close")}>close</button>
        </div>
    );
}

export function AgentsPane({ view, busy, run, transcripts, feed, children }: AgentsPaneProps) {
    const [picked, setPicked] = useState<string | undefined>(undefined);
    const session = view?.summary.session;
    const names = session === undefined ? [] : Object.keys(session.agents);
    const selected = picked !== undefined && names.includes(picked) ? picked : names[0];
    const agent = selected === undefined ? undefined : session?.agents[selected];

    return (
        <section className="pane agents-pane" aria-label="Agents">
            <div className="agents-top">
                <div className="chat">
                    <Tabs labels={names} selected={selected} onSelect={setPicked} />
                    {agent === undefined || view === undefined || selected === undefined ? (
                        <p className="muted">This session has no agents.</p>
                    ) : (
                        <>
                            <p className="muted">
                                {agent.harness} · {agent.model} · {agent.process}
                            </p>
                            <AgentChat
                                view={view}
                                agent={selected}
                                transcript={transcripts[selected]}
                            />
                        </>
                    )}
                    {view !== undefined && <AddAgent view={view} />}
                    {view !== undefined && <ServiceTable view={view} />}
                    {children}
                </div>
                <Actions dir={view?.summary.dir} busy={busy} run={run} />
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
