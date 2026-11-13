// A session without a project has no worktree, no stack and no preview. The previews tab
// then offers the two ways to get one (the operator's request of 2026-11-13): ask the
// session's agent to make a project for the work it does, or attach one that exists.
import { useEffect, useState } from "react";

import { LEAD_NAME, type ProjectView, type SessionView } from "@spinner/protocol";

import { fetchProjects, postAgent } from "./events-client.ts";
import "./activity.css";
import type { RunAction } from "./SessionsPane.tsx";

/** What the agent is asked: make a project for this session's work, attach it, run it. */
export const MAKE_PROJECT_PROMPT =
    "This session has no project, so it has no worktree, no stack and no preview. Make a " +
    "Spinner project for the work of this session with the `project` tool: read `help`, " +
    "`create` the spinner.yaml (the repo you work in, and a service for each thing I " +
    "should see in the preview pane), `attach` it to this session, then `stack` `up`. " +
    "Tell me which preview shows what.";

/** True when the session has no project: its stack has no spec. */
export function lacksProject(view: SessionView): boolean {
    return view.kind !== "review" && view.stack.project === null &&
        view.summary.session.project === undefined;
}

export interface NoProjectProps {
    view: SessionView;
    busy: boolean;
    run: RunAction;
}

export function NoProject({ view, busy, run }: NoProjectProps) {
    const dir = view.summary.dir;
    const [projects, setProjects] = useState<ProjectView[]>([]);
    const [project, setProject] = useState("");
    const [asked, setAsked] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        const abort = new AbortController();
        fetchProjects(abort.signal).then(setProjects, () => undefined);
        return () => abort.abort();
    }, [dir]);
    const lead = view.summary.session.agents[LEAD_NAME] !== undefined;
    const ask = () => {
        const body = { text: MAKE_PROJECT_PROMPT, source: "operator" };
        postAgent(`/sessions/${dir}/agents/${LEAD_NAME}/prompt`, body).then(
            () => setAsked(true),
            (failure: unknown) => setError(String(failure)),
        );
    };
    return (
        <div className="no-project" aria-label="No project">
            <p>
                <strong>This session has no project.</strong> A project names the repos the
                session works in and the services the stack runs, so without one there is
                nothing to run or to preview.
            </p>
            <div className="no-project-row">
                <button
                    type="button"
                    className="primary"
                    disabled={!lead || asked}
                    title={lead
                        ? "Sends the request to the session's agent"
                        : "This session has no lead agent to ask"}
                    onClick={ask}
                >
                    {asked ? "asked the agent" : "ask the agent to make one"}
                </button>
                <span className="muted">or</span>
                <select
                    value={project}
                    onChange={(event) => setProject(event.target.value)}
                    aria-label="Project"
                >
                    <option value="">attach a project…</option>
                    {projects.map((entry) => (
                        <option key={entry.path} value={entry.path}>{entry.name}</option>
                    ))}
                </select>
                <button
                    type="button"
                    disabled={project === "" || busy}
                    onClick={() => void run(`/sessions/${dir}/attach`, { project })}
                >
                    attach
                </button>
            </div>
            {error !== null && <p className="needs-human">{error}</p>}
        </div>
    );
}
