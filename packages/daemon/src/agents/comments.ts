// The preview comment store (s054): one JSON record per comment and the screenshots beside
// them, under `<session>/artifacts/comments/`, never in a repo worktree. The functions here
// read and write those files, parse the request bodies, keep secrets out of a record, and
// mirror the comments waiting on the operator into `session.yaml` so the stage derivation
// can name the next one. The routes in `routes-comments.ts` call them; nothing here talks to
// an agent.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    ATTACHMENT_BYTES_MAX,
    ATTACHMENT_NAME_PATTERN,
    COMMENT_ELEMENT_TEXT_MAX,
    COMMENT_ID_PATTERN,
    COMMENT_TEXT_MAX,
    COMMENTS_DIR,
    COMMENTS_MAX,
    CONSOLE_ERROR_CHARS_MAX,
    CONSOLE_ERRORS_MAX,
    comment_where,
    comments_waiting_on_operator,
    redact,
    redact_url,
    type AttachmentResponse,
    type Comment,
    type CommentReplyRequest,
    type NewCommentRequest,
    type PreviewAnchor,
    type PreviewRect,
    type SessionSummary,
} from "@spinner/protocol";

/** The first 8 bytes of every PNG file. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Bounds on the anchor's free-text fields, so a record stays a few KB. */
const SELECTOR_CHARS_MAX = 1000;
const COMPONENT_CHARS_MAX = 200;
const SOURCE_CHARS_MAX = 500;
const URL_CHARS_MAX = 2000;
const SERVICE_CHARS_MAX = 100;

export function comments_dir(summary: SessionSummary): string {
    return join(summary.path, COMMENTS_DIR);
}

/**
 * Saves a PNG under `artifacts/comments/` with a fresh name. Throws on bytes that are not a
 * PNG or past the bound; the route checks both first, so a throw here is a bug.
 */
export function save_attachment(
    summary: SessionSummary,
    png: Buffer,
    now: Date,
): AttachmentResponse {
    assert.ok(png.length <= ATTACHMENT_BYTES_MAX, "attachment past the bound");
    assert.ok(is_png(png), "attachment is not a PNG");
    const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const name = `shot-${stamp}-${randomBytes(3).toString("hex")}.png`;
    assert.match(name, ATTACHMENT_NAME_PATTERN);
    const dir = comments_dir(summary);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), png, { flag: "wx" });
    return { name, path: `${COMMENTS_DIR}/${name}` };
}

export function is_png(bytes: Buffer): boolean {
    return bytes.length > PNG_SIGNATURE.length && bytes.subarray(0, 8).equals(PNG_SIGNATURE);
}

/** The absolute path of a saved attachment, or null for a bad or missing name. */
export function attachment_path(summary: SessionSummary, name: string): string | null {
    if (!ATTACHMENT_NAME_PATTERN.test(name)) {
        return null;
    }
    const path = join(comments_dir(summary), name);
    return existsSync(path) ? path : null;
}

/** Every comment of the session, newest first. A record that does not parse is skipped. */
export function list_comments(summary: SessionSummary): Comment[] {
    const dir = comments_dir(summary);
    if (!existsSync(dir)) {
        return [];
    }
    const comments: Comment[] = [];
    for (const file of readdirSync(dir)) {
        const id = file.endsWith(".json") ? file.slice(0, -5) : "";
        if (!COMMENT_ID_PATTERN.test(id)) {
            continue;
        }
        const comment = read_comment(summary, id);
        if (comment !== null) {
            comments.push(comment);
        }
    }
    assert.ok(comments.length <= COMMENTS_MAX + 1, "more comments than the bound");
    return comments.sort((a, b) => b.created.localeCompare(a.created));
}

export function read_comment(summary: SessionSummary, id: string): Comment | null {
    if (!COMMENT_ID_PATTERN.test(id)) {
        return null;
    }
    const path = join(comments_dir(summary), `${id}.json`);
    if (!existsSync(path)) {
        return null;
    }
    try {
        const comment = JSON.parse(readFileSync(path, "utf8")) as Comment;
        return comment.id === id ? comment : null;
    } catch {
        return null;
    }
}

