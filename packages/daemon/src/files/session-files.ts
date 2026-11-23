// Session files (the Files view; `@spinner/protocol` `files.ts`): the walk that lists the
// session directory, the path check every route goes through, and the read, the save and the
// copy to the Downloads folder. Each function takes the session directory's absolute path and
// a path relative to it. A path that leaves the directory through `..` or a symbolic link,
// or that the tree does not list, is refused before any read or write.
import assert from "node:assert/strict";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    statSync,
    writeFileSync,
    type Dirent,
} from "node:fs";
import { basename, extname, isAbsolute, join, sep } from "node:path";
import {
    SESSION_FILE_PATH_CHARS_MAX,
    SESSION_FILE_TEXT_BYTES_MAX,
    SESSION_FILES_DEPTH_MAX,
    SESSION_FILES_MAX,
    SESSION_FILES_READ_ONLY,
    session_file_listed,
    type SessionFileEntry,
    type SessionFileResponse,
    type SessionFilesResponse,
} from "@spinner/protocol";

/** Why a file route refuses, with the HTTP status the route answers. */
export class FileRefusal extends Error {
    constructor(
        message: string,
        readonly status: 400 | 404 | 409 | 413 | 415,
    ) {
        super(message);
    }
}

/** A copy to the Downloads folder tries `name (1)` up to this number before it gives up. */
const DOWNLOAD_NAMES_MAX = 200;
/** The bytes a read looks at to tell a text file from a binary one. */
const BINARY_PROBE_BYTES = 8192;

/**
 * Every listed entry under `root`, sorted by path, directories included. The walk is a loop
 * over a queue of directories, bounded by `SESSION_FILES_MAX` entries and
 * `SESSION_FILES_DEPTH_MAX` levels. A symbolic link is not listed and not followed.
 */
export function list_session_files(root: string): SessionFilesResponse {
    const entries: SessionFileEntry[] = [];
    const queue: string[] = [""];
    let truncated = false;
    for (let index = 0; index < queue.length; index += 1) {
        const dir = queue[index] as string;
        const depth = dir === "" ? 0 : dir.split("/").length;
        for (const child of children(root, dir)) {
            const path = dir === "" ? child.name : `${dir}/${child.name}`;
            if (!session_file_listed(path)) {
                continue;
            }
            if (entries.length >= SESSION_FILES_MAX) {
                truncated = true;
                break;
            }
            const entry = entry_of(root, path, child);
            if (entry === null) {
                continue;
            }
            entries.push(entry);
            if (entry.kind === "dir" && depth + 1 < SESSION_FILES_DEPTH_MAX) {
                queue.push(path);
            }
        }
        if (truncated) {
            break;
        }
    }
    assert.ok(entries.length <= SESSION_FILES_MAX, "the walk passed its bound");
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { root, entries, truncated };
}

/** The entries of one directory; none when it left between the listing and the read. */
function children(root: string, dir: string): Dirent[] {
    try {
        return readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
        return [];
    }
}

/** A file's or a directory's entry; null for a link, a socket, or a file that just left. */
function entry_of(root: string, path: string, child: Dirent): SessionFileEntry | null {
    const is_dir = child.isDirectory();
    if (!is_dir && !child.isFile()) {
        return null;
    }
    try {
        const stat = statSync(join(root, path));
        return {
            path,
            kind: is_dir ? "dir" : "file",
            bytes: is_dir ? 0 : stat.size,
            mtime: stat.mtime.toISOString(),
        };
    } catch {
        return null;
    }
}

/**
 * The absolute path of `path` under `root`, with links resolved, or a refusal: 400 for a
 * path that is absolute, climbs, or is not listed; 404 when nothing is there. `""` is the
 * session directory itself, for `reveal`.
 */
export function resolve_session_file(root: string, path: string): string {
    if (typeof path !== "string" || path.length > SESSION_FILE_PATH_CHARS_MAX) {
        throw new FileRefusal("`path` must be a path relative to the session directory", 400);
    }
    if (path === "") {
        return realpathSync(root);
    }
    if (isAbsolute(path) || path.includes("\\") || path.includes("\0")) {
        throw new FileRefusal(`${path} must be relative to the session directory`, 400);
    }
    if (path.split("/").includes("..") || !session_file_listed(path)) {
        throw new FileRefusal(`${path} is not a file of the session`, 400);
    }
    let real: string;
    let real_root: string;
    try {
        real_root = realpathSync(root);
        real = realpathSync(join(root, path));
    } catch {
        throw new FileRefusal(`no file ${path}`, 404);
    }
    // A link inside the session that points outside it must not be served.
    if (!real.startsWith(`${real_root}${sep}`)) {
        throw new FileRefusal(`${path} is not a file of the session`, 400);
    }
    return real;
}

