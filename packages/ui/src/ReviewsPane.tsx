// The Reviews panel (s015): a section of the sidebar (s020) for the operator's peers' PRs. The
// paste box pinned at the top takes PR links in any form; `Start review` posts them and the
// daemon makes one review session per PR. Below it, one card per review, the latest activity
// first, with the review's pills (s018: the state and the draft's count among them).
import { useState, type FormEvent } from "react";

import { ReviewPills } from "./PaneHead.tsx";
import { swarmLine, type ReviewFacts } from "./review.ts";
import { useExtraction, type RunAction } from "./SessionForms.tsx";
import { AddNew } from "./Sidebar.tsx";

export interface ReviewsPaneProps {
    reviews: ReviewFacts[];
    selected: string | undefined;
    onSelect: (dir: string) => void;
    run: RunAction;
    /** True while a job runs on the selected review; its `review` button waits. */
    busy: boolean;
}

/**
 * The paste box: PR references in any form, no project. The PRs the daemon finds show under
 * the box while the operator types; the daemon reads the text again when `Start review` posts
 * it, so the list is a preview, not the request.
 */
function ReviewComposeBox({ run, onStarted }: { run: RunAction; onStarted: () => void }) {
    const [text, setText] = useState("");
    const [extraction] = useExtraction(text, "");
    const found = extraction.prs.filter((pr) => pr.url !== null);
    const refused = extraction.prs.filter((pr) => pr.url === null);
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (text.trim() === "") {
            return;
        }
        void run("/reviews", { text }).then(() => {
            setText("");
            onStarted();
        });
    };
    return (
        <form className="rv-compose" onSubmit={submit} aria-label="New review">
            <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Paste PR links to review."
                aria-label="Pull requests to review"
                rows={3}
            />
            {found.length > 0 && (
                <ul className="rv-found" aria-label="Pull requests found">
                    {found.map((pr) => (
                        <li key={pr.url} className="rv-found-pr">
                            <code>{pr.repo}#{pr.number}</code>
                            {pr.title !== null && <span className="muted">{pr.title}</span>}
                        </li>
                    ))}
                </ul>
            )}
            {refused.map((pr) => (
                <p key={pr.ref} className="needs-human rv-found-reason">
                    {pr.ref}: {pr.reason ?? "not a PR"}
                </p>
            ))}
            {extraction.pending && <p className="muted rv-extracting">Looking for PRs…</p>}
            {extraction.error !== null && <p className="needs-human">{extraction.error}</p>}
            <div className="rv-compose-actions">
                <button type="submit" className="primary" disabled={text.trim() === ""}>
                    Start review
                </button>
            </div>
        </form>
    );
}

/** One review: the facts, the pills, and `review` and `open on GitHub`. */
function ReviewCard(props: {
    facts: ReviewFacts;
    selected: boolean;
    busy: boolean;
    onSelect: (dir: string) => void;
    run: RunAction;
}) {
    const { facts, selected, busy, onSelect, run } = props;
    const classes = ["rv-card", selected ? "rv-card-selected" : ""].join(" ").trim();
    return (
        <li className={classes} data-dir={facts.dir}>
            <button
                type="button"
                className="rv-card-body"
                onClick={() => onSelect(facts.dir)}
                title={`${facts.dir}\n${swarmLine(facts.swarm)}`}
            >
                <strong className="rv-title">{facts.title}</strong>
                <span className="muted rv-meta">
                    <span className="rv-author">{facts.author}</span>
                    <code className="rv-branches">
                        {facts.branch} → {facts.base}
                    </code>
                </span>
                <ReviewPills facts={facts} />
            </button>
            <span className="rv-card-actions">
                <button
                    type="button"
                    disabled={busy && selected}
                    title="Start the review swarm: one reviewer per model"
                    onClick={() => void run(`/sessions/${facts.dir}/review`)}
                >
                    review
                </button>
                {facts.url !== null && (
                    <a
                        className="rv-github"
                        href={facts.url}
                        target="_blank"
                        rel="noreferrer"
                        title={facts.url}
                    >
                        open on GitHub
                    </a>
                )}
            </span>
        </li>
    );
}

export function ReviewsPane(props: ReviewsPaneProps) {
    const { reviews, selected, onSelect, run, busy } = props;
    return (
        <section className="pane reviews-pane" aria-label="Reviews">
            <div className="side-compose">
                <AddNew label="New review">
                    {(close) => <ReviewComposeBox run={run} onStarted={close} />}
                </AddNew>
            </div>
            <ul className="rv-list">
                {reviews.map((facts) => (
                    <ReviewCard
                        key={facts.dir}
                        facts={facts}
                        selected={facts.dir === selected}
                        busy={busy}
                        onSelect={onSelect}
                        run={run}
                    />
                ))}
                {reviews.length === 0 && (
                    <li className="muted">No reviews yet. Paste a PR link above.</li>
                )}
            </ul>
        </section>
    );
}
