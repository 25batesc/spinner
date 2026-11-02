import { useState, type ReactNode } from "react";

import type { ContextFileView } from "@spinner/protocol";

import { fetchContext, putContext, useLoaded } from "./remote.ts";

export interface ContextTabProps {
    /** `/sessions/<dir>/agents/<name>`. */
    base: string;
    /** Moves when the agent starts or stops, so the loaded commands are read again. */
    revision: string;
}

/** The size on the header row: lines and bytes, so the list reads at a glance. */
export function sizeOf(content: string, exists: boolean): string {
    if (!exists) {
        return "no file yet";
    }
    const trailing = content.endsWith("\n") ? 1 : 0;
    const lines = content === "" ? 0 : content.split("\n").length - trailing;
    const bytes = new TextEncoder().encode(content).length;
    return `${lines} ${lines === 1 ? "line" : "lines"} · ${bytes} B`;
}

interface Section {
    open: boolean;
    onToggle: () => void;
}

/** A collapsible row: the disclosure chevron, badges, the file name and its size. */
function SectionHead(props: { section: Section; label: string; children?: ReactNode }) {
    const { section, label, children } = props;
    return (
        <div className="context-head">
            <button
                type="button"
                className="disclosure"
                aria-expanded={section.open}
                aria-label={`${section.open ? "Collapse" : "Expand"} ${label}`}
                onClick={section.onToggle}
            >
                {section.open ? "▾" : "▸"}
            </button>
            {children}
        </div>
    );
}

function FileRow({ base, file, section }: {
    base: string; file: ContextFileView; section: Section;
}) {
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
    const edit = () => {
        setDraft(file.content);
        if (!section.open) {
            section.onToggle();
        }
    };
    return (
        <li className="context-file" data-scope={file.scope} data-open={section.open}>
            <SectionHead section={section} label={file.path}>
                <span className="badge">{file.scope}</span>
                {file.tracked && <span className="badge tracked">git</span>}
                {!file.exists && <span className="badge">new</span>}
                <code className="context-name" title={file.path}>
                    {file.path.slice(file.path.lastIndexOf("/") + 1)}
                </code>
                <span className="muted context-dir" title={file.path}>
                    {file.path.slice(0, file.path.lastIndexOf("/") + 1)}
                </span>
                <span className="muted context-size">{sizeOf(file.content, file.exists)}</span>
                {draft === null && <button className="link" onClick={edit}>edit</button>}
            </SectionHead>
            {section.open && (
                <>
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
                    <span className="section-edit-actions">
                        <button className="primary" onClick={() => void save()}>save</button>
                        <button onClick={() => setDraft(null)}>cancel</button>
                    </span>
                </div>
            )}
            {note !== null && <p className="muted">{note}</p>}
                </>
            )}
        </li>
    );
}

const COMMANDS_KEY = "#commands";

/**
 * The agent's context-file chain, from user level to its directory, plus its loaded commands,
 * each a collapsible section so the list reads at a glance. The first file starts open; the
 * rest and the commands start closed. `openPaths` is null until the first click or the
 * collapse-all / expand-all buttons set it.
 */
export function ContextTab({ base, revision }: ContextTabProps) {
    const loaded = useLoaded(`${base}#${revision}`, (signal) => fetchContext(base, signal));
    const [openPaths, setOpenPaths] = useState<ReadonlySet<string> | null>(null);
    if (loaded.error !== null) {
        return <p className="needs-human">{loaded.error}</p>;
    }
    if (loaded.value === undefined) {
        return <p className="muted">Loading the context…</p>;
    }
    const { files, commands } = loaded.value;
    const keys = [...files.map((file) => file.path), COMMANDS_KEY];
    const open = openPaths ?? new Set(keys.slice(0, 1));
    const sectionFor = (key: string): Section => ({
        open: open.has(key),
        onToggle: () => {
            const next = new Set(open);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            setOpenPaths(next);
        },
    });
    const commandsSection = sectionFor(COMMANDS_KEY);
    return (
        <div className="context" aria-label="Context">
            <div className="context-toolbar">
                <button className="link" onClick={() => setOpenPaths(new Set())}>
                    collapse all
                </button>
                <button className="link" onClick={() => setOpenPaths(new Set(keys))}>
                    expand all
                </button>
            </div>
            <ul className="context-list">
                {files.map((file) => (
                    <FileRow
                        key={file.path}
                        base={base}
                        file={file}
                        section={sectionFor(file.path)}
                    />
                ))}
            </ul>
            <div className="context-file" data-open={commandsSection.open}>
            <SectionHead section={commandsSection} label="skills and commands">
                <span className="context-title">Skills and commands</span>
                <span className="muted context-size">{commands.length} loaded</span>
            </SectionHead>
            {!commandsSection.open ? null : commands.length === 0 ? (
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
        </div>
    );
}