/** A file's absolute path, or a 400 when `path` names a directory. */
function resolve_file(root: string, path: string): string {
    const absolute = resolve_session_file(root, path);
    if (path === "" || !statSync(absolute).isFile()) {
        const what = path === "" ? "the session directory" : path;
        throw new FileRefusal(`${what} is not a file`, 400);
    }
    return absolute;
}

/**
 * A text file for the page. 413 past `SESSION_FILE_TEXT_BYTES_MAX`, 415 for a file with a
 * NUL byte in its first `BINARY_PROBE_BYTES`: the page offers reveal and download for both.
 */
export function read_session_file(root: string, path: string): SessionFileResponse {
    const absolute = resolve_file(root, path);
    const stat = statSync(absolute);
    if (stat.size > SESSION_FILE_TEXT_BYTES_MAX) {
        const limit = `${SESSION_FILE_TEXT_BYTES_MAX / (1024 * 1024)} MB`;
        throw new FileRefusal(`${path} is larger than ${limit}; reveal or download it`, 413);
    }
    const bytes = readFileSync(absolute);
    if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
        throw new FileRefusal(`${path} is not a text file; reveal or download it`, 415);
    }
    return {
        path,
        absolute,
        text: bytes.toString("utf8"),
        bytes: stat.size,
        mtime: stat.mtime.toISOString(),
        editable: !SESSION_FILES_READ_ONLY.includes(path),
    };
}

/**
 * Saves the operator's edit. `mtime` is the one his read gave: a file that changed since is
 * a 409 and nothing is written, so an agent's edit is never lost to a stale page. The write
 * is a temporary file and a rename, so a reader never sees half a file.
 */
export function save_session_file(
    root: string,
    path: string,
    text: string,
    mtime: string,
): SessionFileResponse {
    const absolute = resolve_file(root, path);
    if (SESSION_FILES_READ_ONLY.includes(path)) {
        throw new FileRefusal(`Spinner writes ${path}; ask the lead to change it`, 409);
    }
    if (Buffer.byteLength(text, "utf8") > SESSION_FILE_TEXT_BYTES_MAX) {
        throw new FileRefusal(`${path} would be larger than the page can save`, 413);
    }
    if (statSync(absolute).mtime.toISOString() !== mtime) {
        throw new FileRefusal(`${path} changed since you opened it; reload it first`, 409);
    }
    const temporary = `${absolute}.spinner-save`;
    writeFileSync(temporary, text, { encoding: "utf8", mode: statSync(absolute).mode });
    renameSync(temporary, absolute);
    return read_session_file(root, path);
}

/**
 * Copies a file to `downloads` and returns the copy's path. A taken name gets ` (1)`,
 * ` (2)`, … before the extension; nothing in the folder is overwritten.
 */
export function download_session_file(root: string, path: string, downloads: string): string {
    const absolute = resolve_file(root, path);
    mkdirSync(downloads, { recursive: true });
    const extension = extname(absolute);
    const stem = basename(absolute, extension);
    for (let attempt = 0; attempt < DOWNLOAD_NAMES_MAX; attempt += 1) {
        const name = attempt === 0 ? `${stem}${extension}` : `${stem} (${attempt})${extension}`;
        const target = join(downloads, name);
        if (!existsSync(target)) {
            copyFileSync(absolute, target);
            return target;
        }
    }
    const full = `${downloads} already holds ${DOWNLOAD_NAMES_MAX} copies of ${path}`;
    throw new FileRefusal(full, 409);
}

/** The content type a raw read answers with; null for a type the page must not show inline. */
export function inline_type(path: string): string | null {
    switch (extname(path).toLowerCase()) {
        case ".png":
            return "image/png";
        case ".jpg":
        case ".jpeg":
            return "image/jpeg";
        case ".gif":
            return "image/gif";
        case ".webp":
            return "image/webp";
        default:
            return null;
    }
}

/** The bytes of a file for `GET …/files/raw`. */
export function raw_session_file(root: string, path: string) {
    const absolute = resolve_file(root, path);
    return { absolute, bytes: readFileSync(absolute) };
}
