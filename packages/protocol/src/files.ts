// Session files (the operator's ask of 2026-11-23): the Files view shows the session
// directory as a tree, the way mdview shows a folder. He reads a file, comments on it for an
// agent, edits it, reveals it in the file manager and copies it to his Downloads folder. The
// daemon serves only what the tree lists: never a repo worktree, a run directory, a log or a
// pi transcript. This file holds the types, the limits and the visibility rule that the
// daemon and the UI must agree on; it uses no `node:` module.

/** One entry of the tree. Directories come with their entries; the UI nests them by path. */
export interface SessionFileEntry {
    /** Relative to the session directory, with `/` between the parts. */
    path: string;
    kind: "file" | "dir";
    /** The file's size; 0 for a directory. */
    bytes: number;
    /** ISO 8601 modification time. */
    mtime: string;
}

/** `GET /sessions/:dir/files`: every listed entry, sorted by path. */
export interface SessionFilesResponse {
    /** The absolute path of the session directory. */
    root: string;
    entries: SessionFileEntry[];
    /** True when the walk stopped at `SESSION_FILES_MAX`; the tree is not whole. */
    truncated: boolean;
}

/** `GET /sessions/:dir/files/text?path=`: a text file. */
export interface SessionFileResponse {
    path: string;
    /** The absolute path, for the header and the clipboard. */
    absolute: string;
    text: string;
    bytes: number;
    /** ISO 8601; a save sends it back so the daemon can refuse a stale write. */
    mtime: string;
    /** False for a file Spinner itself writes (`SESSION_FILES_READ_ONLY`). */
    editable: boolean;
}

/**
 * Body of `PUT /sessions/:dir/files/text`. `mtime` is the one the read gave: when the file
 * changed since, the daemon answers 409 and writes nothing, so an agent's edit is not lost.
 */
export interface SessionFileSaveRequest {
    path: string;
    text: string;
    mtime: string;
}

/** Body of `POST /sessions/:dir/files/reveal` and `.../download`. `""` is the session dir. */
export interface SessionFileActionRequest {
    path: string;
}

/** `POST /sessions/:dir/files/download`: where the copy went. */
export interface SessionFileDownloadResponse {
    /** The absolute path of the copy in the operator's Downloads folder. */
    saved: string;
}

/** The walk lists at most this many entries; past it `truncated` is true. */
export const SESSION_FILES_MAX = 3000;
/** The walk goes at most this many directories deep. */
export const SESSION_FILES_DEPTH_MAX = 8;
/** A text file past this size is not read into the page; reveal or download it. */
export const SESSION_FILE_TEXT_BYTES_MAX = 2 * 1024 * 1024;
/** A relative path is at most this long. */
export const SESSION_FILE_PATH_CHARS_MAX = 1024;

/**
 * Top-level directories that are machinery, not documents: the repo checkouts, the subagent
 * run directories and the logs.
 */
export const SESSION_FILES_HIDDEN_ROOTS: readonly string[] = [
    "worktrees",
    "egm-runs",
    "log",
    "diff",
];

/** Directory names never listed, at any depth. */
export const SESSION_FILES_HIDDEN_NAMES: readonly string[] = ["node_modules", "__pycache__"];

/** Files Spinner writes itself. An edit from the page would race its writer. */
export const SESSION_FILES_READ_ONLY: readonly string[] = ["session.yaml", "MISSION.md"];

/**
 * True when the tree lists `path` (relative, `/` separated) and the routes serve it. Hidden:
 * a name that starts with a dot, the machine directories, and each agent's pi transcripts
 * (`agents/<name>/pi`).
 */
export function session_file_listed(path: string): boolean {
    const parts = path.split("/");
    if (parts.some((part) => part === "" || part.startsWith("."))) {
        return false;
    }
    if (parts.some((part) => SESSION_FILES_HIDDEN_NAMES.includes(part))) {
        return false;
    }
    if (SESSION_FILES_HIDDEN_ROOTS.includes(parts[0] ?? "")) {
        return false;
    }
    return !(parts[0] === "agents" && parts[2] === "pi");
}
