// The preview comment tools (s054): `comments_list` reads the operator's comments on the
// running previews, `comment_reply` and `comment_suggest_resolve` answer one, signed with the
// agent's name; the daemon makes the comment wait on the operator. Only the operator resolves.
// Each tool is one daemon call; the daemon checks the author and the state.
import {
    COMMENT_ID_PATTERN,
    comment_where,
    type Comment,
    type CommentResponse,
    type CommentsResponse,
} from "@spinner/protocol";
import type { DaemonClient } from "./tools.js";

export type CommentTool = "comments_list" | "comment_reply" | "comment_suggest_resolve";

/** Upper bound on comments one `comments_list` prints; the rest are counted. */
const COMMENTS_LISTED_MAX = 30;

export async function run_comment_tool(
    name: CommentTool,
    args: Record<string, unknown>,
    client: DaemonClient,
    session: string,
    agent: string,
    session_dir: string,
): Promise<string> {
    if (name === "comments_list") {
        const { comments } = await client.get<CommentsResponse>(`${session}/comments`);
        const all = String(args["all"] ?? "").trim().toLowerCase() === "yes";
        const shown = comments.filter((c) => all || c.state !== "resolved");
        return render_comments(shown, all, session_dir);
    }
    const id = String(args["id"] ?? "").trim();
    if (!COMMENT_ID_PATTERN.test(id)) {
        throw new Error("`id` must be a comment id such as `c3`; run comments_list");
    }
    const text = String(args["text"] ?? "");
    if (text.trim().length === 0) {
        throw new Error("`text` must not be empty");
    }
    const verb = name === "comment_reply" ? "reply" : "suggest-resolve";
    const response = await client.send<CommentResponse>(
        "POST",
        `${session}/comments/${id}/${verb}`,
        { text, author: agent },
    );
    if (name === "comment_reply") {
        return `Replied on ${id}; it now waits on the operator.`;
    }
    return `Suggested resolving ${id} (${response.comment.state}); the operator resolves it.`;
}

/**
 * One block per comment: id, state, place, the screenshot's absolute path (for the `read`
 * tool), console errors, messages.
 */
export function render_comments(
    comments: readonly Comment[],
    all: boolean,
    session_dir: string,
): string {
    if (comments.length === 0) {
        return all ? "No preview comments." : "No open preview comments.";
    }
    const blocks = comments
        .slice(0, COMMENTS_LISTED_MAX)
        .map((comment) => render_comment(comment, session_dir));
    const rest = comments.length - blocks.length;
    if (rest > 0) {
        blocks.push(`… and ${rest} more.`);
    }
    return blocks.join("\n\n");
}

function render_comment(comment: Comment, session_dir: string): string {
    const anchor = comment.anchor;
    const lines = [
        `${comment.id} · ${comment.state} · waits on ${comment.waiting_on} · to ${comment.agent}`,
        `  on ${comment_where(anchor)}`,
    ];
    if (anchor.kind === "preview") {
        const shot = anchor.screenshot === null ? null : `${session_dir}/${anchor.screenshot}`;
        lines.push(`  url: ${anchor.url}`);
        for (const [key, value] of [
            ["selector", anchor.selector],
            ["component", anchor.component],
            ["source", anchor.source],
            ["screenshot", shot],
        ] as const) {
            if (value !== null) {
                lines.push(`  ${key}: ${value}`);
            }
        }
        for (const error of anchor.console_errors) {
            lines.push(`  console error: ${error.replace(/\s+/g, " ").trim()}`);
        }
    }
    for (const message of comment.messages) {
        lines.push(`  ${message.author}: ${message.text.replace(/\s+/g, " ").trim()}`);
    }
    return lines.join("\n");
}
