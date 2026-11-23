// The session file routes (docs/DAEMON_API.md "Session files"). `GET /sessions/:dir/files`
// lists the tree; `GET …/files/text` and `PUT …/files/text` read and save a text file;
// `GET …/files/raw` serves an image inline and anything else as a download; `POST
// …/files/reveal` shows a file in the file manager of the machine the daemon runs on; `POST
// …/files/download` copies one to the operator's Downloads folder. The daemon and the
// operator share one machine, so both work from a browser tab as well as the desktop app.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Context, Hono } from "hono";
import type {
    ErrorResponse,
    SessionFileDownloadResponse,
    SessionFileResponse,
    SessionFilesResponse,
} from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";
import { find_session } from "../store/session-store.js";
import {
    download_session_file,
    FileRefusal,
    inline_type,
    list_session_files,
    raw_session_file,
    read_session_file,
    resolve_session_file,
    save_session_file,
} from "./session-files.js";

/** The file manager and the Downloads folder; tests pass a recorder and a temporary folder. */
export interface FileHooks {
    /** Shows `absolute` selected in the file manager. */
    reveal?: (absolute: string) => Promise<void>;
    downloads_dir?: string;
}

export interface FileRouteDeps {
    home: SpinnerHome;
    log: (line: string) => void;
    files?: FileHooks | undefined;
}

/** The longest body of a save: the text limit as JSON, with room for escapes. */
const SAVE_BODY_CHARS_MAX = 6 * 1024 * 1024;
/** `open` and `xdg-open` return at once; one that hangs is killed after this long. */
const REVEAL_TIMEOUT_MS = 10_000;

/**
 * `open -R` selects the file in Finder. Other systems have no common "select" call, so the
 * file's directory opens.
 */
export function reveal_in_file_manager(absolute: string): Promise<void> {
    const [command, args] =
        process.platform === "darwin"
            ? ["open", ["-R", absolute]]
            : ["xdg-open", [dirname(absolute)]];
    return new Promise((done, fail) => {
        execFile(command as string, args as string[], { timeout: REVEAL_TIMEOUT_MS }, (error) => {
            if (error === null) {
                done();
            } else {
                fail(new Error(`${command} failed: ${error.message}`));
            }
        });
    });
}

export function mount_file_routes(app: Hono, deps: FileRouteDeps): void {
    const reveal = deps.files?.reveal ?? reveal_in_file_manager;
    const downloads = deps.files?.downloads_dir ?? join(homedir(), "Downloads");

    app.get("/sessions/:dir/files", (c) =>
        guarded(c, deps, (root) => {
            const body: SessionFilesResponse = list_session_files(root);
            return c.json(body);
        }),
    );

    app.get("/sessions/:dir/files/text", (c) =>
        guarded(c, deps, (root) => {
            const body: SessionFileResponse = read_session_file(root, c.req.query("path") ?? "");
            return c.json(body);
        }),
    );

    app.get("/sessions/:dir/files/raw", (c) =>
        guarded(c, deps, (root) => {
            const path = c.req.query("path") ?? "";
            const { absolute, bytes } = raw_session_file(root, path);
            const type = inline_type(absolute);
            // Only an image shows inline. A file an agent wrote must never run as a page of
            // the daemon's origin, so everything else is a download.
            const name = encodeURIComponent(basename(absolute));
            const shown = type === null ? "attachment" : "inline";
            return c.body(bytes, 200, {
                "content-type": type ?? "application/octet-stream",
                "content-disposition": `${shown}; filename*=UTF-8''${name}`,
                "x-content-type-options": "nosniff",
                "cache-control": "no-store",
            });
        }),
    );

    app.put("/sessions/:dir/files/text", async (c) => {
        const text = await c.req.text();
        return guarded(c, deps, (root) => {
            if (text.length > SAVE_BODY_CHARS_MAX) {
                throw new FileRefusal("the text is larger than the page can save", 413);
            }
            const request = parse_save(text);
            const body: SessionFileResponse = save_session_file(
                root,
                request.path,
                request.text,
                request.mtime,
            );
            deps.log(`${c.req.param("dir")}: the operator saved ${request.path}`);
            return c.json(body);
        });
    });

    app.post("/sessions/:dir/files/reveal", async (c) => {
        const text = await c.req.text();
        return guarded(c, deps, async (root) => {
            await reveal(resolve_session_file(root, parse_path(text)));
            return c.json({ ok: true });
        });
    });

    app.post("/sessions/:dir/files/download", async (c) => {
        const text = await c.req.text();
        return guarded(c, deps, (root) => {
            const saved = download_session_file(root, parse_path(text), downloads);
            const body: SessionFileDownloadResponse = { saved };
            return c.json(body, 201);
        });
    });
}

/** Runs a route on the session's directory; a `FileRefusal` becomes its status and reason. */
async function guarded(
    c: Context,
    deps: FileRouteDeps,
    work: (root: string) => Response | Promise<Response>,
): Promise<Response> {
    const dir = c.req.param("dir") ?? "";
    const summary = find_session(deps.home, dir);
    if (summary === null) {
        return c.json(error_body(`no session ${dir}`), 404);
    }
    try {
        return await work(summary.path);
    } catch (failure) {
        if (failure instanceof FileRefusal) {
            return c.json(error_body(failure.message), failure.status);
        }
        throw failure;
    }
}

function parse_object(text: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text) as unknown;
    } catch {
        throw new FileRefusal("request body must be a JSON object", 400);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new FileRefusal("request body must be a JSON object", 400);
    }
    return parsed as Record<string, unknown>;
}

function parse_path(text: string): string {
    const path = parse_object(text)["path"];
    if (typeof path !== "string") {
        throw new FileRefusal("`path` must be a path relative to the session directory", 400);
    }
    return path;
}

function parse_save(text: string): { path: string; text: string; mtime: string } {
    const body = parse_object(text);
    const { path, text: content, mtime } = body;
    if (typeof path !== "string" || path === "") {
        throw new FileRefusal("`path` must name a file of the session", 400);
    }
    if (typeof content !== "string") {
        throw new FileRefusal("`text` must be the file's new text", 400);
    }
    if (typeof mtime !== "string") {
        throw new FileRefusal("`mtime` must be the modification time the read gave", 400);
    }
    return { path, text: content, mtime };
}

function error_body(error: string): ErrorResponse {
    return { error };
}
