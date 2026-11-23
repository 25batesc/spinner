// The pure half of the Files view (`SessionFiles.tsx`): the tree of the session directory
// from the daemon's flat listing, the filter, the recent documents, how a file is shown, the
// links and images of a document, and where a comment's quoted text sits among the blocks of
// the page. Nothing here touches the DOM or the network.
import type { Comment, SessionFileEntry } from "@spinner/protocol";

/** One row of the tree. A directory carries its entries, directories first. */
export interface FileNode {
    name: string;
    /** Relative to the session directory. */
    path: string;
    kind: "file" | "dir";
    bytes: number;
    mtime: string;
    children: FileNode[];
    /** The files under a directory, at any depth; 1 for a file. */
    files: number;
}

/** How the reader shows a file. */
export type FileViewer = "markdown" | "image" | "text";

/** The documents the `Recent` list offers. */
export const RECENT_FILES_MAX = 6;
/** A file past this size is not reloaded by itself when it changes; a chip offers it. */
export const LIVE_RELOAD_BYTES_MAX = 200 * 1024;
/** The tree is read again this often while the Files view shows. */
export const FILES_POLL_MS = 3000;
/** An adult reads about this many words of prose a minute. */
const WORDS_PER_MINUTE = 230;

/**
 * Directories whose files are the agents' own traffic (messages, review threads, briefs,
 * screenshots), not documents for the operator. `Recent` leaves them out.
 */
const RECENT_HIDDEN = ["inbox/", "threads/", "agents/", "skills/", "stack/", "artifacts/comments/"];

/** `a2.md` before `a10.md`, and case does not matter. */
const NAMES = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function parentOf(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash < 0 ? "" : path.slice(0, slash);
}

function nameOf(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * The entries as a tree: the session directory's own entries, each directory with its
 * entries, directories first, then by name. An entry whose directory is not in the list (a
 * truncated walk) is dropped.
 */
export function fileTree(entries: readonly SessionFileEntry[]): FileNode[] {
    const root: FileNode[] = [];
    const nodes = new Map<string, FileNode>();
    // A directory sorts before its entries, so the parent is always there first.
    const ordered = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const entry of ordered) {
        const node: FileNode = {
            name: nameOf(entry.path), path: entry.path, kind: entry.kind, bytes: entry.bytes,
            mtime: entry.mtime, children: [], files: entry.kind === "file" ? 1 : 0,
        };
        const parent = parentOf(entry.path);
        const siblings = parent === "" ? root : nodes.get(parent)?.children;
        if (siblings === undefined) {
            continue;
        }
        siblings.push(node);
        nodes.set(entry.path, node);
        if (entry.kind === "file") {
            for (let up = parent; up !== ""; up = parentOf(up)) {
                const above = nodes.get(up);
                if (above !== undefined) {
                    above.files += 1;
                }
            }
        }
    }
    const sort = (list: FileNode[]): void => {
        list.sort((a, b) =>
            a.kind === b.kind ? NAMES.compare(a.name, b.name) : a.kind === "dir" ? -1 : 1);
        for (const node of list) {
            sort(node.children);
        }
    };
    sort(root);
    return root;
}

/**
 * The entries a filter keeps: the files whose path has `query` in it, case ignored, and the
 * directories above them. An empty query keeps everything.
 */
export function filterEntries(
    entries: readonly SessionFileEntry[],
    query: string,
): SessionFileEntry[] {
    const needle = query.trim().toLowerCase();
    if (needle === "") {
        return [...entries];
    }
    const kept = new Set<string>();
    for (const entry of entries) {
        if (entry.kind === "file" && entry.path.toLowerCase().includes(needle)) {
            kept.add(entry.path);
            for (let up = parentOf(entry.path); up !== ""; up = parentOf(up)) {
                kept.add(up);
            }
        }
    }
    return entries.filter((entry) => kept.has(entry.path));
}

/** True for a Markdown file. */
function isDocument(path: string): boolean {
    return /\.(md|markdown)$/i.test(path);
}

/**
 * The documents changed last, newest first: Markdown files outside the agents' own traffic.
 * The files of the session directory itself are left out: Spinner writes `MISSION.md` and
 * `AGENTS.md`, and the mission changes with every log line, so it would always be first.
 */
export function recentFiles(
    entries: readonly SessionFileEntry[],
    max: number = RECENT_FILES_MAX,
): SessionFileEntry[] {
    return entries
        .filter((entry) => entry.kind === "file" && isDocument(entry.path))
        .filter((entry) => entry.path.includes("/"))
        .filter((entry) => !RECENT_HIDDEN.some((prefix) => entry.path.startsWith(prefix)))
        .sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0))
        .slice(0, max);
}

