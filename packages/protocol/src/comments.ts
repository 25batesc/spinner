// Preview comments (dogfood #52, session s054): the operator freezes a preview in the desktop
// app, marks a part of the page, writes one sentence and sends it to an agent. Each comment
// is a thread the daemon keeps under the session, `artifacts/comments/<id>.json`, with its
// screenshot beside it; never in a repo worktree. The anchor is a union: a comment on a
// passage of a session file (the Files view, 2026-11-23) shares the type, the routes and the
// agent tools. The
// states follow the diff viewer's threads (`diff.ts`): the agent suggests, the operator
// resolves. This file holds the types and the pure text helpers that the daemon (the prompt,
// `needs_human`) and the UI (the listing) must agree on; it uses no `node:` module.

import type { PreviewRect } from "./desktop-bridge.js";

/** `suggested`: the agent asked to resolve it; only the operator resolves. */
export type CommentState = "open" | "suggested" | "resolved";

export const COMMENT_STATES: readonly CommentState[] = ["open", "suggested", "resolved"];

/** Who has to answer next. A resolved comment keeps the last value; nobody waits on it. */
export type CommentWaitingOn = "operator" | "agent";

/** Where a comment points: a part of a running preview. */
export interface PreviewAnchor {
    kind: "preview";
    /** The stack service, as the preview tab names it. */
    service: string;
    /** The page's URL when the operator froze it; secret-looking query values are redacted. */
    url: string;
    /** A CSS selector of the picked element; null for a dragged rectangle or the whole page. */
    selector: string | null;
    /** The picked element's visible text, cut at `COMMENT_ELEMENT_TEXT_MAX`; else null. */
    text: string | null;
    /** The React component that rendered the element, from the fiber; null without React. */
    component: string | null;
    /**
     * Where the component is written, `file:line[:column]`. React 18 and older give the
     * source file from `_debugSource`; React 19 has no `_debugSource`, so this is the dev
     * server's module URL and line from `_debugStack`, which can differ from the source line.
     * Null when the page has neither.
     */
    source: string | null;
    /** CSS pixels in the page viewport; null for the whole page. */
    rect: PreviewRect | null;
    /** The PNG, relative to the session directory; null when the capture failed. */
    screenshot: string | null;
    /** The page's console errors since the previous freeze of this preview, oldest first. */
    console_errors: string[];
}

/** Where a comment points: a passage of a session file, or the whole file. */
export interface DocAnchor {
    kind: "doc";
    /** The file's path, relative to the session directory (`files.ts`). */
    path: string;
    /** The text the operator selected, cut at `COMMENT_QUOTE_CHARS_MAX`; `""` is the file. */
    quote: string;
    /** The nearest heading above the selection, as the page shows it; null above the first. */
    heading: string | null;
    /**
     * The 1-based line of the file where the quote starts, when the daemon found the quote's
     * first words in the source at the time of the comment; else null. The rendered text of
     * a Markdown file differs from its source, so this is a hint for the agent, not a key.
     */
    line: number | null;
}

export type CommentAnchor = PreviewAnchor | DocAnchor;

export interface CommentMessage {
    /** `operator` or an agent name. */
    author: string;
    text: string;
    /** ISO 8601. */
    created: string;
}

/** One thread, as `artifacts/comments/<id>.json` holds it and the routes return it. */
export interface Comment {
    /** `c<n>`, numbered per session from 1. */
    id: string;
    /** The agent the comment was sent to; its replies and the operator's go between the two. */
    agent: string;
    anchor: CommentAnchor;
    /** The first message is the comment; the rest are replies, oldest first. */
    messages: CommentMessage[];
    state: CommentState;
    waiting_on: CommentWaitingOn;
    /** ISO 8601 of the first message. */
    created: string;
    /** ISO 8601 of the last change. */
    updated: string;
}

/** `GET /sessions/:dir/comments`: every comment, newest first. */
export interface CommentsResponse {
    comments: Comment[];
}

/**
 * `POST /sessions/:dir/comments`: a new comment from the operator, delivered to `agent` at
 * once with its screenshot as an image.
 */
export interface NewCommentRequest {
    agent: string;
    text: string;
    anchor: CommentAnchor;
}

/** `POST /sessions/:dir/comments/:id/reply` and `/suggest-resolve`. */
export interface CommentReplyRequest {
    text: string;
    /** `operator` (the default) or the agent's name; the extension's tools send the agent. */
    author?: string;
}

