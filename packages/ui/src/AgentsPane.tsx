import { useState } from "react";

import type { FeedLine } from "./state.ts";
import { Tabs } from "./Tabs.tsx";
import type { Session } from "@spinner/protocol";

export interface AgentsPaneProps {
    session: Session | undefined;
    /** Raw pi events per agent name for the selected session. */
    transcripts: Record<string, unknown[]>;
    feed: FeedLine[];
}

function Transcript({ events }: { events: unknown[] }) {
    if (events.length === 0) {
        return <p className="muted">No messages yet.</p>;
    }
    return (
        <ol className="transcript">
            {events.map((event, index) => (
                <li key={index}>
                    <code>{JSON.stringify(event)}</code>
                </li>
            ))}
        </ol>
    );
}

function Actions() {
    const reason = "Needs daemon routes that do not exist yet.";
    return (
        <div className="actions">
            <button disabled title={reason}>create PR</button>
            <button disabled title={reason}>run local</button>
            <button disabled title={reason}>stop local</button>
        </div>
    );
}

export function AgentsPane({ session, transcripts, feed }: AgentsPaneProps) {
    const [picked, setPicked] = useState<string | undefined>(undefined);
    const names = session === undefined ? [] : Object.keys(session.agents);
    const selected = picked !== undefined && names.includes(picked) ? picked : names[0];
    const agent = selected === undefined ? undefined : session?.agents[selected];

    return (
        <section className="pane agents-pane" aria-label="Agents">
            <div className="agents-top">
                <div className="chat">
                    <Tabs labels={names} selected={selected} onSelect={setPicked} />
                    {agent === undefined ? (
                        <p className="muted">This session has no agents.</p>
                    ) : (
                        <>
                            <p className="muted">
                                {agent.harness} · {agent.model} · {agent.process}
                            </p>
                            <Transcript events={transcripts[selected ?? ""] ?? []} />
                        </>
                    )}
                    <input className="prompt" disabled placeholder="Prompt (needs the daemon)" />
                </div>
                <Actions />
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
