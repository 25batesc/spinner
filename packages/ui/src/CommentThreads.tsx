// Comment threads (s054): one thread with its place, its screenshot or its quoted passage,
// its messages and the operator's reply and resolve; and the strip of open comments above a
// preview. The Files view lists the threads on a file and every thread of the session. The
// daemon moves the state; every view reloads on `comment.updated` through the `comments`
// revision.
import { useState } from "react";

import { comment_where, type Comment } from "@spinner/protocol";

import { attachmentUrl, openCommentsOn, waitingLabel } from "./preview-comment.ts";
import { commentAction } from "./remote.ts";

export interface CommentThreadProps {
    dir: string;
    comment: Comment;
    /** Shows the place the comment is on: its passage in the open file, or its file. */
    onShow?: (() => void) | undefined;
    /** The place in fewer words, where the file is already on screen; else `comment_where`. */
    place?: string | undefined;
}

export function CommentThread({ dir, comment, onShow, place }: CommentThreadProps) {
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
                {onShow === undefined ? (
                    <code className="thread-location">{place ?? comment_where(anchor)}</code>
                ) : (
                    <button
                        type="button"
                        className="link thread-location"
                        title="Show where this comment is"
                        onClick={onShow}
                    >
                        {place ?? comment_where(anchor)}
                    </button>
                )}
            </div>
            {anchor.kind === "doc" && anchor.quote !== "" && (
                <blockquote className="comment-quote">{anchor.quote}</blockquote>
            )}
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
