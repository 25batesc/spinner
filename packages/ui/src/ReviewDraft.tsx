// The lead's two blocks above the threads of a review session (s016): the briefing, markdown
// from `artifacts/briefing.md` through the briefing route with the mission's renderer, and
// the draft: the event as a pill, the summary body, one row per line comment, then `post`
// and `drop`. An edit saves on blur through the draft route; `post` asks once in place, then
// the posted URL takes the block's place. Nothing here applies a result itself:
// `review.updated` moves the facts (the contract of 14:07).
import { useState } from "react";

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
function EventPill(props: { event: ReviewEvent; onChange: (event: ReviewEvent) => void }) {
    const { event, onChange } = props;
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
    onChange: (index: number, body: string) => void;
    onBlur: () => void;
}) {
    const { comment, index, onChange, onBlur } = props;
    return (
        <li className="rv-comment" data-path={comment.path} data-line={comment.line}>
            <code className="rv-comment-at">{comment.path}:{comment.line}</code>
            <textarea
                className="rv-comment-body"
                aria-label={`Comment on ${comment.path} line ${comment.line}`}
                value={comment.body}
                rows={Math.max(2, comment.body.split("\n").length)}
                onChange={(event) => onChange(index, event.target.value)}
                onBlur={onBlur}
            />
        </li>
    );
}

export interface ReviewDraftProps {
    dir: string;
    draft: ReviewDraft;
}

const same = (a: ReviewDraft, b: ReviewDraft) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The draft block. The fields hold the operator's text in `edited`; a blur saves it through
 * the route when it differs from the last save. The `review.updated` that follows echoes the
 * save and is ignored; a draft that differs from the last save (the lead wrote a new one)
 * replaces the fields. The block's own state (`asking`, an error) survives either way.
 */
export function ReviewDraftBlock({ dir, draft }: ReviewDraftProps) {
    const [asking, setAsking] = useState(false);
    const [pending, setPending] = useState<"post" | "drop" | "save" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [posted, setPosted] = useState<{ url: string; fell_back: boolean } | null>(null);
    const [edited, setEdited] = useState<ReviewDraft>(draft);
    const [saved, setSaved] = useState<ReviewDraft>(draft);
    // A new draft from the daemon, not the echo of a save: the fields take it.
    const [seen, setSeen] = useState<ReviewDraft>(draft);
    if (draft !== seen) {
        setSeen(draft);
        if (!same(draft, saved)) {
            setEdited(draft);
            setSaved(draft);
        }
    }

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
        if (same(next, saved)) {
            return;
        }
        setSaved(next);
        run("save", async () => {
            await putReviewDraft(dir, next);
        });
    };
    const onEvent = (event: ReviewEvent) => {
        const next = { ...edited, event };
        setEdited(next);
        save(next);
    };
    const onComment = (index: number, body: string) => {
        const comments = edited.comments.map((c, i) => (i === index ? { ...c, body } : c));
        setEdited({ ...edited, comments });
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
                <EventPill event={edited.event} onChange={onEvent} />
                {pending === "save" && <span className="muted rv-saving">saving…</span>}
            </div>
            <textarea
                className="rv-draft-body"
                aria-label="Review summary"
                value={edited.body}
                rows={Math.max(4, edited.body.split("\n").length)}
                onChange={(event) => setEdited({ ...edited, body: event.target.value })}
                onBlur={() => save(edited)}
            />
            {edited.comments.length > 0 && (
                <ul className="rv-comments" aria-label="Line comments">
                    {edited.comments.map((comment, index) => (
                        <CommentRow
                            key={`${comment.path}:${comment.line}:${index}`}
                            comment={comment}
                            index={index}
                            onChange={onComment}
                            onBlur={() => save(edited)}
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
