// A project's page in the middle pane: where its file is, what it sets (Overview), the file
// itself (Spec, edited as YAML and saved through the daemon's checks), the live sessions that
// use it, and `Delete` or `Unlink`. A new project is the Spec alone, prefilled with the
// example of `GET /projects/help`; `Save` makes it.
import { useEffect, useState, type ReactNode } from "react";

import type { ProjectDetailResponse, ProjectSummary } from "@spinner/protocol";

import {
    NEW_PROJECT,
    daemonReason,
    deleteBlocker,
    deleteLabel,
    sessionOffer,
    type StackRow,
} from "./projects.ts";
import {
    createProject,
    deleteProject,
    fetchProjectDetail,
    fetchProjectHelp,
    putProjectSpec,
    useLoaded,
} from "./remote.ts";
import type { RunAction } from "./SessionForms.tsx";
import "./projects.css";

export interface ProjectPageProps {
    /** The project's name, or `NEW_PROJECT`. */
    name: string;
    /** Moves when a job ends or a session comes or goes: the page reads its data again. */
    revision: string;
    /** The live stacks, for the state and the busy mark of the page's sessions. */
    stacks: readonly StackRow[];
    run: RunAction;
    onSession: (dir: string) => void;
    /** A save of a new project, or a delete: the list reads again and the page follows. */
    onChanged: (name: string | undefined) => void;
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
    return (
        <table className="project-table">
            <thead>
                <tr>{head.map((cell) => <th key={cell}>{cell}</th>)}</tr>
            </thead>
            <tbody>
                {rows.map((row, index) => (
                    <tr key={index}>{row.map((cell, at) => <td key={at}>{cell}</td>)}</tr>
                ))}
            </tbody>
        </table>
    );
}

function orNone(value: string | number | null): ReactNode {
    return value === null ? <span className="muted">-</span> : value;
}

function Overview({ summary }: { summary: ProjectSummary }) {
    const { database, pipeline } = summary;
    const list = (items: string[]) => (items.length === 0 ? orNone(null) : items.join(", "));
    return (
        <section className="project-part" aria-label="Overview">
            <h3>Overview</h3>
            <h4>Repos <span className="muted">base {summary.base}</span></h4>
            <Table
                head={["repo", "path", "base"]}
                rows={summary.repos.map((repo) => [
                    repo.key,
                    <span title={repo.absolute}>
                        <code>{repo.path}</code>
                        {!repo.git && <span className="needs-human"> not a git checkout</span>}
                    </span>,
                    repo.base,
                ])}
            />
            <h4>Services</h4>
            {summary.services.length === 0 ? (
                <p className="muted">None: `run local` has nothing to start.</p>
            ) : (
                <Table
                    head={["service", "runs", "repo", "command or image", "host", "health"]}
                    rows={summary.services.map((service) => [
                        service.name,
                        service.runtime,
                        orNone(service.repo),
                        <code>{service.command ?? service.image ?? "-"}</code>,
                        <span>
                            {orNone(service.host)}
                            {service.port !== null && `:${service.port}`}
                            {service.preview === "top-level" && " (own tab)"}
                        </span>,
                        <span>
                            {orNone(service.healthcheck)}
                            {service.depends_on.length > 0 &&
                                ` · after ${service.depends_on.join(", ")}`}
                        </span>,
                    ])}
                />
            )}
            <h4>Database</h4>
            {database === null ? (
                <p className="muted">None.</p>
            ) : (
                <Table
                    head={["mode", "server", "template"]}
                    rows={[[database.mode, database.server, database.template]]}
                />
            )}
            <h4>Pipeline</h4>
            <Table
                head={["setting", "value"]}
                rows={[
                    ["write repos", list(pipeline.write_repos)],
                    ["bot logins", list(pipeline.bot_logins)],
                    ["merge queue", pipeline.merge_queue],
                    ["approval check", orNone(pipeline.approval_check)],
                    ["Slack channel", orNone(pipeline.slack_channel)],
                    ["Slack post", pipeline.slack_post],
                    ["threads autofix", pipeline.threads_autofix],
                ]}
            />
        </section>
    );
}

function SpecEditor(props: {
    text: string;
    writable: boolean;
    save: (text: string) => Promise<void>;
}) {
    const [draft, setDraft] = useState(props.text);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    useEffect(() => setDraft(props.text), [props.text]);
    const save = () => {
        setSaving(true);
        setError(null);
        props.save(draft).then(
            () => setSaving(false),
            (failure: unknown) => {
                setSaving(false);
                setError(daemonReason(String(failure)));
            },
        );
    };
    return (
        <section className="project-part" aria-label="Spec">
            <h3>Spec</h3>
            <textarea
                className="project-spec"
                value={draft}
                readOnly={!props.writable}
                spellCheck={false}
                aria-label="spinner.yaml"
                onChange={(event) => setDraft(event.target.value)}
            />
            {props.writable && (
                <div className="project-spec-actions">
                    <button className="primary" disabled={saving} onClick={save}>
                        Save
                    </button>
                    <button
                        disabled={saving || draft === props.text}
                        onClick={() => {
                            setDraft(props.text);
                            setError(null);
                        }}
                    >
                        Revert
                    </button>
                </div>
            )}
            {error !== null && <p className="needs-human project-refusal">{error}</p>}
        </section>
    );
}