export interface CommentResponse {
    comment: Comment;
    /**
     * What happened to the message for the agent: pi's disposition (`started`, `queued`), or
     * `stopped` when the agent does not run (the text waits for its next prompt). Absent when
     * nothing went to the agent (an agent's own reply, a resolve).
     */
    delivered?: string;
}

/** `POST /sessions/:dir/attachments`: a PNG as base64, without a `data:` prefix. */
export interface AttachmentRequest {
    data: string;
    mime: "image/png";
}

export interface AttachmentResponse {
    /** The file name, for `GET /sessions/:dir/attachments/:name`. */
    name: string;
    /** Relative to the session directory: `artifacts/comments/<name>`. */
    path: string;
}

/** The directory of the records and the screenshots, relative to the session directory. */
export const COMMENTS_DIR = "artifacts/comments";
/** A comment's or a reply's text is at most this long. */
export const COMMENT_TEXT_MAX = 4000;
/** A session holds at most this many comments; the next create is a 409. */
export const COMMENTS_MAX = 500;
/** A thread holds at most this many messages; the next reply is a 409. */
export const COMMENT_MESSAGES_MAX = 100;
/** A decoded attachment is at most this many bytes. A 2x full-page PNG is a few MB. */
export const ATTACHMENT_BYTES_MAX = 8 * 1024 * 1024;
/** A doc comment's selected text is cut at this many characters. */
export const COMMENT_QUOTE_CHARS_MAX = 600;
/** A doc comment's heading is cut at this many characters. */
export const COMMENT_HEADING_CHARS_MAX = 200;
/** A picked element's text is cut at this many characters. */
export const COMMENT_ELEMENT_TEXT_MAX = 200;
/** At most this many console errors go with one comment; the newest are kept. */
export const CONSOLE_ERRORS_MAX = 20;
/** One console error is cut at this many characters. */
export const CONSOLE_ERROR_CHARS_MAX = 500;
/** An attachment name: what the daemon generates, and nothing that leaves the directory. */
export const ATTACHMENT_NAME_PATTERN = /^shot-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}\.png$/;
/** A comment id. */
export const COMMENT_ID_PATTERN = /^c[1-9][0-9]{0,5}$/;

/** Query parameter names whose values a comment record must not keep. */
const SECRET_QUERY_NAME = /token|secret|passw|api[-_]?key|auth|session|signature|^sig$|^code$/i;

/**
 * `url` with the values of secret-looking query parameters replaced by `[redacted]`. A URL
 * that does not parse is returned unchanged; the daemon's `redact` still runs over it.
 */
export function redact_url(url: string): string {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return url;
    }
    let changed = false;
    for (const name of [...new Set(parsed.searchParams.keys())]) {
        if (SECRET_QUERY_NAME.test(name)) {
            parsed.searchParams.set(name, "[redacted]");
            changed = true;
        }
    }
    return changed ? parsed.toString() : url;
}

/** The path and query of a URL, for a short label; the URL itself when it does not parse. */
function url_path(url: string): string {
    try {
        const parsed = new URL(url);
        return `${parsed.pathname}${parsed.search}`;
    } catch {
        return url;
    }
}

/** `admin /refunds?tab=2 · RefundQueue`, or `egm/x.md · Overview` for a doc. */
export function comment_where(anchor: CommentAnchor): string {
    if (anchor.kind === "doc") {
        return anchor.heading === null ? anchor.path : `${anchor.path} · ${anchor.heading}`;
    }
    const component = anchor.component === null ? "" : ` · ${anchor.component}`;
    return `${anchor.service} ${url_path(anchor.url)}${component}`;
}

function rect_text(rect: PreviewRect): string {
    return `x ${rect.x}, y ${rect.y}, ${rect.width}×${rect.height} CSS px`;
}

/** A shorter start of a quote would match by chance. */
const QUOTE_NEEDLE_CHARS_MIN = 4;

/**
 * The 1-based line of `source` where `quote` starts, or null. The search uses the first line
 * of the quote, then a shorter start of it, because a selection in rendered Markdown loses
 * the marks of the source (`**`, a link's target) after a few words.
 */
export function quote_line(source: string, quote: string): number | null {
    const first = quote.split("\n").map((line) => line.trim()).find((line) => line !== "");
    if (first === undefined) {
        return null;
    }
    for (const length of [80, 40, 20]) {
        const needle = first.slice(0, length);
        const at = needle.length < QUOTE_NEEDLE_CHARS_MIN ? -1 : source.indexOf(needle);
        if (at >= 0) {
            return source.slice(0, at).split("\n").length;
        }
    }
    return null;
}

