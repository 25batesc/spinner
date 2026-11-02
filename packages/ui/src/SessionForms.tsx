// The form that starts a session: one box for the paste, the project, the PRs the daemon
// pulled out of the paste as checkboxes, and `Start`. The side panel's "new session" card opens
// it as a view of the middle pane; the App closes the view once the job that creates the
// session finishes and selects the session, which opens on the lead's terminal.
import { useEffect, useRef, useState, type FormEvent } from "react";

import type { ProjectView } from "@spinner/protocol";

import {
    EXTRACT_PAUSE_MS, nextTicks, startBody, toggleTick, type ExtractedPr,
} from "./compose.ts";
import { fetchProjects } from "./events-client.ts";
import { extractPrs } from "./remote.ts";

export type RunAction = (path: string, body?: unknown) => Promise<void>;

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

interface Extraction {
    prs: ExtractedPr[];
    ticked: Set<string>;
    /** True between the pause and the daemon's answer. */
    pending: boolean;
    error: string | null;
}

const NO_EXTRACTION: Extraction = { prs: [], ticked: new Set(), pending: false, error: null };

/**
 * Asks the daemon for the PRs of `text` once the typing pauses for `EXTRACT_PAUSE_MS`. A new
 * keystroke cancels the timer and the request in flight. The ticks follow `nextTicks`, so an
 * untick survives a re-extraction while the PR is still in the text.
 */
function useExtraction(text: string, project: string): [Extraction, (url: string) => void] {
    const [state, setState] = useState<Extraction>(NO_EXTRACTION);
    // The PRs of the last answer, for `nextTicks`; a ref so the effect does not depend on them.
    const previous = useRef<ExtractedPr[]>([]);
    useEffect(() => {
        if (text.trim() === "") {
            previous.current = [];
            setState(NO_EXTRACTION);
            return;
        }
        const abort = new AbortController();
        const timer = setTimeout(() => {
            setState((old) => ({ ...old, pending: true }));
            const body = project === "" ? { text } : { text, project };
            extractPrs(body, abort.signal).then(
                (found) => {
                    // React runs the updater later, so the earlier list is read now.
                    const earlier = previous.current;
                    previous.current = found.prs;
                    setState((old) => ({
                        prs: found.prs,
                        ticked: nextTicks(old.ticked, earlier, found.prs),
                        pending: false,
                        error: null,
                    }));
                },
                (failure: unknown) => {
                    if (!abort.signal.aborted) {
                        setState((old) => ({ ...old, pending: false, error: String(failure) }));
                    }
                },
            );
        }, EXTRACT_PAUSE_MS);
        return () => {
            clearTimeout(timer);
            abort.abort();
        };
    }, [text, project]);
    const toggle = (url: string) =>
        setState((old) => ({ ...old, ticked: toggleTick(old.ticked, old.prs, url) }));
    return [state, toggle];
}

/** One checkbox per PR: the title, `repo#N`, the branch; unticked with the reason when refused. */
function PrChecklist(props: { extraction: Extraction; onToggle: (url: string) => void }) {
    const { extraction, onToggle } = props;
    if (extraction.prs.length === 0) {
        return null;
    }
    return (
        <ul className="compose-prs" aria-label="Pull requests found">
            {extraction.prs.map((pr) => (
                <li
                    key={pr.url}
                    className={pr.adoptable ? "compose-pr" : "compose-pr compose-pr-off"}
                >
                    <label>
                        <input
                            type="checkbox"
                            checked={extraction.ticked.has(pr.url)}
                            disabled={!pr.adoptable}
                            onChange={() => onToggle(pr.url)}
                            aria-label={`Adopt ${pr.repo}#${pr.number}`}
                        />
                        <span className="compose-pr-title">{pr.title}</span>
                        <code className="compose-pr-ref">{`${pr.repo}#${pr.number}`}</code>
                        <span className="muted compose-pr-branch">{pr.branch}</span>
                    </label>
                    {pr.reason !== undefined && (
                        <span className="compose-pr-reason">{pr.reason}</span>
                    )}
                </li>
            ))}
        </ul>
    );
}

export interface ComposeFormProps {
    run: RunAction;
    /** Back to the agents view without creating anything. */
    onCancel: () => void;
}

/** The compose box. `Start` posts the job; the drawer below shows it run. */
export function ComposeForm({ run, onCancel }: ComposeFormProps) {
    const projects = useProjects();
    const [text, setText] = useState("");
    const [project, setProject] = useState("");
    const [extraction, toggle] = useExtraction(text, project);

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (text.trim() === "") {
            return;
        }
        void run("/sessions", startBody(text, project, extraction.ticked, extraction.prs));
    };

    return (
        <form className="compose-form" onSubmit={submit} aria-label="New session">
            <h3>New session</h3>
            <label className="field">
                <span className="field-label">What this is about</span>
                <textarea
                    autoFocus
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    placeholder="Paste what this is about: a sentence, a ticket, PR links."
                    aria-label="What this is about"
                    rows={6}
                />
            </label>
            <PrChecklist extraction={extraction} onToggle={toggle} />
            {extraction.pending && <p className="muted compose-extracting">Looking for PRs…</p>}
            {extraction.error !== null && <p className="needs-human">{extraction.error}</p>}
            <label className="field">
                <span className="field-label">Project</span>
                <ProjectSelect projects={projects} value={project} onChange={setProject} />
            </label>
            <div className="compose-actions">
                <button type="submit" className="primary" disabled={text.trim() === ""}>
                    Start
                </button>
                <button type="button" onClick={onCancel}>
                    cancel
                </button>
            </div>
        </form>
    );
}
