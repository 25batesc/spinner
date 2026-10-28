import { useState } from "react";

import type { ContextFileView } from "@spinner/protocol";

import { fetchContext, putContext, useLoaded } from "./remote.ts";

export interface ContextTabProps {
    /** `/sessions/<dir>/agents/<name>`. */
    base: string;
    /** Moves when the agent starts or stops, so the loaded commands are read again. */
    revision: string;
}

function FileRow({ base, file }: { base: string; file: ContextFileView }) {
    const [draft, setDraft] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const save = () =>
        putContext(base, file.path, draft ?? "").then(
            (result) => {
                setDraft(null);
                setNote(result.reloaded ? "saved; the agent restarted" : "saved");
            },
            (failure: unknown) => setNote(String(failure)),
        );
    return (
        <li className="context-file" data-scope={file.scope}>
            <div className="context-head">
                <span className="badge">{file.scope}</span>
                {file.tracked && <span className="badge tracked">git</span>}
                {!file.exists && <span className="badge">new</span>}
                <code>{file.path}</code>
                {draft === null && (
                    <button className="link" onClick={() => setDraft(file.content)}>edit</button>
                )}
            </div>
            {file.tracked && draft !== null && (
                <p className="needs-human">
                    This file is tracked by git: the edit changes the branch.
                </p>
            )}
            {draft === null ? (
                <pre className="section-body">{file.exists ? file.content : "(no file yet)"}</pre>
            ) : (
                <div className="section-edit">
                    <textarea
                        aria-label={`Edit ${file.path}`}
                        rows={8}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                    />
                    <button onClick={() => void save()}>save</button>
                    <button onClick={() => setDraft(null)}>cancel</button>
                </div>
            )}
            {note !== null && <p className="muted">{note}</p>}
        </li>
    );
}

/** The agent's context-file chain, from user level to its directory, plus its loaded commands. */
export function ContextTab({ base, revision }: ContextTabProps) {
    const loaded = useLoaded(`${base}#${revision}`, (signal) => fetchContext(base, signal));
    if (loaded.error !== null) {
        return <p className="needs-human">{loaded.error}</p>;
    }
    if (loaded.value === undefined) {
        return <p className="muted">Loading the context…</p>;
    }
    const { files, commands } = loaded.value;
    return (
        <div className="context" aria-label="Context">
            <ul className="context-list">
                {files.map((file) => <FileRow key={file.path} base={base} file={file} />)}
            </ul>
            <h3>Skills and commands</h3>
            {commands.length === 0 ? (
                <p className="muted">None reported. pi reports them while the agent runs.</p>
            ) : (
                <ul className="commands">
                    {commands.map((command) => (
                        <li key={`${command.kind}:${command.name}`}>
                            <span className="badge">{command.kind}</span>{" "}
                            <code>{command.name}</code>{" "}
                            <span className="muted">{command.description}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
