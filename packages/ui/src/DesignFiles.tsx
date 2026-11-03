// The Files tab of the design workspace (docs/designs/egm-adoption.md, entry 5.10): every file
// of `<session>/design/` with its size and time; a click renders the file. A drift report
// (`*_DRIFT_REPORT.md`) is one of these files. `MarkdownFile` is the loaded-file renderer the
// other tabs share.
import { useState } from "react";

import type { SessionView } from "@spinner/protocol";

import { sizeLabel, timeLabel } from "./design-workspace.ts";
import { Markdown } from "./Markdown.tsx";
import { fetchDesignFile, useLoaded } from "./remote.ts";

export interface MarkdownFileProps {
    /** The reload key; it starts with the session dir, as `useLoaded` needs. */
    loadKey: string;
    read: (signal: AbortSignal) => Promise<string>;
    /** The file name, the accessible name of the raw toggle. */
    label: string;
}

/** A file read from the daemon and rendered with the mission's markdown renderer. */
export function MarkdownFile({ loadKey, read, label }: MarkdownFileProps) {
    const loaded = useLoaded(loadKey, read);
    if (loaded.error !== null) {
        return <p className="needs-human dw-error">{loaded.error}</p>;
    }
    if (loaded.value === undefined) {
        return <p className="muted">Loading {label}…</p>;
    }
    return <Markdown text={loaded.value} label={label} />;
}

/** EGM's drift report name, `<FEATURE>_DRIFT_REPORT.md`. */
const DRIFT_REPORT = /_DRIFT_REPORT\.md$/;

export interface DesignFilesProps {
    view: SessionView;
    /** The workspace's reload key (entry 5.6). */
    reload: string;
}

export function DesignFiles({ view, reload }: DesignFilesProps) {
    const dir = view.summary.dir;
    const files = [...(view.design?.files ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    const [picked, setPicked] = useState<string | null>(null);
    const shown = files.some((file) => file.name === picked) ? picked : null;
    if (files.length === 0) {
        return <p className="muted dw-empty">No design files yet.</p>;
    }
    return (
        <div className="dw-split">
            <ul className="dw-list" aria-label="Design files">
                {files.map((file) => (
                    <li key={file.name}>
                        <button
                            type="button"
                            className="dw-row"
                            aria-pressed={file.name === shown}
                            data-file={file.name}
                            onClick={() => setPicked(file.name)}
                        >
                            <span className="dw-row-name">{file.name}</span>
                            {DRIFT_REPORT.test(file.name) && (
                                <span className="pill pill-accent">drift report</span>
                            )}
                            <span className="dw-row-meta">
                                {sizeLabel(file.bytes)} · {timeLabel(file.mtime)}
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
            <div className="dw-body">
                {shown === null ? (
                    <p className="muted dw-empty">Pick a file to read it.</p>
                ) : (
                    <MarkdownFile
                        loadKey={`${reload}#file#${shown}`}
                        read={(signal) => fetchDesignFile(dir, shown, signal)}
                        label={shown}
                    />
                )}
            </div>
        </div>
    );
}
