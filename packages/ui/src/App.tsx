import { useEffect, useState } from "react";

import { AgentsPane } from "./AgentsPane.tsx";
import { postAction } from "./events-client.ts";
import { JobDrawer } from "./JobDrawer.tsx";
import { PreviewPane } from "./PreviewPane.tsx";
import { SessionsPane } from "./SessionsPane.tsx";
import { runningJob, sortedSessions } from "./state.ts";
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
    // View state only: the daemon never sends which session or job the operator looks at.
    const [picked, setPicked] = useState<string | undefined>(undefined);
    const [watched, setWatched] = useState<string | undefined>(undefined);
    const [actionError, setActionError] = useState<string | null>(null);
    const left = useResizable(260, 180, 480, 1);
    const right = useResizable(520, 240, 900, -1);

    const sessions = sortedSessions(state);
    const selected = picked !== undefined && picked in state.sessions ? picked : sessions[0]?.[0];
    const view = selected === undefined ? undefined : state.sessions[selected];
    const feed = selected === undefined ? [] : state.feed.filter((l) => l.session === selected);
    const busy = selected !== undefined && runningJob(state, selected) !== undefined;
    const job = watched === undefined ? undefined : state.jobs[watched];

    // A finished `new` or `adopt` names its session; show it.
    useEffect(() => {
        const created = job?.state === "ok" && (job.action === "new" || job.action === "adopt");
        if (created && job.session !== null) {
            setPicked(job.session);
        }
    }, [job?.state, job?.action, job?.session]);

    const run = (path: string, body?: unknown): Promise<void> => {
        setActionError(null);
        return postAction(path, body).then(
            (accepted) => setWatched(accepted.id),
            (failure: unknown) => setActionError(String(failure)),
        );
    };

    return (
        <div
            className="layout"
            style={{ gridTemplateColumns: `${left.width}px 6px 1fr 6px ${right.width}px` }}
        >
            <SessionsPane sessions={sessions} selected={selected} onSelect={setPicked} run={run} />
            <div className="handle" {...left.handleProps} role="separator" />
            <AgentsPane
                view={view}
                busy={busy}
                run={run}
                transcripts={transcriptsFor(selected, state.transcripts)}
                feed={feed}
            >
                <JobDrawer
                    job={job}
                    error={actionError}
                    onDismiss={() => {
                        setWatched(undefined);
                        setActionError(null);
                    }}
                />
            </AgentsPane>
            <div className="handle" {...right.handleProps} role="separator" />
            <PreviewPane view={view} busy={busy} run={run} />
            <footer className="status">daemon: {state.connection}</footer>
        </div>
    );
}
