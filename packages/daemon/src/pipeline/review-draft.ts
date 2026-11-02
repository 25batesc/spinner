// The review lead's artifacts (MISSION.md s016, Plan item 3): the briefing, the draft and
// the post. `review_briefing` writes `artifacts/briefing.md`. `review_draft` and the
// operator's edits go through `validate_draft` first: the event is one of GitHub's two, each
// comment body starts with one severity label, and each `path:line` is on the right side of
// the PR diff, read once per write from `gh api .../pulls/:n/files` (a read, so the read-only
// `gh` runs it). A bad draft returns every fault and writes nothing. `post_review` is the
// operator's click: one PR review through `gh api .../pulls/:n/reviews` at the head SHA,
// `comments[]` with `side: RIGHT`; an `APPROVE` GitHub refuses for the author's own PR is
// reposted as `COMMENT`. The daemon never posts on its own; only the route calls it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ReviewDraft, ReviewDraftComment, ReviewEvent } from "@spinner/protocol";
import {
    REVIEW_BRIEFING_FILE,
    REVIEW_DRAFT_FILE,
    REVIEW_EVENTS,
    REVIEW_POSTED_FILE,
    REVIEW_SEVERITY_LABELS,
} from "@spinner/protocol";
import type { GhRunner, PrRef } from "./github.js";

/** Upper bound on line comments in one review; GitHub's own is far above. */
const COMMENTS_MAX = 200;

/** Upper bound on files one PR diff lists; `--paginate` fetches 30 per page. */
const FILES_MAX = 3_000;

export function briefing_path(session_path: string): string {
    return join(session_path, REVIEW_BRIEFING_FILE);
}

