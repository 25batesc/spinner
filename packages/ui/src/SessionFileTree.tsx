// The left column of the Files view (`SessionFiles.tsx`): the filter, the rows that are
// always there (every comment, the mission), the documents changed last, and the tree of
// the session directory. The parent holds the listing and what is picked.
import type { RefObject } from "react";

import type { SessionFileEntry } from "@spinner/protocol";

import { Icon, IconButton } from "./PaneHead.tsx";
import {
    ageLabel,
    dirOpen,
    fileTree,
    filterEntries,
    recentFiles,
    sizeLabel,
    type FileNode,
} from "./session-files.ts";

/** The mission has a row of its own above the tree: it is the file read most. */
export const MISSION_FILE = "MISSION.md";
/** What `shown` is while the body lists every comment of the session instead of a file. */
export const ALL_COMMENTS = "#comments";

interface TreeProps {
    nodes: FileNode[];
    depth: number;
    shown: string | null;
    /** Every directory shows open: a filter is on. */
    allOpen: boolean;
    toggled: Record<string, boolean>;
    /** The open comments on each file, by path. */
    counts: Record<string, number>;
    now: Date;
    onPick: (path: string) => void;
    onToggle: (path: string, open: boolean) => void;
}

/** One level of the tree. A closed directory renders none of its entries. */
function Tree(props: TreeProps) {
    const { nodes, depth, shown, allOpen, toggled, counts, now, onPick, onToggle } = props;
    return (
        <ul className="sf-tree" role={depth === 0 ? "tree" : "group"}>
            {nodes.map((node) => {
                const dir = node.kind === "dir";
                const open = dir && (allOpen || dirOpen(node.path, toggled));
                const count = counts[node.path] ?? 0;
                return (
                    <li key={node.path} role="treeitem" aria-expanded={dir ? open : undefined}>
                        <button
                            type="button"
                            className="sf-row"
                            style={{ paddingLeft: `${4 + depth * 14}px` }}
                            data-path={node.path}
                            data-kind={node.kind}
                            aria-pressed={dir ? undefined : node.path === shown}
                            title={dir
                                ? `${node.path}/ · ${node.files} files`
                                : `${node.path} · ${sizeLabel(node.bytes)}`}
                            onClick={() => (dir ? onToggle(node.path, !open) : onPick(node.path))}
                        >
                            <span className="sf-twist" aria-hidden="true">
                                {dir ? (open ? "▾" : "▸") : ""}
                            </span>
                            <span className="sf-name">{node.name}</span>
                            {count > 0 && <span className="pill pill-accent">{count}</span>}
                            <span className="sf-meta">
                                {dir ? node.files : ageLabel(node.mtime, now)}
                            </span>
                        </button>
                        {open && node.children.length > 0 && (
                            <Tree {...props} nodes={node.children} depth={depth + 1} />
                        )}
                    </li>
                );
            })}
        </ul>
    );
}

export interface FilesNavProps {
    /** The daemon's listing; undefined until the first read answers. */
    entries: SessionFileEntry[] | undefined;
    truncated: boolean;
    error: string | null;
    query: string;
    onQuery: (query: string) => void;
    filterRef: RefObject<HTMLInputElement | null>;
    shown: string | null;
    toggled: Record<string, boolean>;
    counts: Record<string, number>;
    /** The unresolved comments of the session, on files and on previews. */
    openComments: number;
    now: Date;
    onPick: (path: string) => void;
    onToggle: (path: string, open: boolean) => void;
    /** Shows the session directory in the file manager. */
    onReveal: () => void;
}

export function FilesNav(props: FilesNavProps) {
    const { entries, query, shown, now, onPick } = props;
    const all = entries ?? [];
    const filtering = query.trim() !== "";
    const tree = fileTree(filterEntries(all, query));
    const recent = filtering ? [] : recentFiles(all);
    const mission = all.find((item) => item.path === MISSION_FILE);
    return (
        <nav className="sf-side" aria-label="Files">
            <div className="sf-filter">
                <input
                    ref={props.filterRef}
                    type="search"
                    aria-label="Filter the files"
                    placeholder="Filter files  /"
                    value={query}
                    onChange={(event) => props.onQuery(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") {
                            props.onQuery("");
                            event.currentTarget.blur();
                        }
                    }}
                />
                <IconButton
                    icon="folder"
                    label="Show the session folder in the file manager"
                    onClick={props.onReveal}
                />
            </div>
            <button
                type="button"
                className="sf-row"
                aria-pressed={shown === ALL_COMMENTS}
                onClick={() => onPick(ALL_COMMENTS)}
            >
                <Icon name="comment" />
                <span className="sf-name">Comments</span>
                {props.openComments > 0 && (
                    <span className="pill pill-accent">{props.openComments}</span>
                )}
            </button>
            {mission !== undefined && !filtering && (
                <button
                    type="button"
                    className="sf-row"
                    data-pinned={MISSION_FILE}
                    aria-pressed={shown === MISSION_FILE}
                    title="MISSION.md: the goal, the plan, the roster and the log"
                    onClick={() => onPick(MISSION_FILE)}
                >
                    <Icon name="file" />
                    <span className="sf-name">Mission</span>
                    <span className="sf-meta">{ageLabel(mission.mtime, now)}</span>
                </button>
            )}
            {recent.length > 0 && <p className="sf-label">Recent</p>}
            <ul className="sf-tree">
                {recent.map((item) => (
                    <li key={item.path}>
                        <button
                            type="button"
                            className="sf-row"
                            data-recent={item.path}
                            aria-pressed={item.path === shown}
                            title={item.path}
                            onClick={() => onPick(item.path)}
                        >
                            <span className="sf-name">{item.path.split("/").pop()}</span>
                            <span className="sf-meta">{ageLabel(item.mtime, now)}</span>
                        </button>
                    </li>
                ))}
            </ul>
            {recent.length > 0 && <p className="sf-label">Session</p>}
            <Tree
                nodes={tree}
                depth={0}
                shown={shown}
                allOpen={filtering}
                toggled={props.toggled}
                counts={props.counts}
                now={now}
                onPick={onPick}
                onToggle={props.onToggle}
            />
            {props.error !== null && <p className="needs-human">{props.error}</p>}
            {entries !== undefined && tree.length === 0 && (
                <p className="muted sf-empty">
                    {filtering ? "No file matches." : "No files yet."}
                </p>
            )}
            {props.truncated && (
                <p className="muted sf-empty">The folder has more files than the tree shows.</p>
            )}
        </nav>
    );
}
