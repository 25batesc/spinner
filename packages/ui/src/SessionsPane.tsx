import { useEffect, useState, type FormEvent } from "react";

import type { ProjectView, SessionView } from "@spinner/protocol";

import { fetchProjects } from "./events-client.ts";
import { PaneHead, type PaneControls } from "./PaneHead.tsx";
import { prLine } from "./prLine.ts";
import { needsHuman, stageOf } from "./state.ts";

export type RunAction = (path: string, body?: unknown) => Promise<void>;

export interface SessionsPaneProps {
    sessions: [string, SessionView][];
    selected: string | undefined;
    onSelect: (dir: string) => void;
    run: RunAction;
    /** Hide and pop out; absent when the pane is rendered alone by the `?pane=` route. */
    controls?: PaneControls | undefined;
}

function stackDot(view: SessionView): string {
    return `dot dot-${view.stack.state}`;
}

function useProjects(): ProjectView[] {
    const [projects, setProjects] = useState<ProjectView[]>([]);
    useEffect(() => {
        const abort = new AbortController();
        fetchProjects(abort.signal).then(setProjects, () => undefined);
        return () => abort.abort();
    }, []);
    return projects;
}

function ProjectSelect(props: {
    projects: ProjectView[];
    value: string;
    onChange: (value: string) => void;
}) {
    return (
        <select
            value={props.value}
            onChange={(event) => props.onChange(event.target.value)}
            aria-label="Project"
        >
            <option value="">no stack</option>
            {props.projects.map((project) => (
                <option key={project.path} value={project.path}>
                    {project.name}
                </option>
            ))}
        </select>
    );
}

function NewSession({ projects, run }: { projects: ProjectView[]; run: RunAction }) {
    const [title, setTitle] = useState("");
    const [project, setProject] = useState("");

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (title.trim() === "") {
            return;
        }
        const body = project === "" ? { title: title.trim() } : { title: title.trim(), project };
        void run("/sessions", body).then(() => setTitle(""));
    };

    return (
        <form className="new-session" onSubmit={submit} aria-label="New session">
            <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Title"
                aria-label="New session title"
            />
            <ProjectSelect projects={projects} value={project} onChange={setProject} />
            <button type="submit">new session</button>
        </form>
    );
}

function Adopt({ projects, run }: { projects: ProjectView[]; run: RunAction }) {
    const [urls, setUrls] = useState("");
    const [project, setProject] = useState("");

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const list = urls.split(/\s+/).filter((url) => url !== "");
        if (list.length === 0) {
            return;
        }
        const body = project === "" ? { urls: list } : { urls: list, project };
        void run("/sessions/adopt", body).then(() => setUrls(""));
    };

    return (
        <form className="new-session" onSubmit={submit} aria-label="Adopt PRs">
            <textarea
                value={urls}
                onChange={(event) => setUrls(event.target.value)}
                placeholder="PR URLs, one per line"
                aria-label="PR URLs"
                rows={2}
            />
            <ProjectSelect projects={projects} value={project} onChange={setProject} />
            <button type="submit">adopt</button>
        </form>
    );
}

export function SessionsPane(props: SessionsPaneProps) {
    const { sessions, selected, onSelect, run, controls } = props;
    const projects = useProjects();
    return (
        <section className="pane sessions-pane" aria-label="Sessions">
            <PaneHead name="sessions" controls={controls} />
            <ul className="session-list">
                {sessions.map(([dir, view]) => {
                    const needs = needsHuman(view);
                    return (
                        <li key={dir}>
                            <button
                                className={
                                    dir === selected ? "session session-selected" : "session"
                                }
                                onClick={() => onSelect(dir)}
                            >
                                <strong>{view.summary.session.title}</strong>
                                <span className="muted">{dir}</span>
                                <span className="badges">
                                    <span className="badge">{stageOf(view)}</span>
                                    <span className={stackDot(view)} />
                                    <span className="muted">stack {view.stack.state}</span>
                                </span>
                                {needs !== null && <span className="needs-human">{needs}</span>}
                                {(view.board?.prs ?? []).map((pr) => (
                                    <span key={`${pr.repo}#${pr.number}`} className="pr-line">
                                        {prLine(pr)}
                                    </span>
                                ))}
                            </button>
                        </li>
                    );
                })}
                {sessions.length === 0 && <li className="muted">No sessions yet.</li>}
            </ul>
            <NewSession projects={projects} run={run} />
            <Adopt projects={projects} run={run} />
        </section>
    );
}
