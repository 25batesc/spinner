// The Files view (the operator's ask of 2026-11-23, after mdview): the session directory as
// a tree on the left, the picked file in the middle, and the comments on it at the right.
// He reads what the agents wrote, selects a passage and comments on it for an agent, edits a
// file, shows it in the file manager and copies it to his Downloads folder. The tree is read
// again every few seconds while the view shows, so a file an agent writes appears and an
// open document follows its file. The pure rules are in `session-files.ts`; the tree is
// `SessionFileTree.tsx` and the reading column `SessionFileDoc.tsx`.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type {
    Comment,
    SessionFileEntry,
    SessionFileResponse,
    SessionView,
} from "@spinner/protocol";

import { CommentThread } from "./CommentThreads.tsx";
import { Icon, IconButton } from "./PaneHead.tsx";
import {
    downloadSessionFile,
    fetchComments,
    fetchSessionFile,
    fetchSessionFiles,
    postComment,
    revealSessionFile,
    saveSessionFile,
    useLoaded,
} from "./remote.ts";
import {
    Composer,
    Document,
    HEADINGS,
    selectedPassage,
    type CommentFocus,
    type OutlineItem,
    type Passage,
} from "./SessionFileDoc.tsx";
import { ALL_COMMENTS, FilesNav } from "./SessionFileTree.tsx";
import {
    ageLabel,
    commentsOn,
    docStats,
    FILES_POLL_MS,
    LIVE_RELOAD_BYTES_MAX,
    openCommentCounts,
    rawUrl,
    recentFiles,
    sizeLabel,
    viewerOf,
} from "./session-files.ts";

import "./markdown.css";
import "./session-files.css";

export interface SessionFilesProps {
    view: SessionView;
    /** False while another view of the pane shows: the tree is not read then. */
    active: boolean;
    /** Moves on `comment.updated` for the session. */
    commentsRevision: number;
}

/** Room kept for the `Comment` button at the right edge of the view. */
const OFFER_WIDTH_PX = 110;
/** How long `path copied` and `saved to …` stay in the header. */
const NOTE_SHOWN_MS = 4000;

/** What the header says about the last action; `bad` stays until the next one. */
interface Note {
    text: string;
    bad: boolean;
}

/** The operator's unsaved text and the modification time of the version he started from. */
interface Edit {
    text: string;
    mtime: string;
}

function reason(failure: unknown): string {
    return failure instanceof Error ? failure.message : String(failure);
}

/** Where a comment sits inside its file: the heading above it, or its line. */
function placeInFile(comment: Comment): string {
    const anchor = comment.anchor;
    if (anchor.kind !== "doc") {
        return "";
    }
    if (anchor.heading !== null) {
        return anchor.heading;
    }
    return anchor.line === null ? "the file" : `line ${anchor.line}`;
}

/**
 * The pace of the view: a number that moves once per `FILES_POLL_MS` while the view shows
 * and the window is visible. Every read of the tree hangs on it; nothing reacts to a file
 * event. `bump` moves it at once, after a save.
 */
function useFilesTick(active: boolean, dir: string): [number, () => void] {
    const [tick, setTick] = useState(0);
    const bump = useCallback(() => setTick((old) => old + 1), []);
    useEffect(() => {
        if (!active) {
            return;
        }
        bump();
        const timer = window.setInterval(() => {
            if (document.visibilityState === "visible") {
                bump();
            }
        }, FILES_POLL_MS);
        return () => window.clearInterval(timer);
    }, [active, dir, bump]);
    return [tick, bump];
}

/**
 * The version of the file the reader holds: the modification time it is read at. It follows
 * the tree, except while `frozen` (the operator edits, writes a comment or holds a
 * selection, and the text must not shift under him) and for a large file (a render of it on
 * every change would stall the page). Then `stale` is true and `reload` takes the new one.
 */
function useFileVersion(
    shown: string | null,
    entry: SessionFileEntry | undefined,
    frozen: boolean,
) {
    const [version, setVersion] = useState({ path: "", mtime: "" });
    const onDisk = entry?.mtime ?? "";
    const large = (entry?.bytes ?? 0) > LIVE_RELOAD_BYTES_MAX;
    const held = version.path === shown && version.mtime !== "";
    const reload = useCallback(() => {
        if (shown !== null && onDisk !== "") {
            setVersion((old) =>
                old.path === shown && old.mtime === onDisk ? old : { path: shown, mtime: onDisk });
        }
    }, [shown, onDisk]);
    useEffect(() => {
        if (!held || !(frozen || large)) {
            reload();
        }
    }, [reload, held, frozen, large]);
    return {
        mtime: held ? version.mtime : "",
        stale: held && onDisk !== "" && version.mtime !== onDisk,
        reload,
    };
}

