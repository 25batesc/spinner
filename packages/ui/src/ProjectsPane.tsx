// The Projects view of the sidebar: one row per project the daemon finds, `+ New project`,
// and under the list the Stacks section: every live session with a project, newest first,
// with `run local` and `stop local`. A row opens the project's page; a stack opens its
// session.
import type { ProjectRow, StackRow } from "./projects.ts";
import { projectRowMeta, sessionOffer } from "./projects.ts";
import { NewButton } from "./Sidebar.tsx";
import type { RunAction } from "./SessionsPane.tsx";
import "./projects.css";

export interface ProjectsPaneProps {
    rows: readonly ProjectRow[];
    stacks: readonly StackRow[];
    error: string | null;
    /** The project whose page shows; `NEW_PROJECT` for a new one. */
    selected: string | undefined;
    onSelect: (name: string) => void;
    onSession: (dir: string) => void;
    onNew: () => void;
    composing: boolean;
    run: RunAction;
}

function StackLine({ row, onSession, run }: {
    row: StackRow;
    onSession: (dir: string) => void;
    run: RunAction;
}) {
    const offer = sessionOffer(row.state);
    return (
        <li className="project-stack">
            <button className="pr-row" onClick={() => onSession(row.dir)} title={row.dir}>
                <span className="pr-row-head">
                    <span className={`dot dot-${row.state}`} aria-label={row.state} />
                    <strong className="pr-row-title">{row.title}</strong>
                </span>
                <span className="muted pr-row-meta">
                    {row.project} · {row.state}
                    {row.memory !== null && ` · ${row.memory}`}
                </span>
            </button>
            <span className="project-stack-actions">
                {offer.run && (
                    <button disabled={row.busy} onClick={() => void run(`/sessions/${row.dir}/up`)}>
                        run local
                    </button>
                )}
                {offer.stop && (
                    <button
                        disabled={row.busy}
                        onClick={() => void run(`/sessions/${row.dir}/down`)}
                    >
                        stop local
                    </button>
                )}
            </span>
        </li>
    );
}

export function ProjectsPane(props: ProjectsPaneProps) {
    const { rows, stacks, error, selected } = props;
    return (
        <section className="pane projects-pane" aria-label="Projects">
            <div className="side-compose">
                <NewButton label="New project" active={props.composing} onClick={props.onNew} />
            </div>
            <div className="projects-list">
                {error !== null && <p className="needs-human">{error}</p>}
                {rows.length === 0 && error === null && (
                    <p className="muted">
                        No project yet. A project is a spinner.yaml: the repos a session works
                        in and the services `run local` starts.
                    </p>
                )}
                <ul className="pr-rows">
                    {rows.map((row) => (
                        <li key={`${row.source}/${row.name}`}>
                            <button
                                className={
                                    row.name === selected ? "pr-row pr-row-selected" : "pr-row"
                                }
                                data-project={row.name}
                                onClick={() => props.onSelect(row.name)}
                            >
                                <span className="pr-row-head">
                                    <strong className="pr-row-title">{row.name}</strong>
                                    <span className="badge project-source">{row.source}</span>
                                </span>
                                <span className="muted pr-row-meta">{projectRowMeta(row)}</span>
                            </button>
                        </li>
                    ))}
                </ul>
                <h3 className="pr-rows-heading">Stacks</h3>
                {stacks.length === 0 && (
                    <p className="muted">No session has a project attached.</p>
                )}
                <ul className="pr-rows" aria-label="Stacks">
                    {stacks.map((row) => (
                        <StackLine
                            key={row.dir}
                            row={row}
                            onSession={props.onSession}
                            run={props.run}
                        />
                    ))}
                </ul>
            </div>
        </section>
    );
}
