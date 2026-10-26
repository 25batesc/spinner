import { useState } from "react";

import { AgentsPane } from "./AgentsPane.tsx";
import { PreviewPane } from "./PreviewPane.tsx";
import { SessionsPane } from "./SessionsPane.tsx";
import { sortedSessions } from "./state.ts";
import { useResizable } from "./useResizable.ts";
import { useSpinner } from "./useSpinner.ts";

function transcriptsFor(dir: string | undefined, all: Record<string, unknown[]>) {
    const result: Record<string, unknown[]> = {};
    if (dir === undefined) {
        return result;
    }
    for (const [key, events] of Object.entries(all)) {
        if (key.startsWith(`${dir}/`)) {
            result[key.slice(dir.length + 1)] = events;
        }
    }
    return result;
}

export function App() {
    const state = useSpinner();
    const [picked, setPicked] = useState<string | undefined>(undefined);
    const left = useResizable(260, 180, 480, 1);
    const right = useResizable(520, 240, 900, -1);

    const sessions = sortedSessions(state);
    const selected = picked !== undefined && picked in state.sessions ? picked : sessions[0]?.[0];
    const session = selected === undefined ? undefined : state.sessions[selected];
    const feed = selected === undefined ? [] : state.feed.filter((l) => l.session === selected);

    return (
        <div
            className="layout"
            style={{ gridTemplateColumns: `${left.width}px 6px 1fr 6px ${right.width}px` }}
        >
            <SessionsPane sessions={sessions} selected={selected} onSelect={setPicked} />
            <div className="handle" {...left.handleProps} role="separator" />
            <AgentsPane
                session={session}
                transcripts={transcriptsFor(selected, state.transcripts)}
                feed={feed}
            />
            <div className="handle" {...right.handleProps} role="separator" />
            <PreviewPane session={session} />
            <footer className="status">daemon: {state.connection}</footer>
        </div>
    );
}