/** The directories that start open: where the documents are. The rest start closed. */
export function opensByDefault(path: string): boolean {
    return path === "egm" || path === "design";
}

/** True when `path` shows: every directory above it is open. */
export function dirOpen(path: string, toggled: Readonly<Record<string, boolean>>): boolean {
    return toggled[path] ?? opensByDefault(path);
}

export function viewerOf(path: string): FileViewer {
    if (isDocument(path)) {
        return "markdown";
    }
    return /\.(png|jpe?g|gif|webp)$/i.test(path) ? "image" : "text";
}

/** The daemon's URL of a file's bytes: an image shows inline, anything else downloads. */
export function rawUrl(dir: string, path: string): string {
    return `/sessions/${dir}/files/raw?path=${encodeURIComponent(path)}`;
}

/**
 * Where a relative link or image of the document `from` points, as a path relative to the
 * session directory. Null for a link with a scheme, one that starts with `/` or `#`, and one
 * that climbs above the session directory.
 */
export function resolveLink(from: string, href: string): string | null {
    if (href === "" || /^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) {
        return null;
    }
    let target = href.split("#")[0]?.split("?")[0] ?? "";
    try {
        target = decodeURIComponent(target);
    } catch {
        return null;
    }
    const parts = parentOf(from) === "" ? [] : parentOf(from).split("/");
    for (const part of target.split("/")) {
        if (part === "" || part === ".") {
            continue;
        }
        if (part === "..") {
            if (parts.length === 0) {
                return null;
            }
            parts.pop();
        } else {
            parts.push(part);
        }
    }
    return parts.length === 0 ? null : parts.join("/");
}

/** `1,204 words · 6 min read`. */
export function docStats(text: string): string {
    const words = text.split(/\s+/).filter((word) => word !== "").length;
    const minutes = Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
    const count = `${words.toLocaleString("en-US")} ${words === 1 ? "word" : "words"}`;
    return `${count} · ${minutes} min read`;
}

/** `812 B`, `14 KB`, `2.3 MB`. */
export function sizeLabel(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${Math.round(bytes / 1024)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** How long ago a file changed, in the tree's narrow column: `now`, `5m`, `3h`, `2d`, `Nov 3`. */
export function ageLabel(mtime: string, now: Date): string {
    const then = new Date(mtime);
    const seconds = Math.floor((now.getTime() - then.getTime()) / 1000);
    if (Number.isNaN(seconds)) {
        return "";
    }
    if (seconds < 60) {
        return "now";
    }
    if (seconds < 3600) {
        return `${Math.floor(seconds / 60)}m`;
    }
    if (seconds < 86_400) {
        return `${Math.floor(seconds / 3600)}h`;
    }
    if (seconds < 7 * 86_400) {
        return `${Math.floor(seconds / 86_400)}d`;
    }
    return then.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The comments on one file: the open ones by their line, then the resolved ones. */
export function commentsOn(comments: readonly Comment[], path: string): Comment[] {
    const line = (comment: Comment): number =>
        comment.anchor.kind === "doc" && comment.anchor.line !== null
            ? comment.anchor.line
            : Number.MAX_SAFE_INTEGER;
    return comments
        .filter((comment) => comment.anchor.kind === "doc" && comment.anchor.path === path)
        .sort((a, b) => {
            const resolved = Number(a.state === "resolved") - Number(b.state === "resolved");
            return resolved !== 0
                ? resolved
                : line(a) - line(b) || a.created.localeCompare(b.created);
        });
}

/** The count of unresolved comments on each file, by path. */
export function openCommentCounts(comments: readonly Comment[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const comment of comments) {
        if (comment.anchor.kind === "doc" && comment.state !== "resolved") {
            counts[comment.anchor.path] = (counts[comment.anchor.path] ?? 0) + 1;
        }
    }
    return counts;
}

function squeeze(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/**
 * The index of the block (a paragraph, a list item, a heading, a cell, a code block) that
 * holds a comment's quoted text, or -1. `blocks` are the blocks' texts in page order. The
 * search uses the first line of the quote, then shorter starts of it: a selection that
 * spans two blocks matches the first.
 */
export function blockOfQuote(quote: string, blocks: readonly string[]): number {
    const first = quote.split("\n").map(squeeze).find((line) => line !== "");
    if (first === undefined) {
        return -1;
    }
    const texts = blocks.map(squeeze);
    for (const length of [120, 60, 30, 12]) {
        const needle = first.slice(0, length);
        const at = texts.findIndex((text) => text.includes(needle));
        if (at >= 0) {
            return at;
        }
    }
    return -1;
}