/** `/` puts the cursor in the filter and `\` hides the file list, as in mdview. */
function useFilesKeys(
    active: boolean,
    filter: RefObject<HTMLInputElement | null>,
    setTreeShown: (next: (old: boolean) => boolean) => void,
): void {
    useEffect(() => {
        if (!active) {
            return;
        }
        const keys = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            const typing = target !== null &&
                (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
            if (typing || event.metaKey || event.ctrlKey || event.altKey) {
                return;
            }
            if (event.key === "/") {
                event.preventDefault();
                setTreeShown(() => true);
                window.setTimeout(() => filter.current?.focus(), 0);
            } else if (event.key === "\\") {
                event.preventDefault();
                setTreeShown((old) => !old);
            }
        };
        window.addEventListener("keydown", keys);
        return () => window.removeEventListener("keydown", keys);
    }, [active, filter, setTreeShown]);
}

interface FileActionsProps {
    file: SessionFileResponse | undefined;
    markdown: boolean;
    raw: boolean;
    stale: boolean;
    editing: boolean;
    onRaw: () => void;
    onReload: () => void;
    onComment: () => void;
    onEdit: () => void;
    onCancel: () => void;
    onSave: () => void;
    onCopy: () => void;
    onReveal: () => void;
    onDownload: () => void;
}

/** The buttons at the right of the header: while he edits, only `cancel` and `save`. */
function FileActions(props: FileActionsProps) {
    const { file } = props;
    if (props.editing) {
        return (
            <span className="sf-actions">
                <button type="button" onClick={props.onCancel}>cancel</button>
                <button
                    type="button"
                    className="primary"
                    title="Save the file (⌘S)"
                    onClick={props.onSave}
                >
                    save
                </button>
            </span>
        );
    }
    return (
        <span className="sf-actions">
            {props.stale && (
                <button
                    type="button"
                    className="link"
                    title="The file changed on disk since this version was read"
                    onClick={props.onReload}
                >
                    changed · reload
                </button>
            )}
            {props.markdown && (
                <button
                    type="button"
                    className="link"
                    aria-pressed={props.raw}
                    onClick={props.onRaw}
                >
                    {props.raw ? "rendered" : "raw"}
                </button>
            )}
            {file !== undefined && (
                <IconButton
                    icon="comment"
                    label="Comment on the selected text, or on the file"
                    onClick={props.onComment}
                />
            )}
            {file?.editable === true && (
                <IconButton icon="edit" label="Edit the file" onClick={props.onEdit} />
            )}
            {file !== undefined && (
                <IconButton icon="copy" label="Copy the file's text" onClick={props.onCopy} />
            )}
            <IconButton
                icon="folder"
                label="Show the file in the file manager"
                onClick={props.onReveal}
            />
            <IconButton
                icon="download"
                label="Copy the file to the Downloads folder"
                onClick={props.onDownload}
            />
        </span>
    );
}

interface FileAsideProps {
    dir: string;
    comments: Comment[];
    outline: OutlineItem[];
    onShow: (comment: Comment) => void;
    onJump: (item: OutlineItem) => void;
    /** The box a comment is written in, while the operator writes one. */
    children: React.ReactNode;
}

/** The third column: the comment box, the open threads, the resolved ones, the outline. */
function FileAside({ dir, comments, outline, onShow, onJump, children }: FileAsideProps) {
    const [resolvedShown, setResolvedShown] = useState(false);
    const open = comments.filter((comment) => comment.state !== "resolved");
    const resolved = comments.filter((comment) => comment.state === "resolved");
    const thread = (comment: Comment) => (
        <CommentThread
            key={comment.id}
            dir={dir}
            comment={comment}
            place={placeInFile(comment)}
            onShow={comment.state === "resolved" ? undefined : () => onShow(comment)}
        />
    );
    return (
        <aside className="sf-aside" aria-label="Comments and outline">
            {children}
            {open.length > 0 && <ul className="thread-list sf-threads">{open.map(thread)}</ul>}
            {resolved.length > 0 && (
                <button
                    type="button"
                    className="link sf-resolved"
                    aria-expanded={resolvedShown}
                    onClick={() => setResolvedShown(!resolvedShown)}
                >
                    {resolvedShown ? "▾" : "▸"} {resolved.length} resolved
                </button>
            )}
            {resolvedShown && resolved.length > 0 && (
                <ul className="thread-list sf-threads">{resolved.map(thread)}</ul>
            )}
            {outline.length > 1 && (
                <div className="sf-outline">
                    <p className="sf-label">On this page</p>
                    {outline.map((item) => (
                        <button
                            key={item.index}
                            type="button"
                            className="sf-outline-item"
                            style={{ paddingLeft: `${4 + (item.level - 1) * 10}px` }}
                            onClick={() => onJump(item)}
                        >
                            {item.text}
                        </button>
                    ))}
                </div>
            )}
        </aside>
    );
}

