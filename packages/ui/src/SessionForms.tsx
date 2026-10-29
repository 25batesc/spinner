// The forms that create a session: `new` (a title and a project) and `adopt` (PR URLs and a
// project). The side panel's "new session" card opens one of them as a view of the middle
// pane; the App closes the view once the job that creates the session finishes.
import { useEffect, useState, type FormEvent } from "react";

import type { ProjectView } from "@spinner/protocol";

import { fetchProjects } from "./events-client.ts";

export type RunAction = (path: string, body?: unknown) => Promise<void>;

export type ComposeKind = "new" | "adopt";

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

export interface ComposeFormProps {
    kind: ComposeKind;
    run: RunAction;
    /** Back to the agents view without creating anything. */
    onCancel: () => void;
}

/** One form, by `kind`. The primary button posts the job; the drawer below shows it run. */
export function ComposeForm({ kind, run, onCancel }: ComposeFormProps) {
    const projects = useProjects();
    const [title, setTitle] = useState("");
    const [urls, setUrls] = useState("");
    const [project, setProject] = useState("");

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (kind === "new") {
            const name = title.trim();
            if (name === "") {
                return;
            }
            void run("/sessions", project === "" ? { title: name } : { title: name, project });
            return;
        }
        const list = urls.split(/\s+/).filter((url) => url !== "");
        if (list.length === 0) {
            return;
        }
        void run("/sessions/adopt", project === "" ? { urls: list } : { urls: list, project });
    };

    return (
        <form
            className="compose-form"
            onSubmit={submit}
            aria-label={kind === "new" ? "New session" : "Adopt PRs"}
        >
            <h3>{kind === "new" ? "New session" : "Adopt pull requests"}</h3>
            {kind === "new" ? (
                <input
                    autoFocus
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="Title"
                    aria-label="New session title"
                />
            ) : (
                <textarea
                    autoFocus
                    value={urls}
                    onChange={(event) => setUrls(event.target.value)}
                    placeholder="PR URLs, one per line"
                    aria-label="PR URLs"
                    rows={4}
                />
            )}
            <ProjectSelect projects={projects} value={project} onChange={setProject} />
            <div className="compose-actions">
                <button type="submit" className="primary">
                    {kind === "new" ? "Create session" : "Adopt"}
                </button>
                <button type="button" onClick={onCancel}>
                    cancel
                </button>
            </div>
        </form>
    );
}
