// The form that starts a session: one large box for the paste, the PRs the daemon pulled out
// of the paste as checkboxes, the project, and `Start`. It fills the working area (s038) as
// the composer: `+ New session` opens it, and the middle pane shows it while no session is
// selected. The App clears the draft once the job that creates the session finishes and
// selects the session.
import { useEffect, useRef, useState, type FormEvent } from "react";

import type { ProjectView } from "@spinner/protocol";

import {
    EXTRACT_PAUSE_MS, nextTicks, prKey, startBody, toggleTick, type ExtractedPr,
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

export interface Extraction {
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
export function useExtraction(
    text: string, project: string,
): [Extraction, (url: string) => void] {
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

/** `repo#N` as the row names it: the project's key, else the GitHub repo, else the reference. */
function prLabel(pr: ExtractedPr): string {
    const repo = pr.key ?? pr.repo;
    return repo === null ? pr.ref : `${repo}#${pr.number}`;
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
                    key={prKey(pr)}
                    className={pr.adoptable ? "compose-pr" : "compose-pr compose-pr-off"}
                >
                    <label>
                        <input
                            type="checkbox"
                            checked={extraction.ticked.has(prKey(pr))}
                            disabled={!pr.adoptable}
                            onChange={() => onToggle(prKey(pr))}
                            aria-label={`Adopt ${prLabel(pr)}`}
                        />
                        <span className="compose-pr-title">{pr.title ?? pr.ref}</span>
                        <code className="compose-pr-ref">{prLabel(pr)}</code>
                        {pr.branch !== null && (
                            <span className="muted compose-pr-branch">{pr.branch}</span>
                        )}
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
    /** The draft lives with the caller, so a switch to a session and back keeps the text. */
    draft: ComposeDraft;
    onDraft: (draft: ComposeDraft) => void;
    /** True while the job that `Start` posted runs; the button waits for the session. */
    starting: boolean;
}

export interface ComposeDraft {
    text: string;
    project: string;
    /** Plan first with EGM (the design track); off means the fast path. */
    planFirst?: boolean;
}

export const EMPTY_DRAFT: ComposeDraft = { text: "", project: "" };

/** The compose box. `Start` posts the job; the drawer below shows it run. */
export function ComposeForm({ run, draft, onDraft, starting }: ComposeFormProps) {
    const projects = useProjects();
    const { text, project } = draft;
    const setText = (next: string) => onDraft({ ...draft, text: next });
    const setProject = (next: string) => onDraft({ ...draft, project: next });
    const [extraction, toggle] = useExtraction(text, project);

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (text.trim() === "" || starting) {
            return;
        }
        const planFirst = draft.planFirst === true;
        // `Make a plan` starts a planning session (talk-change-ship.md, 4.2): no code.
        void run(
            planFirst ? "/plans" : "/sessions",
            startBody(text, project, extraction.ticked, extraction.prs, planFirst),
        );
    };

    return (
        <form className="compose-form" onSubmit={submit} aria-label="New session">
            <h3>New session</h3>
            <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={SESSION_PLACEHOLDER}
                aria-label="What this is about"
                rows={8}
                autoFocus
            />
            <PrChecklist extraction={extraction} onToggle={toggle} />
            {extraction.pending && <p className="muted compose-extracting">Looking for PRs…</p>}
            {extraction.error !== null && <p className="needs-human">{extraction.error}</p>}
            <div className="compose-actions">
                <label className="compose-project">
                    <span className="field-label">Project</span>
                    <ProjectSelect projects={projects} value={project} onChange={setProject} />
                </label>
                <label
                    className="compose-plan"
                    title={PLAN_FIRST_TIP}
                >
                    <input
                        type="checkbox"
                        checked={draft.planFirst === true}
                        onChange={(event) => onDraft({ ...draft, planFirst: event.target.checked })}
                    />
                    <span>Make a plan (no code)</span>
                </label>
                <button
                    type="submit"
                    className="primary"
                    disabled={text.trim() === "" || starting}
                >
                    {starting ? "Starting…" : "Start"}
                </button>
            </div>
        </form>
    );
}

const PLAN_FIRST_TIP =
    "Off: the agent builds, tests, opens the pull request and keeps it ready. " +
    "On: the agent writes a plan document with you, in the Plans library; no code " +
    "changes. Press Implement on the plan when it is ready.";

const SESSION_PLACEHOLDER =
    "What should this session be about? Paste a ticket, a PR link, or a sentence.";

export interface ReviewComposeFormProps {
    run: RunAction;
    /** The text lives with the caller, so a switch to a review and back keeps it. */
    text: string;
    onText: (text: string) => void;
    /** True while the `reviews` job runs; the button waits for the review. */
    starting: boolean;
}

/**
 * The review composer: PR references in any form, no project. The PRs the daemon finds show
 * under the box while the operator types; the daemon reads the text again when `Start review`
 * posts it, so the list is a preview, not the request.
 */
export function ReviewComposeForm({ run, text, onText, starting }: ReviewComposeFormProps) {
    const [extraction] = useExtraction(text, "");
    const found = extraction.prs.filter((pr) => pr.url !== null);
    const refused = extraction.prs.filter((pr) => pr.url === null);
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (text.trim() === "" || starting) {
            return;
        }
        void run("/reviews", { text });
    };
    return (
        <form className="compose-form" onSubmit={submit} aria-label="New review">
            <h3>New review</h3>
            <textarea
                value={text}
                onChange={(event) => onText(event.target.value)}
                placeholder="Paste the links of the PRs to review."
                aria-label="Pull requests to review"
                rows={8}
                autoFocus
            />
            {found.length > 0 && (
                <ul className="rv-found" aria-label="Pull requests found">
                    {found.map((pr) => (
                        <li key={pr.url} className="rv-found-pr">
                            <code>{pr.repo}#{pr.number}</code>
                            {pr.title !== null && <span className="muted">{pr.title}</span>}
                        </li>
                    ))}
                </ul>
            )}
            {refused.map((pr) => (
                <p key={pr.ref} className="needs-human rv-found-reason">
                    {pr.ref}: {pr.reason ?? "not a PR"}
                </p>
            ))}
            {extraction.pending && <p className="muted rv-extracting">Looking for PRs…</p>}
            {extraction.error !== null && <p className="needs-human">{extraction.error}</p>}
            <div className="compose-actions rv-compose-actions">
                <button
                    type="submit"
                    className="primary"
                    disabled={text.trim() === "" || starting}
                >
                    {starting ? "Starting…" : "Start review"}
                </button>
            </div>
        </form>
    );
}
