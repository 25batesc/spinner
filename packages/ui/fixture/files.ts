// The session files and the comments of the fixture daemon, for the Files view
// (`SessionFiles.tsx`). Every session has the same few files in memory: its mission, two
// documents of an EGM skill, a writeup and a log. The routes answer as the daemon's do: the
// tree, a text file, a save that a stale `mtime` refuses, reveal and download (which touch
// nothing here), and the comment threads with a reply and a resolve. No agent answers.
import type { ServerResponse } from "node:http";

import type {
    Comment, SessionFileEntry, SessionFileResponse, SpinnerEvent,
} from "@spinner/protocol";

export interface FilesHost {
    mission(dir: string): string;
    emit(event: SpinnerEvent): void;
}

export const FILES_ROUTE = /^\/sessions\/([^/]+)\/(files|comments)(\/.*)?$/;

/** The home the fixture's absolute paths name. */
const HOME = "/home/fixture/.spinner/sessions";
const SEEDED_AT = "2026-10-20T10:00:00.000Z";

const SEEDED: Record<string, string> = {
    "egm/concepts_brief.md": [
        "# CSV export: concepts", "", "## Overview", "",
        "The list page gets an export of the rows it shows.", "",
        "## Options", "", "- A streamed CSV from the API.", "- A file built in the browser.", "",
        "See the [review](reviews/critic_report.md).", "",
    ].join("\n"),
    "egm/reviews/critic_report.md": "# Critic report\n\nFinding 1: no row limit.\n",
    "artifacts/team-writeup.md": "# Writeup\n\nWhat changed this week, for the team.\n",
    "artifacts/local-test/run.log": "ok 12 tests\n",
};

function sendJson(response: ServerResponse, body: unknown, status = 200): true {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
    return true;
}

interface StoredFile {
    text: string;
    mtime: string;
}

export class FilesFixture {
    private readonly files = new Map<string, Map<string, StoredFile>>();
    private readonly comments = new Map<string, Comment[]>();

    constructor(private readonly host: FilesHost) {}

    /** The files of a session, seeded at the first look. */
    private of(dir: string): Map<string, StoredFile> {
        let files = this.files.get(dir);
        if (files === undefined) {
            files = new Map(Object.entries(SEEDED).map(([path, text]) =>
                [path, { text, mtime: SEEDED_AT }]));
            this.files.set(dir, files);
        }
        files.set("MISSION.md", { text: this.host.mission(dir), mtime: SEEDED_AT });
        return files;
    }

    private entries(dir: string): SessionFileEntry[] {
        const entries = new Map<string, SessionFileEntry>();
        for (const [path, file] of this.of(dir)) {
            const parts = path.split("/");
            for (let depth = 1; depth < parts.length; depth += 1) {
                const above = parts.slice(0, depth).join("/");
                entries.set(above, { path: above, kind: "dir", bytes: 0, mtime: file.mtime });
            }
            entries.set(path, { path, kind: "file", bytes: file.text.length, mtime: file.mtime });
        }
        return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
    }

    private file(dir: string, path: string): SessionFileResponse | null {
        const file = this.of(dir).get(path);
        if (file === undefined) {
            return null;
        }
        return {
            path, absolute: `${HOME}/${dir}/${path}`, text: file.text, bytes: file.text.length,
            mtime: file.mtime, editable: path !== "MISSION.md",
        };
    }

    /** Answers a files or a comments route; false when `path` is neither. */
    handle(
        method: string, path: string, search: string, body: Record<string, unknown>,
        response: ServerResponse,
    ): boolean {
        const match = FILES_ROUTE.exec(path);
        if (match === null) {
            return false;
        }
        const [, dir = "", area, rest = ""] = match;
        return area === "files"
            ? this.filesRoute(method, dir, rest, search, body, response)
            : this.commentsRoute(method, dir, rest, body, response);
    }

    private filesRoute(
        method: string, dir: string, rest: string, search: string,
        body: Record<string, unknown>, response: ServerResponse,
    ): boolean {
        const asked = new URLSearchParams(search).get("path") ?? String(body["path"] ?? "");
        if (method === "GET" && rest === "") {
            const root = `${HOME}/${dir}`;
            return sendJson(response, { root, entries: this.entries(dir), truncated: false });
        }
        if (method === "POST" && rest === "/reveal") {
            return sendJson(response, { ok: true });
        }
        const file = this.file(dir, asked);
        if (file === null) {
            return sendJson(response, { error: `no file ${asked}` }, 404);
        }
        if (method === "GET" && rest === "/text") {
            return sendJson(response, file);
        }
        if (method === "POST" && rest === "/download") {
            return sendJson(response, { saved: `/home/fixture/Downloads/${asked}` }, 201);
        }
        if (method === "PUT" && rest === "/text") {
            if (!file.editable || body["mtime"] !== file.mtime) {
                const reason = file.editable
                    ? `${asked} changed since you opened it; reload it first`
                    : `Spinner writes ${asked}; ask the lead to change it`;
                return sendJson(response, { error: reason }, 409);
            }
            const mtime = new Date().toISOString();
            this.of(dir).set(asked, { text: String(body["text"] ?? ""), mtime });
            return sendJson(response, this.file(dir, asked));
        }
        return false;
    }

    private commentsRoute(
        method: string, dir: string, rest: string, body: Record<string, unknown>,
        response: ServerResponse,
    ): boolean {
        const list = this.comments.get(dir) ?? [];
        if (method === "GET" && rest === "") {
            return sendJson(response, { comments: [...list].reverse() });
        }
        const now = new Date().toISOString();
        if (method === "POST" && rest === "") {
            const comment: Comment = {
                id: `c${list.length + 1}`, agent: String(body["agent"]), state: "open",
                waiting_on: "agent", anchor: body["anchor"] as Comment["anchor"],
                messages: [{ author: "operator", text: String(body["text"]), created: now }],
                created: now, updated: now,
            };
            this.comments.set(dir, [...list, comment]);
            this.changed(dir, comment);
            return sendJson(response, { comment, delivered: "started" }, 201);
        }
        const [, id, verb] = /^\/([^/]+)\/(reply|resolve)$/.exec(rest) ?? [];
        const comment = list.find((item) => item.id === id);
        if (method !== "POST" || comment === undefined) {
            return sendJson(response, { error: `no comment ${id ?? ""}` }, 404);
        }
        if (verb === "resolve") {
            comment.state = "resolved";
        } else {
            comment.messages.push({ author: "operator", text: String(body["text"]), created: now });
        }
        comment.updated = now;
        this.changed(dir, comment);
        return sendJson(response, { comment });
    }

    private changed(dir: string, comment: Comment): void {
        this.host.emit({
            type: "comment.updated", ts: comment.updated, session: dir, id: comment.id,
            state: comment.state, waiting_on: comment.waiting_on, author: "operator",
        });
    }
}