/** `Preview comment` or `Doc comment`: how the texts for the agent and the operator name one. */
export function comment_noun(kind: CommentAnchor["kind"]): string {
    return kind === "doc" ? "Doc comment" : "Preview comment";
}

/**
 * The structured place, one `- key: value` line each, for the agent's message. `absolute` is
 * the absolute path of the screenshot, or of the file for a doc comment; null without one.
 */
function place_lines(anchor: CommentAnchor, absolute: string | null): string[] {
    if (anchor.kind === "doc") {
        const lines = [`- file: ${absolute ?? anchor.path}`];
        if (anchor.line !== null) {
            lines.push(`- line: ${anchor.line}`);
        }
        if (anchor.heading !== null) {
            lines.push(`- under the heading: ${anchor.heading}`);
        }
        lines.push(
            anchor.quote === ""
                ? "- about: the whole file"
                : `- the selected text: ${JSON.stringify(anchor.quote)}`,
        );
        return lines;
    }
    const screenshot_path = absolute;
    const lines = [`- service: ${anchor.service}`, `- url: ${anchor.url}`];
    if (anchor.selector !== null) {
        lines.push(`- selector: ${anchor.selector}`);
    }
    if (anchor.text !== null && anchor.text !== "") {
        lines.push(`- element text: ${JSON.stringify(anchor.text)}`);
    }
    if (anchor.component !== null) {
        lines.push(`- component: ${anchor.component}`);
    }
    if (anchor.source !== null) {
        lines.push(`- source: ${anchor.source}`);
    }
    lines.push(`- area: ${anchor.rect === null ? "the whole page" : rect_text(anchor.rect)}`);
    if (screenshot_path !== null) {
        lines.push(`- screenshot: ${screenshot_path} (attached as an image)`);
    }
    if (anchor.console_errors.length === 0) {
        lines.push("- console errors since the previous freeze: none");
    } else {
        const count = anchor.console_errors.length;
        lines.push(`- console errors since the previous freeze (${count}):`);
        for (const error of anchor.console_errors) {
            lines.push(`  - ${error.replace(/\s+/g, " ").trim()}`);
        }
    }
    return lines;
}

/**
 * The message a new comment sends to its agent: the operator's text, the place, and what to
 * do. `absolute` is the absolute path of the PNG, or of the file for a doc comment; null
 * without one.
 */
export function comment_prompt_text(comment: Comment, absolute: string | null): string {
    const first = comment.messages[0];
    if (first === undefined) {
        throw new Error(`comment ${comment.id} has no message`);
    }
    return [
        `${comment_noun(comment.anchor.kind)} ${comment.id} from ${first.author} on ` +
            `${comment_where(comment.anchor)}:`,
        "",
        first.text,
        "",
        "Where:",
        ...place_lines(comment.anchor, absolute),
        "",
        `Answer with comment_reply ${comment.id}. When the change is made, ` +
            `comment_suggest_resolve ${comment.id}; the operator resolves.`,
    ].join("\n");
}

/** The message an operator's reply sends to the comment's agent. */
export function comment_reply_text(comment: Comment, reply: CommentMessage): string {
    return (
        `${reply.author} replied on ${comment_noun(comment.anchor.kind).toLowerCase()} ` +
        `${comment.id} ` +
        `(${comment_where(comment.anchor)}):\n\n${reply.text}\n\n` +
        `Read the thread with comments_list; answer with comment_reply ${comment.id}.`
    );
}

/**
 * A comment waiting on the operator, as `session.yaml` keeps it (`comments.waiting`) so the
 * stage derivation can name it without reading the records.
 */
export interface CommentWaiting {
    id: string;
    /** `comment_where` of the anchor. */
    where: string;
    /** `doc` for a comment on a session file; absent for a preview comment. */
    kind?: "doc";
}

/** The `needs_human` line while comments wait on the operator; the first is the oldest. */
export function comments_needs_human(waiting: readonly CommentWaiting[]): string {
    const first = waiting[0];
    if (first === undefined) {
        throw new Error("comments_needs_human needs at least one waiting comment");
    }
    const more = waiting.length > 1 ? ` and ${waiting.length - 1} more` : "";
    const noun = comment_noun(first.kind ?? "preview").toLowerCase();
    return `answer ${noun} ${first.id} on ${first.where}${more}`;
}

/** The comments that wait on the operator, oldest first: open or suggested, not resolved. */
export function comments_waiting_on_operator(comments: readonly Comment[]): Comment[] {
    return comments
        .filter((comment) => comment.state !== "resolved" && comment.waiting_on === "operator")
        .sort((a, b) => a.created.localeCompare(b.created));
}
