// The lead's two blocks above the threads of a review session (s016): the briefing, markdown
// from `artifacts/briefing.md` through the briefing route with the mission's renderer, and
// the draft: the event as a pill, the summary body, one row per line comment, then `post`
// and `drop`. An edit saves on blur through the draft route; `post` asks once in place, then
// the posted URL takes the block's place. Nothing here applies a result itself:
// `review.updated` moves the facts (the contract of 14:07).
import { useState, type FocusEvent } from "react";

import type { ReviewDraft, ReviewDraftComment, ReviewEvent } from "@spinner/protocol";

import { Markdown } from "./Markdown.tsx";
import { deleteReviewDraft, fetchReviewBriefing, postReview, putReviewDraft, useLoaded } from
    "./remote.ts";

/** Where the lead writes the briefing, under the session directory: the toggle's label. */
export const BRIEFING_FILE = "artifacts/briefing.md";

export function ReviewBriefing({ dir }: { dir: string }) {
    const loaded = useLoaded(`${dir}#briefing`, (signal) => fetchReviewBriefing(dir, signal));
    return (
        <section className="rv-briefing" aria-label="Briefing">
            <h3 className="rv-block-title">Briefing</h3>
            {loaded.error !== null && <p className="needs-human">{loaded.error}</p>}
            {loaded.value === undefined && loaded.error === null && (
                <p className="muted">Loading the briefing…</p>
            )}
            {loaded.value !== undefined && (
                <Markdown text={loaded.value} label={BRIEFING_FILE} />
            )}
        </section>
    );
}

/** The event pill; a click swaps `APPROVE` and `COMMENT`, which saves at once. */
function EventPill({ event, onChange }: { event: ReviewEvent; onChange: (e: ReviewEvent) => void }) {
    const other: ReviewEvent = event === "APPROVE" ? "COMMENT" : "APPROVE";
    const tone = event === "APPROVE" ? "pill-ok" : "pill-accent";
    return (
        <button
            type="button"
            className={`pill rv-event ${tone}`}
            title={`The review event. Click to change it to ${other}.`}
            data-event={event}
            onClick={() => onChange(other)}
        >
            {event}
        </button>
    );
}

/** One line comment: `path:line` and the editable body. */
function CommentRow(props: {
    comment: ReviewDraftComment;
    index: number;
    onBlur: (index: number, body: string) => void;
}) {
    const { comment, index, onBlur } = props;
    const blur = (event: FocusEvent<HTMLTextAreaElement>) => onBlur(index, event.target.value);
    return (
        <li className="rv-comment" data-path={comment.path} data-line={comment.line}>
            <code className="rv-comment-at">{comment.path}:{comment.line}</code>
            <textarea
                className="rv-comment-body"
                aria-label={`Comment on ${comment.path} line ${comment.line}`}
                defaultValue={comment.body}
                rows={Math.max(2, comment.body.split("\n").length)}
                onBlur={blur}
            />
        </li>
    );
}

export interface ReviewDraftProps {
    dir: string;
    draft: ReviewDraft;
}

/**
 * The draft block. The textareas are uncontrolled: the draft from the facts seeds them, a
 * blur saves the changed text through the route, and the `review.updated` that follows is
 * what the next render reads. The `key` on the block in `ReviewPane` remounts it when the
 * daemon's draft changes under the operator.
 */
export function ReviewDraftBlock({ dir, draft }: ReviewDraftProps) {
    const [asking, setAsking] = useState(false);
    const [pending, setPending] = useState<"post" | "drop" | "save" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [posted, setPosted] = useState<{ url: string; fell_back: boolean } | null>(null);
    // The latest text per field, so a save after an edit of another field keeps both.
    const [edited, setEdited] = useState<ReviewDraft>(draft);

    const run = (what: "post" | "drop" | "save", action: () => Promise<void>) => {
        setPending(what);
        setError(null);
        action().then(
            () => setPending(null),
            (failure: unknown) => {
                setPending(null);
                setError(String(failure));
            },
        );
    };
    const save = (next: ReviewDraft) => {
        setEdited(next);
        run("save", async () => {
            await putReviewDraft(dir, next);
        });
    };
    const onBody = (event: FocusEvent<HTMLTextAreaElement>) => {
        const body = event.target.value;
        if (body !== edited.body) {
            save({ ...edited, body });
        }
    };
    const onComment = (index: number, body: string) => {
        const current = edited.comments[index];
        if (current === undefined || current.body === body) {
            return;
        }
        const comments = edited.comments.map((c, i) => (i === index ? { ...c, body } : c));
        save({ ...edited, comments });
    };
    const onPost = () => run("post", async () => {
        const result = await postReview(dir);
        setAsking(false);
        setPosted({ url: result.url, fell_back: result.fell_back });
    });
    const onDrop = () => run("drop", () => deleteReviewDraft(dir));

    if (posted !== null) {
        return <ReviewPosted url={posted.url} fellBack={posted.fell_back} />;
    }
    const busy = pending !== null;
    return (
        <section className="rv-draft" aria-label="Review draft">
            <div className="rv-draft-head">
                <h3 className="rv-block-title">Draft</h3>
                <EventPill event={edited.event} onChange={(event) => save({ ...edited, event })} />
                {pending === "save" && <span className="muted rv-saving">saving…</span>}
            </div>
            <textarea
                className="rv-draft-body"
                aria-label="Review summary"
                defaultValue={draft.body}
                rows={Math.max(4, draft.body.split("\n").length)}
                onBlur={onBody}
            />
            {edited.comments.length > 0 && (
                <ul className="rv-comments" aria-label="Line comments">
                    {edited.comments.map((comment, index) => (
                        <CommentRow
                            key={`${comment.path}:${comment.line}:${index}`}
                            comment={comment}
                            index={index}
                            onBlur={onComment}
                        />
                    ))}
                </ul>
            )}
            {error !== null && <p className="needs-human rv-draft-error">{error}</p>}
            <div className="rv-draft-actions">
                {asking ? (
                    <span className="rv-confirm" role="group" aria-label="Confirm post">
                        <span>Post this review as you?</span>
                        <button type="button" className="primary" disabled={busy} onClick={onPost}>
                            {pending === "post" ? "posting…" : "post"}
                        </button>
                        <button type="button" disabled={busy} onClick={() => setAsking(false)}>
                            cancel
                        </button>
                    </span>
                ) : (
                    <button
                        type="button"
                        className="primary"
                        disabled={busy}
                        onClick={() => setAsking(true)}
                    >
                        post
                    </button>
                )}
                <button type="button" className="danger" disabled={busy} onClick={onDrop}>
                    {pending === "drop" ? "dropping…" : "drop"}
                </button>
            </div>
        </section>
    );
}

/**
 * After `post`: the review's URL in the draft's place. `fellBack` is known right after the
 * post only (the route's answer); a later render from the facts shows the URL alone.
 */
export function ReviewPosted({ url, fellBack = false }: { url: string; fellBack?: boolean }) {
    return (
        <section className="rv-posted" aria-label="Posted review">
            <h3 className="rv-block-title">Posted</h3>
            <a className="rv-posted-url" href={url} target="_blank" rel="noreferrer">{url}</a>
            {fellBack && (
                <p className="muted rv-fell-back">
                    GitHub refused APPROVE on your own PR; the review was posted as COMMENT.
                </p>
            )}
        </section>
    );
}