interface AllCommentsProps {
    dir: string;
    comments: Comment[];
    onShow: (comment: Comment) => void;
}

/** Every comment of the session, the unresolved first: on files and on previews. */
function AllComments({ dir, comments, onShow }: AllCommentsProps) {
    const ordered = [...comments].sort((a, b) =>
        Number(a.state === "resolved") - Number(b.state === "resolved"));
    return (
        <ul className="thread-list sf-threads">
            {comments.length === 0 && (
                <li className="muted">
                    No comments. Select text in a file and comment on it, or use the comment
                    button in a preview&apos;s bar.
                </li>
            )}
            {ordered.map((comment) => (
                <CommentThread
                    key={comment.id}
                    dir={dir}
                    comment={comment}
                    onShow={comment.anchor.kind === "doc" ? () => onShow(comment) : undefined}
                />
            ))}
        </ul>
    );
}

export function SessionFiles({ view, active, commentsRevision }: SessionFilesProps) {
    const dir = view.summary.dir;
    const agents = useMemo(() => Object.keys(view.summary.session.agents ?? {}), [view]);
    const [tick, bump] = useFilesTick(active, dir);
    const [picked, setPicked] = useState<string | null>(null);
    const [toggled, setToggled] = useState<Record<string, boolean>>({});
    const [query, setQuery] = useState("");
    const [treeShown, setTreeShown] = useState(true);
    const [raw, setRaw] = useState(false);
    const [editing, setEditing] = useState<Edit | null>(null);
    const [passage, setPassage] = useState<Passage | null>(null);
    const [offer, setOffer] = useState<{ passage: Passage; x: number; y: number } | null>(null);
    const [note, setNote] = useState<Note | null>(null);
    const [outline, setOutline] = useState<OutlineItem[]>([]);
    const [focus, setFocus] = useState<CommentFocus | null>(null);
    const root = useRef<HTMLDivElement | null>(null);
    const filter = useRef<HTMLInputElement | null>(null);
    const body = useRef<HTMLDivElement | null>(null);
    const scroller = useRef<HTMLElement | null>(null);
    useFilesKeys(active, filter, setTreeShown);

    const listing = useLoaded(`${dir}#files#${tick}`, (signal) => fetchSessionFiles(dir, signal));
    const entries = listing.value?.entries;
    const threads = useLoaded(`${dir}#${commentsRevision}#comments`, (signal) =>
        fetchComments(dir, signal));
    const comments = useMemo(() => threads.value?.comments ?? [], [threads.value]);
    const counts = useMemo(() => openCommentCounts(comments), [comments]);
    const now = useMemo(() => new Date(), [tick]);

    // Nothing picked yet: the document changed last, which is what an agent just wrote.
    const shown = picked ?? recentFiles(entries ?? [], 1)[0]?.path ?? null;
    const entry = entries?.find((item) => item.path === shown && item.kind === "file");
    const isFile = shown !== null && shown !== ALL_COMMENTS;
    const viewer = isFile ? viewerOf(shown) : "text";
    // A link in a document can name a file the session does not have.
    const missing = isFile && entries !== undefined && entry === undefined;
    const frozen = editing !== null || passage !== null || offer !== null;
    const version = useFileVersion(shown, entry, frozen);
    const loaded = useLoaded(`${dir}#file#${shown ?? ""}@${version.mtime}`, (signal) =>
        version.mtime !== "" && isFile && viewer !== "image"
            ? fetchSessionFile(dir, shown, signal)
            : Promise.resolve(undefined));
    const file = loaded.value?.path === shown ? loaded.value : undefined;
    const fileComments = useMemo(
        () => (isFile ? commentsOn(comments, shown) : []),
        [comments, shown, isFile],
    );

    useEffect(() => {
        if (note === null || note.bad) {
            return;
        }
        const timer = window.setTimeout(() => setNote(null), NOTE_SHOWN_MS);
        return () => window.clearTimeout(timer);
    }, [note]);
    // A selection that ends anywhere (a click in the tree, a key) takes the offer with it.
    useEffect(() => {
        const changed = () => {
            if (window.getSelection()?.isCollapsed !== false) {
                setOffer(null);
            }
        };
        document.addEventListener("selectionchange", changed);
        return () => document.removeEventListener("selectionchange", changed);
    }, []);

    const leave = () => {
        setEditing(null);
        setPassage(null);
        setOffer(null);
    };
    const open = (path: string) => {
        leave();
        setPicked(path);
        setNote(null);
        setRaw(false);
        scroller.current?.scrollTo({ top: 0 });
        // The directories above the file open, so the tree shows where it is.
        setToggled((old) => {
            const next = { ...old };
            const parts = path.split("/");
            for (let depth = 1; depth < parts.length; depth += 1) {
                next[parts.slice(0, depth).join("/")] = true;
            }
            return next;
        });
    };
    /** Runs an action of the header and says how it ended. */
    const act = <Value,>(work: Promise<Value>, done: (value: Value) => string) => {
        work.then(
            (value) => setNote({ text: done(value), bad: false }),
            (failure: unknown) => setNote({ text: reason(failure), bad: true }),
        );
    };
    const save = () => {
        if (editing !== null && isFile) {
            const edit = { path: shown, text: editing.text, mtime: editing.mtime };
            act(saveSessionFile(dir, edit), () => {
                setEditing(null);
                bump();
                return "saved";
            });
        }
    };
    const sendComment = async (agent: string, text: string) => {
        if (passage === null || !isFile) {
            return;
        }
        const anchor = { kind: "doc" as const, path: shown, ...passage, line: null };
        const sent = await postComment(dir, { agent, text, anchor });
        setPassage(null);
        setFocus({ id: sent.comment.id, tick: Date.now() });
        window.getSelection()?.removeAllRanges();
    };
    const show = (comment: Comment) => {
        if (comment.anchor.kind === "doc") {
            if (comment.anchor.path !== shown) {
                open(comment.anchor.path);
            }
            setFocus({ id: comment.id, tick: Date.now() });
        }
    };
    const select = (next: Passage | null, at: { x: number; y: number } | null) => {
        const box = root.current?.getBoundingClientRect();
        if (next === null || at === null || box === undefined) {
            setOffer(null);
            return;
        }
        // The view is a size container, so it is the containing block of the button: the
        // place is relative to the view, and kept inside its right edge.
        const x = Math.min(at.x - box.left, box.width - OFFER_WIDTH_PX);
        setOffer({ passage: next, x: Math.max(0, x), y: at.y - box.top });
    };
    const copyPath = () => {
        const absolute = file?.absolute ?? `${listing.value?.root ?? ""}/${shown ?? ""}`;
        act(navigator.clipboard.writeText(absolute), () => "path copied");
    };

    const aside = isFile && (passage !== null || fileComments.length > 0 || outline.length > 1);
    return (
        <div className="sf" ref={root} hidden={!active} aria-label="Session files">
            {/* The view is the size container; its grid is a child, because a container
                query styles only what is inside the container. */}
            <div className="sf-grid" data-tree={treeShown} data-aside={aside}>
                {treeShown && (
                    <FilesNav
                        entries={entries}
                        truncated={listing.value?.truncated === true}
                        error={listing.error}
                        query={query}
                        onQuery={setQuery}
                        filterRef={filter}
                        shown={shown}
                        toggled={toggled}
                        counts={counts}
                        openComments={comments.filter((c) => c.state !== "resolved").length}
                        now={now}
                        onPick={open}
                        onToggle={(path, value) =>
                            setToggled((old) => ({ ...old, [path]: value }))}
                        onReveal={() => act(revealSessionFile(dir, ""), () => "shown")}
                    />
                )}
                <div className="sf-top">
                    <header className="sf-head">
                        <IconButton
                            icon="panel-left"
                            label={`${treeShown ? "Hide" : "Show"} the file list (\\)`}
                            active={treeShown}
                            onClick={() => setTreeShown(!treeShown)}
                        />
                        {isFile ? (
                            <button
                                type="button"
                                className="sf-path"
                                title="Copy the file's full path"
                                onClick={copyPath}
                            >
                                {shown}
                            </button>
                        ) : (
                            <span className="sf-path">
                                {shown === ALL_COMMENTS ? "Comments" : "Session files"}
                            </span>
                        )}
                        {note !== null && (
                            <span className={note.bad ? "needs-human sf-note" : "muted sf-note"}>
                                {note.text}
                            </span>
                        )}
                        {isFile && (
                            <FileActions
                                file={file}
                                markdown={viewer === "markdown"}
                                raw={raw}
                                stale={version.stale}
                                editing={editing !== null}
                                onRaw={() => setRaw(!raw)}
                                onReload={() => {
                                    leave();
                                    version.reload();
                                }}
                                onComment={() => {
                                    const whole = { quote: "", heading: null };
                                    setPassage(selectedPassage(body.current) ?? whole);
                                    setOffer(null);
                                }}
                                onEdit={() => {
                                    if (file !== undefined) {
                                        leave();
                                        setEditing({ text: file.text, mtime: file.mtime });
                                    }
                                }}
                                onCancel={() => setEditing(null)}
                                onSave={save}
                                onCopy={() => act(
                                    navigator.clipboard.writeText(file?.text ?? ""),
                                    () => "text copied",
                                )}
                                onReveal={() => act(revealSessionFile(dir, shown), () => "shown")}
                                onDownload={() => act(
                                    downloadSessionFile(dir, shown),
                                    (saved) => `saved to ${saved}`,
                                )}
                            />
                        )}
                    </header>
                    {isFile && entry !== undefined && (
                        <p className="muted sf-facts">
                            {file !== undefined && viewer === "markdown" &&
                                `${docStats(file.text)} · `}
                            {sizeLabel(entry.bytes)} · changed {ageLabel(entry.mtime, now)}
                            {file?.editable === false && " · Spinner writes this file"}
                        </p>
                    )}
                </div>
                <section
                    className="sf-scroll"
                    ref={scroller}
                    aria-label={isFile ? shown : "Comments"}
                >
                    {shown === null && (
                        <p className="muted sf-empty">
                            {entries === undefined ? "Loading…" : "Pick a file to read it."}
                        </p>
                    )}
                    {shown === ALL_COMMENTS && (
                        <AllComments dir={dir} comments={comments} onShow={show} />
                    )}
                    {isFile && viewer === "image" && (
                        <img className="sf-image" src={rawUrl(dir, shown)} alt={shown} />
                    )}
                    {isFile && viewer !== "image" && file === undefined && (
                        <p className={missing || loaded.error !== null
                            ? "needs-human sf-empty"
                            : "muted sf-empty"}
                        >
                            {missing
                                ? `${shown} is not a file of this session.`
                                : loaded.error ?? `Loading ${shown}…`}
                        </p>
                    )}
                    {file !== undefined && editing !== null && (
                        <textarea
                            className="sf-editor"
                            aria-label={`Edit ${file.path}`}
                            autoFocus
                            spellCheck={false}
                            value={editing.text}
                            onChange={(event) =>
                                setEditing({ ...editing, text: event.target.value })}
                            onKeyDown={(event) => {
                                if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
                                    event.preventDefault();
                                    save();
                                }
                            }}
                        />
                    )}
                    {file !== undefined && editing === null && (
                        <Document
                            dir={dir}
                            file={file}
                            raw={raw}
                            comments={fileComments}
                            focus={focus}
                            bodyRef={body}
                            onOutline={setOutline}
                            onOpen={open}
                            onSelect={select}
                        />
                    )}
                </section>
                {aside && (
                    <FileAside
                        dir={dir}
                        comments={fileComments}
                        outline={editing === null ? outline : []}
                        onShow={show}
                        onJump={(item) => body.current?.querySelectorAll(HEADINGS)[item.index]
                            ?.scrollIntoView({ block: "start" })}
                    >
                        {passage !== null && (
                            <Composer
                                passage={passage}
                                agents={agents}
                                onSend={sendComment}
                                onCancel={() => setPassage(null)}
                            />
                        )}
                    </FileAside>
                )}
            </div>
            {offer !== null && passage === null && editing === null && (
                <button
                    type="button"
                    className="primary sf-offer"
                    style={{ left: offer.x, top: offer.y }}
                    title="Comment on the selected text, for an agent"
                    // The selection must outlive the press, so the press does not take focus.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                        setPassage(offer.passage);
                        setOffer(null);
                    }}
                >
                    <Icon name="comment" /> Comment
                </button>
            )}
        </div>
    );
}