export function write_comment(summary: SessionSummary, comment: Comment): void {
    assert.match(comment.id, COMMENT_ID_PATTERN);
    assert.ok(comment.messages.length > 0, "a comment has at least one message");
    const dir = comments_dir(summary);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${comment.id}.json`), `${JSON.stringify(comment, null, 2)}\n`);
}

/** `c<n>` with n one past the highest id on disk. */
export function next_comment_id(summary: SessionSummary): string {
    const dir = comments_dir(summary);
    let highest = 0;
    if (existsSync(dir)) {
        for (const file of readdirSync(dir)) {
            const match = /^c([1-9][0-9]*)\.json$/.exec(file);
            if (match !== null) {
                highest = Math.max(highest, Number(match[1]));
            }
        }
    }
    return `c${highest + 1}`;
}

/** `session.comments` for the comments on disk: absent when none waits. */
export function session_comments(
    comments: readonly Comment[],
): { waiting: { id: string; where: string }[] } | undefined {
    const waiting = comments_waiting_on_operator(comments);
    if (waiting.length === 0) {
        return undefined;
    }
    return {
        waiting: waiting.map((comment) => ({
            id: comment.id,
            where: comment_where(comment.anchor),
        })),
    };
}

/** A copy of `anchor` with secrets out: the URL's secret query values and the env's values. */
export function redact_anchor(
    anchor: PreviewAnchor,
    env: Readonly<Record<string, string | undefined>>,
): PreviewAnchor {
    const text = (value: string) => redact(value, env);
    const maybe = (value: string | null) => (value === null ? null : text(value));
    return {
        ...anchor,
        url: text(redact_url(anchor.url)),
        selector: maybe(anchor.selector),
        text: maybe(anchor.text),
        console_errors: anchor.console_errors.map(text),
    };
}

/** Parses `POST /sessions/:dir/comments`; a string is the 400's reason. */
export function parse_new_comment(input: unknown): NewCommentRequest | string {
    const body = as_record(input);
    if (typeof body === "string") {
        return body;
    }
    const agent = body["agent"];
    if (typeof agent !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(agent)) {
        return "`agent` must be an agent name";
    }
    const text = parse_text(body["text"]);
    if (typeof text !== "string") {
        return text.error;
    }
    const anchor = parse_anchor(body["anchor"]);
    if (typeof anchor === "string") {
        return anchor;
    }
    return { agent, text, anchor };
}

/** Parses a reply or a suggestion; a string is the 400's reason. */
export function parse_comment_reply(input: unknown): Required<CommentReplyRequest> | string {
    const body = as_record(input);
    if (typeof body === "string") {
        return body;
    }
    const text = parse_text(body["text"]);
    if (typeof text !== "string") {
        return text.error;
    }
    const author = body["author"] ?? "operator";
    if (typeof author !== "string" || author.length === 0 || author.length > 40) {
        return "`author` must be `operator` or an agent name";
    }
    return { text, author };
}

/** The base64 PNG of `POST /sessions/:dir/attachments`, decoded; a string is the reason. */
export function parse_attachment(input: unknown): Buffer | string {
    const body = as_record(input);
    if (typeof body === "string") {
        return body;
    }
    if (body["mime"] !== "image/png") {
        return "`mime` must be image/png";
    }
    const data = body["data"];
    if (typeof data !== "string" || data.length === 0) {
        return "`data` must be the PNG as base64";
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > ATTACHMENT_BYTES_MAX) {
        return `the image is larger than ${ATTACHMENT_BYTES_MAX} bytes`;
    }
    if (!is_png(bytes)) {
        return "`data` is not a PNG";
    }
    return bytes;
}

/** A message text, trimmed, or the reason it is refused. */
function parse_text(value: unknown): string | { error: string } {
    if (typeof value !== "string" || value.trim().length === 0) {
        return { error: "`text` must not be empty" };
    }
    if (value.length > COMMENT_TEXT_MAX) {
        return { error: `\`text\` is longer than ${COMMENT_TEXT_MAX} characters` };
    }
    return value.trim();
}

function parse_anchor(value: unknown): PreviewAnchor | string {
    const anchor = as_record(value);
    if (typeof anchor === "string") {
        return "`anchor` must be an object";
    }
    if (anchor["kind"] !== "preview") {
        return "`anchor.kind` must be `preview`; doc comments come with the docs tab";
    }
    const service = anchor["service"];
    if (typeof service !== "string" || service.length === 0 || service.length > SERVICE_CHARS_MAX) {
        return "`anchor.service` must be the service name";
    }
    const url = anchor["url"];
    if (typeof url !== "string" || !/^https?:\/\//.test(url) || url.length > URL_CHARS_MAX) {
        return "`anchor.url` must be an http(s) URL";
    }
    const rect = parse_rect(anchor["rect"]);
    if (rect === undefined) {
        return "`anchor.rect` must be null or { x, y, width, height } in CSS pixels";
    }
    const screenshot = anchor["screenshot"] ?? null;
    if (screenshot !== null && !is_attachment_path(screenshot)) {
        return "`anchor.screenshot` must be null or a path that POST .../attachments returned";
    }
    const errors = anchor["console_errors"] ?? [];
    if (!Array.isArray(errors) || errors.some((error) => typeof error !== "string")) {
        return "`anchor.console_errors` must be a list of strings";
    }
    return {
        kind: "preview",
        service,
        url,
        selector: optional_text(anchor["selector"], SELECTOR_CHARS_MAX),
        text: optional_text(anchor["text"], COMMENT_ELEMENT_TEXT_MAX),
        component: optional_text(anchor["component"], COMPONENT_CHARS_MAX),
        source: optional_text(anchor["source"], SOURCE_CHARS_MAX),
        rect,
        screenshot,
        console_errors: (errors as string[])
            .slice(-CONSOLE_ERRORS_MAX)
            .map((error) => error.slice(0, CONSOLE_ERROR_CHARS_MAX)),
    };
}

function is_attachment_path(value: unknown): value is string {
    if (typeof value !== "string" || !value.startsWith(`${COMMENTS_DIR}/`)) {
        return false;
    }
    return ATTACHMENT_NAME_PATTERN.test(value.slice(COMMENTS_DIR.length + 1));
}

/** A string cut at `max`, or null for anything else or an empty string. */
function optional_text(value: unknown, max: number): string | null {
    if (typeof value !== "string" || value.trim().length === 0) {
        return null;
    }
    return value.trim().slice(0, max);
}

/** Null stays null; a valid rect is rounded to integers; anything else is undefined. */
function parse_rect(value: unknown): PreviewRect | null | undefined {
    if (value === null || value === undefined) {
        return null;
    }
    const rect = as_record(value);
    if (typeof rect === "string") {
        return undefined;
    }
    const numbers = ["x", "y", "width", "height"].map((key) => rect[key]);
    if (numbers.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
        return undefined;
    }
    const [x, y, width, height] = (numbers as number[]).map(Math.round) as [
        number,
        number,
        number,
        number,
    ];
    if (width <= 0 || height <= 0) {
        return undefined;
    }
    return { x, y, width, height };
}

function as_record(input: unknown): Record<string, unknown> | string {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return "request body must be a JSON object";
    }
    return input as Record<string, unknown>;
}
