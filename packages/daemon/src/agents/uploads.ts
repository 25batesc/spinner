// Files the operator attaches to a chat message: `POST /sessions/:dir/uploads` saves one under
// `<session>/artifacts/uploads/`, never in a repo worktree, and `message_images` checks the
// `images` of a prompt or a steer, which must be PNG files under `<session>/artifacts/` (an
// upload or a preview comment's screenshot). A file that is not an image goes to the agent as
// its absolute path in the message text; the chat adds it, not the daemon.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { UPLOAD_BYTES_MAX, type UploadResponse } from "@spinner/protocol";
import { is_png } from "./comments.js";

/** Where uploads go, relative to the session directory. */
export const UPLOADS_DIR = "artifacts/uploads";

/** The JSON body of an upload: base64 is 4/3 of the bytes, plus the wrapper and the name. */
export const UPLOAD_BODY_MAX = Math.ceil((UPLOAD_BYTES_MAX * 4) / 3) + 4096;

/** A kept name's stem and extension are cut at these lengths. */
const STEM_CHARS_MAX = 80;
const EXTENSION_CHARS_MAX = 16;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export interface Upload {
    name: string;
    bytes: Buffer;
}

/** Why an upload is refused: 400 for a bad body, 413 past `UPLOAD_BYTES_MAX`. */
export interface UploadRefusal {
    status: 400 | 413;
    error: string;
}

export function parse_upload(input: unknown): Upload | UploadRefusal {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return { status: 400, error: "request body must be a JSON object" };
    }
    const body = input as Record<string, unknown>;
    const name = body["name"];
    if (typeof name !== "string" || name.trim().length === 0) {
        return { status: 400, error: "`name` must be the file's name" };
    }
    const data = body["data"];
    if (typeof data !== "string" || !BASE64.test(data)) {
        return { status: 400, error: "`data` must be the file as base64" };
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > UPLOAD_BYTES_MAX) {
        return { status: 413, error: `the file is larger than ${UPLOAD_BYTES_MAX} bytes` };
    }
    return { name, bytes };
}

/**
 * The name an upload is kept under: the last path part, every run of characters outside
 * `A-Z a-z 0-9 _ -` turned into one `-`, the extension kept. `file` when nothing is left.
 */
export function safe_upload_name(name: string): string {
    const base = name.split(/[\\/]/).pop() ?? "";
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const extension = dot > 0 ? clean(base.slice(dot + 1)).slice(0, EXTENSION_CHARS_MAX) : "";
    const kept = clean(stem).slice(0, STEM_CHARS_MAX) || "file";
    return extension.length === 0 ? kept : `${kept}.${extension}`;
}

function clean(text: string): string {
    return text.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Saves the upload as `artifacts/uploads/<stamp>-<safe name>`. The stamp is the UTC time to
 * the second and six random hex digits, so two uploads of one name never collide.
 */
export function save_upload(session_path: string, upload: Upload, now: Date): UploadResponse {
    assert.ok(upload.bytes.length <= UPLOAD_BYTES_MAX, "upload past the bound");
    const time = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const name = `${time}-${randomBytes(3).toString("hex")}-${safe_upload_name(upload.name)}`;
    const dir = join(session_path, UPLOADS_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), upload.bytes, { flag: "wx" });
    return { name, path: `${UPLOADS_DIR}/${name}` };
}

/**
 * The absolute paths of a message's `images`, or the reason one is refused: each must be
 * relative to the session directory and name an existing PNG under `artifacts/`, links
 * resolved.
 */
export function message_images(session_path: string, paths: readonly string[]): string[] | string {
    const absolute: string[] = [];
    for (const path of paths) {
        if (isAbsolute(path)) {
            return `image ${path} must be relative to the session directory`;
        }
        let real: string;
        let artifacts: string;
        try {
            real = realpathSync(resolve(session_path, path));
            artifacts = realpathSync(join(session_path, "artifacts"));
        } catch {
            return `image ${path} does not exist`;
        }
        if (!real.startsWith(`${artifacts}${sep}`)) {
            return `image ${path} is not under artifacts/`;
        }
        if (!statSync(real).isFile() || !is_png(readFileSync(real))) {
            return `image ${path} is not a PNG`;
        }
        absolute.push(real);
    }
    return absolute;
}