const UPDATE_TIP = "Attach the project again: the session's copy of the spec becomes this file.";

function Sessions(props: {
    detail: ProjectDetailResponse;
    stacks: readonly StackRow[];
    run: RunAction;
    onSession: (dir: string) => void;
}) {
    const { detail, run } = props;
    const name = detail.project.name;
    return (
        <section className="project-part" aria-label="Sessions">
            <h3>Sessions</h3>
            <p className="muted">
                A session keeps the copy of the spec it was attached with until you update its
                copy.
            </p>
            {detail.sessions.length === 0 && <p className="muted">No live session uses it.</p>}
            <ul className="project-sessions">
                {detail.sessions.map((session) => {
                    const live = props.stacks.find((row) => row.dir === session.dir);
                    const state = live?.state ?? session.stack;
                    const busy = live?.busy ?? false;
                    const offer = sessionOffer(state);
                    return (
                        <li key={session.dir}>
                            <span className={`dot dot-${state}`} aria-label={state} />
                            <strong>{session.title}</strong>
                            <span className="muted">{session.id} · {state}</span>
                            <span className="project-session-actions">
                                <button onClick={() => props.onSession(session.dir)}>open</button>
                                {offer.run && (
                                    <button
                                        disabled={busy}
                                        onClick={() => void run(`/sessions/${session.dir}/up`)}
                                    >
                                        run local
                                    </button>
                                )}
                                {offer.stop && (
                                    <button
                                        disabled={busy}
                                        onClick={() => void run(`/sessions/${session.dir}/down`)}
                                    >
                                        stop local
                                    </button>
                                )}
                                <button
                                    disabled={busy}
                                    title={UPDATE_TIP}
                                    onClick={() =>
                                        void run(`/sessions/${session.dir}/attach`, {
                                            project: name,
                                        })
                                    }
                                >
                                    update its copy
                                </button>
                            </span>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}

function DeleteButton(props: { detail: ProjectDetailResponse; onDeleted: () => void }) {
    const { detail } = props;
    const [asking, setAsking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const blocker = deleteBlocker(detail);
    const label = deleteLabel(detail);
    const remove = () => {
        deleteProject(detail.project.name).then(props.onDeleted, (failure: unknown) => {
            setAsking(false);
            setError(daemonReason(String(failure)));
        });
    };
    return (
        <span className="project-delete">
            {asking ? (
                <>
                    <button className="danger" onClick={remove}>{label}: sure?</button>
                    <button onClick={() => setAsking(false)}>Cancel</button>
                </>
            ) : (
                <button
                    className="danger"
                    disabled={blocker !== null}
                    title={blocker ?? undefined}
                    onClick={() => setAsking(true)}
                >
                    {label}
                </button>
            )}
            {blocker !== null && <span className="muted">{blocker}</span>}
            {error !== null && <span className="needs-human">{error}</span>}
        </span>
    );
}

function NewProjectPage({ onChanged }: Pick<ProjectPageProps, "onChanged">) {
    const help = useLoaded("help", fetchProjectHelp);
    const save = async (text: string) => {
        const made = await createProject(text);
        onChanged(made.project.name);
    };
    return (
        <section className="pane project-page" aria-label="New project">
            <header className="project-head">
                <strong>New project</strong>
                {help.value !== undefined && (
                    <span className="muted">reference: {help.value.doc}</span>
                )}
            </header>
            <div className="project-body">
                {help.error !== null && <p className="needs-human">{help.error}</p>}
                {help.value !== undefined && (
                    <SpecEditor text={help.value.example} writable save={save} />
                )}
            </div>
        </section>
    );
}

export function ProjectPage(props: ProjectPageProps) {
    if (props.name === NEW_PROJECT) {
        return <NewProjectPage onChanged={props.onChanged} />;
    }
    return <SavedProjectPage {...props} />;
}

function SavedProjectPage(props: ProjectPageProps) {
    const { name } = props;
    const [saves, setSaves] = useState(0);
    const loaded = useLoaded(`${name}#${props.revision}#${saves}`, (signal) =>
        fetchProjectDetail(name, signal),
    );
    const detail = loaded.value;
    const save = async (text: string) => {
        await putProjectSpec(name, text);
        setSaves((old) => old + 1);
    };
    return (
        <section className="pane project-page" aria-label="Project">
            <header className="project-head">
                <strong>{name}</strong>
                {detail !== undefined && (
                    <>
                        <code className="muted project-path">{detail.project.path}</code>
                        {detail.linked && <span className="badge">linked</span>}
                        {!detail.writable && <span className="badge">read-only</span>}
                        <DeleteButton
                            detail={detail}
                            onDeleted={() => props.onChanged(undefined)}
                        />
                    </>
                )}
            </header>
            <div className="project-body">
                {loaded.error !== null && <p className="needs-human">{loaded.error}</p>}
                {detail !== undefined && (
                    <>
                        <Overview summary={detail.summary} />
                        <SpecEditor text={detail.spec} writable={detail.writable} save={save} />
                        <Sessions
                            detail={detail}
                            stacks={props.stacks}
                            run={props.run}
                            onSession={props.onSession}
                        />
                    </>
                )}
            </div>
        </section>
    );
}
