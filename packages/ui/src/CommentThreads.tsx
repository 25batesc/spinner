// Preview comment threads (s054): one thread with its place, its screenshot, its messages and
// the operator's reply and resolve; the strip of open comments above a preview; and the
// section of the Threads tab. The daemon moves the state; every view reloads on
// `comment.updated` through the `comments` revision.
import { useState } from "react";

import { comment_where, type Comment } from "@spinner/protocol";

import { attachmentUrl, openCommentsOn, waitingLabel } from "./preview-comment.ts";
import { commentAction, fetchComments, useLoaded } from "./remote.ts";

export function CommentThread({ dir, comment }: { dir: string; comment: Comment }) {
    const [reply, setReply] = useState("");
    const [error, setError] = useState<string | null>(null);
    const act = (verb: "reply" | "resolve", text?: string) =>
        commentAction(dir, comment.id, verb, text).then(
            () => {
                setError(null);
                setReply("");
            },
            (failure: unknown) => setError(String(failure)),
        );
    const anchor = comment.anchor;
    const shot = anchor.kind === "preview" ? attachmentUrl(dir, anchor.screenshot) : null;
    const waits = comment.state !== "resolved" && comment.waiting_on === "operator";
    return (
        <li className={`thread thread-${comment.state}`} data-comment={comment.id}>
            <div className="thread-head">
                <strong>{comment.id}</strong>
                <span className={waits ? "badge pill-accent" : "badge"}>
                    {waitingLabel(comment)}
                </span>
                <span className="muted">to {comment.agent}</span>
                <code className="thread-location">{comment_where(anchor)}</code>
            </div>
            {anchor.kind === "preview" && anchor.source !== null && (
                <p className="muted comment-source">{anchor.source}</p>
            )}
            {shot !== null && (
                <a href={shot} target="_blank" rel="noreferrer">
                    <img className="comment-thumb" src={shot} alt={`Screenshot of ${comment.id}`} />
                </a>
            )}
            {comment.messages.map((message, index) => (
                <p key={index} className={index === 0 ? "thread-body" : "thread-reply"}>
                    {index > 0 && <span className="muted">{message.author}: </span>}
                    {message.text}
                </p>
            ))}
            {comment.state !== "resolved" && (
                <div className="thread-actions">
                    <input
                        aria-label={`Reply to ${comment.id}`}
                        value={reply}
                        placeholder="reply as you"
                        onChange={(event) => setReply(event.target.value)}
                    />
                    <button
                        className="primary"
                        disabled={reply.trim() === ""}
                        onClick={() => void act("reply", reply.trim())}
                    >
                        reply
                    </button>
                    <button onClick={() => void act("resolve")}>resolve</button>
                </div>
            )}
            {error !== null && <p className="needs-human">{error}</p>}
        </li>
    );
}

/** The Threads tab's section: every preview comment, open ones first. */
export function CommentsSection({ dir, revision }: { dir: string; revision: number }) {
    const loaded = useLoaded(`${dir}#${revision}`, (signal) => fetchComments(dir, signal));
    const comments = loaded.value?.comments ?? [];
    const open = comments.filter((comment) => comment.state !== "resolved");
    const resolved = comments.filter((comment) => comment.state === "resolved");
    return (
        <section className="pr-threads" aria-label="Preview comments">
            <h3>Preview comments</h3>
            {loaded.error !== null && <p className="needs-human">{loaded.error}</p>}
            <ul className="thread-list">
                {[...open, ...resolved].map((comment) => (
                    <CommentThread key={comment.id} dir={dir} comment={comment} />
                ))}
                {comments.length === 0 && (
                    <li className="muted">
                        No preview comments. Use the comment button in a preview&apos;s bar.
                    </li>
                )}
            </ul>
        </section>
    );
}

/** The open comments on one preview, as chips over the bar; a chip opens its thread. */
export function CommentStrip(props: { dir: string; service: string; comments: Comment[] }) {
    const { dir, service, comments } = props;
    const [shown, setShown] = useState<string | null>(null);
    const open = openCommentsOn(comments, service);
    if (open.length === 0) {
        return null;
    }
    const thread = open.find((comment) => comment.id === shown);
    return (
        <div className="comment-strip" aria-label="Open comments">
            <div className="comment-chips">
                {open.map((comment) => (
                    <button
                        key={comment.id}
                        className={comment.id === shown ? "comment-chip chip-on" : "comment-chip"}
                        title={comment.messages[0]?.text}
                        onClick={() => setShown(comment.id === shown ? null : comment.id)}
                    >
                        {comment.id} · {waitingLabel(comment)}
                    </button>
                ))}
            </div>
            {thread !== undefined && (
                <ul className="thread-list">
                    <CommentThread dir={dir} comment={thread} />
                </ul>
            )}
        </div>
    );
}