export function write_briefing(session_path: string, markdown: string): string {
    assert.ok(markdown.trim().length > 0, "a briefing must not be empty");
    const path = briefing_path(session_path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
    return path;
}

export function draft_path(session_path: string): string {
    return join(session_path, REVIEW_DRAFT_FILE);
}

/** The draft on disk, or null without one. A file that does not parse is null too. */
export function read_draft(session_path: string): ReviewDraft | null {
    const path = draft_path(session_path);
    if (!existsSync(path)) {
        return null;
    }
    try {
        const parsed = parse_draft(JSON.parse(readFileSync(path, "utf8")));
        return typeof parsed === "string" ? null : parsed;
    } catch {
        return null;
    }
}

export function write_draft(session_path: string, draft: ReviewDraft): string {
    const path = draft_path(session_path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(draft, null, 2)}\n`);
    return path;
}

/** Removes the draft file. True when one was there. */
export function drop_draft(session_path: string): boolean {
    const path = draft_path(session_path);
    if (!existsSync(path)) {
        return false;
    }
    rmSync(path);
    return true;
}

/**
 * The body of `PUT .../review/draft` (and of the tool, after `comments` is parsed) as a
 * `ReviewDraft`, or one sentence saying what is wrong with its shape. The content rules are
 * `validate_draft`'s.
 */
export function parse_draft(input: unknown): ReviewDraft | string {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return "the body must be an object { event, body, comments }";
    }
    const record = input as Record<string, unknown>;
    const event = record["event"];
    if (typeof event !== "string") {
        return "`event` must be APPROVE or COMMENT";
    }
    const body = record["body"];
    if (typeof body !== "string") {
        return "`body` must be a string";
    }
    const comments = record["comments"];
    if (!Array.isArray(comments)) {
        return "`comments` must be an array";
    }
    if (comments.length > COMMENTS_MAX) {
        return `more than ${COMMENTS_MAX} comments`;
    }
    const parsed: ReviewDraftComment[] = [];
    for (const [index, entry] of comments.entries()) {
        if (typeof entry !== "object" || entry === null) {
            return `comments[${index}] must be an object { path, line, body }`;
        }
        const comment = entry as Record<string, unknown>;
        const path = comment["path"];
        const line = Number(comment["line"]);
        const text = comment["body"];
        if (typeof path !== "string" || path.trim().length === 0) {
            return `comments[${index}].path must be a file path`;
        }
        if (!Number.isInteger(line) || line < 1) {
            return `comments[${index}].line must be a positive line number`;
        }
        if (typeof text !== "string") {
            return `comments[${index}].body must be a string`;
        }
        parsed.push({ path: path.trim(), line, body: text });
    }
    return { event: event as ReviewEvent, body, comments: parsed };
}

/** The lines of the PR diff a comment may sit on: file path to right-side line numbers. */
export type DiffLines = Map<string, Set<number>>;

/**
 * The content rules of a draft: the event is one of GitHub's two, the summary is not empty,
 * each comment starts with one severity label and sits on a right-side line of the diff.
 * Every fault is listed, so the lead fixes them in one pass.
 */
export function validate_draft(draft: ReviewDraft, diff: DiffLines): string[] {
    const errors: string[] = [];
    if (!REVIEW_EVENTS.includes(draft.event)) {
        errors.push(`event "${String(draft.event)}" is not APPROVE or COMMENT`);
    }
    if (draft.body.trim().length === 0) {
        errors.push(
            "body is empty; the summary goes there (LGTM, A few nits, but LGTM, A few blockers)",
        );
    }
    const blocking = draft.comments.some((comment) => comment.body.startsWith("BLOCKING:"));
    if (blocking && draft.event === "APPROVE") {
        errors.push("event is APPROVE with a BLOCKING: comment; use COMMENT");
    }
    for (const [index, comment] of draft.comments.entries()) {
        const where = `comments[${index}] (${comment.path}:${comment.line})`;
        if (!REVIEW_SEVERITY_LABELS.some((label) => comment.body.startsWith(label))) {
            const labels = REVIEW_SEVERITY_LABELS.join(", ");
            errors.push(`${where}: body must start with one of ${labels}`);
        }
        if (comment.body.trim().length === 0) {
            errors.push(`${where}: body is empty`);
        }
        const lines = diff.get(comment.path);
        if (lines === undefined) {
            errors.push(`${where}: ${comment.path} is not in the PR diff`);
        } else if (!lines.has(comment.line)) {
            errors.push(
                `${where}: line ${comment.line} is not on the right side of the diff of ` +
                    `${comment.path} (${describe_lines(lines)})`,
            );
        }
    }
    return errors;
}

/** `12-15, 40-41` for the set, so the lead sees where it may comment. */
function describe_lines(lines: Set<number>): string {
    const sorted = [...lines].sort((a, b) => a - b);
    const ranges: string[] = [];
    let start: number | null = null;
    let previous: number | null = null;
    for (const line of sorted) {
        if (start === null || previous === null || line !== previous + 1) {
            if (start !== null && previous !== null) {
                ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
            }
            start = line;
        }
        previous = line;
    }
    if (start !== null && previous !== null) {
        ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    }
    return ranges.length === 0 ? "no lines" : `lines ${ranges.join(", ")}`;
}

interface PullFile {
    filename: string;
    status?: string;
    /** Absent for a binary file or a diff GitHub does not render. */
    patch?: string;
}

/** `gh api repos/:owner/:repo/pulls/:n/files --paginate`, parsed into right-side lines. */
export async function fetch_diff_lines(gh: GhRunner, pr: PrRef): Promise<DiffLines> {
    const stdout = await gh([
        "api",
        `repos/${pr.owner}/${pr.name}/pulls/${pr.number}/files`,
        "--paginate",
        "--slurp",
    ]);
    const pages = JSON.parse(stdout) as PullFile[][];
    const files = pages.flat();
    assert.ok(files.length <= FILES_MAX, `more than ${FILES_MAX} files in the PR`);
    return diff_lines_of(files);
}

/** Pure: the right-side lines of each file's patch (added and context lines). */
export function diff_lines_of(files: readonly PullFile[]): DiffLines {
    const result: DiffLines = new Map();
    for (const file of files) {
        if (file.status === "removed") {
            continue;
        }
        const lines = new Set<number>();
        result.set(file.filename, lines);
        if (file.patch === undefined) {
            continue;
        }
        let right = 0;
        for (const line of file.patch.split("\n")) {
            const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
            if (hunk !== null) {
                right = Number(hunk[1]);
                continue;
            }
            if (line.startsWith("-") || line.startsWith("\\")) {
                continue;
            }
            // An added or a context line is on the right side; both take a comment.
            lines.add(right);
            right += 1;
        }
    }
    return result;
}

export interface PostReviewInput {
    pr: PrRef;
    /** The head SHA the review is anchored to. */
    head: string;
    draft: ReviewDraft;
}

export interface PostReviewResult {
    url: string;
    event: ReviewEvent;
    fell_back: boolean;
}

/** What GitHub says when the author approves their own PR. */
const SELF_APPROVAL = /can not approve your own pull request/i;

/**
 * Posts the draft as one PR review. `gh` here is the write runner, the caller's choice; the
 * request body goes through a file under the session, because `gh api --input` takes one
 * and the comments do not fit `-f` fields.
 */
export async function post_review(
    gh: GhRunner,
    session_path: string,
    input: PostReviewInput,
): Promise<PostReviewResult> {
    assert.ok(/^[0-9a-f]{7,40}$/.test(input.head), `head "${input.head}" is not a SHA`);
    assert.ok(input.draft.comments.length <= COMMENTS_MAX);
    const attempt = async (event: ReviewEvent): Promise<string> => {
        const body = {
            commit_id: input.head,
            event,
            body: input.draft.body,
            comments: input.draft.comments.map((comment) => ({
                path: comment.path,
                line: comment.line,
                side: "RIGHT",
                body: comment.body,
            })),
        };
        const file = join(session_path, "artifacts", "review-post-request.json");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(body));
        const { owner, name, number } = input.pr;
        const stdout = await gh([
            "api",
            "--method",
            "POST",
            `repos/${owner}/${name}/pulls/${number}/reviews`,
            "--input",
            file,
        ]);
        const parsed = JSON.parse(stdout) as { html_url?: string };
        if (typeof parsed.html_url !== "string") {
            throw new Error(`GitHub answered without html_url: ${stdout.slice(0, 200)}`);
        }
        return parsed.html_url;
    };
    try {
        const url = await attempt(input.draft.event);
        return { url, event: input.draft.event, fell_back: false };
    } catch (error) {
        const message = error_text(error);
        if (input.draft.event !== "APPROVE" || !SELF_APPROVAL.test(message)) {
            throw new Error(`GitHub refused the review: ${message}`);
        }
        const url = await attempt("COMMENT");
        return { url, event: "COMMENT", fell_back: true };
    }
}

/** Records the posted review next to the draft, for the pane and the record. */
export function write_posted(
    session_path: string,
    draft: ReviewDraft,
    result: PostReviewResult,
): void {
    const path = join(session_path, REVIEW_POSTED_FILE);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ ...draft, ...result }, null, 2)}\n`);
}

/**
 * `gh api` prints GitHub's JSON body (with `errors[]`) on stdout and one line on stderr; the
 * `execFile` rejection carries both, and the self-approval reason is in the body.
 */
function error_text(error: unknown): string {
    if (error instanceof Error) {
        const stderr = "stderr" in error ? String((error as { stderr: unknown }).stderr) : "";
        const stdout = "stdout" in error ? String((error as { stdout: unknown }).stdout) : "";
        return `${error.message} ${stderr} ${stdout}`.trim();
    }
    return String(error);
}
