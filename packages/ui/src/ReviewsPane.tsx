// The Reviews panel (s015): a section of the sidebar (s020) for the operator's peers' PRs. The
// `+ New review` button pinned at the top opens the review composer in the working area
// (s038), where `Start review` posts the PR links and the daemon makes one review session per
// PR. Below it, one card per review, the latest activity first, with the review's pills (s018:
// the state and the draft's count among them).
import { useState } from "react";

import { ArchiveButton, ArchiveConfirm } from "./CardArchive.tsx";
import { ReviewPills } from "./PaneHead.tsx";
import { ReviewActions } from "./ReviewPane.tsx";
import { swarmLine, type ReviewFacts } from "./review.ts";
import type { RunAction } from "./SessionForms.tsx";
import { NewButton } from "./Sidebar.tsx";

export interface ReviewsPaneProps {
    reviews: ReviewFacts[];
    selected: string | undefined;
    onSelect: (dir: string) => void;
    run: RunAction;
    /** True while a job runs on the selected review; its `review` button waits. */
    busy: boolean;
    /** The confirmed `archive` of a card: the caller runs `close` and moves the selection. */
    onArchive: (dir: string) => void;
    /** The pinned `+ New review` button opens the review composer in the working area. */
    onNew: () => void;
    /** True while the review composer shows; the button reads as pressed. */
    composing: boolean;
}

/**
 * One review: the facts, the pills, `review`, `approve`, `cancel review` while it runs, `open
 * on GitHub`, and `archive` on hover.
 */
function ReviewCard(props: {
    facts: ReviewFacts;
    selected: boolean;
    busy: boolean;
    onSelect: (dir: string) => void;
    onArchive: (dir: string) => void;
    run: RunAction;
}) {
    const { facts, selected, busy, onSelect, run } = props;
    const [asking, setAsking] = useState(false);
    const classes = ["rv-card", selected ? "rv-card-selected" : ""].join(" ").trim();
    if (asking) {
        return (
            <li className={classes} data-dir={facts.dir}>
                <ArchiveConfirm
                    onArchive={() => {
                        setAsking(false);
                        props.onArchive(facts.dir);
                    }}
                    onCancel={() => setAsking(false)}
                />
            </li>
        );
    }
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
                <ReviewActions facts={facts} />
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
            <ArchiveButton onClick={() => setAsking(true)} />
        </li>
    );
}

export function ReviewsPane(props: ReviewsPaneProps) {
    const { reviews, selected, onSelect, run, busy } = props;
    return (
        <section className="pane reviews-pane" aria-label="Reviews">
            <div className="side-compose">
                <NewButton label="New review" active={props.composing} onClick={props.onNew} />
            </div>
            <ul className="rv-list">
                {reviews.map((facts) => (
                    <ReviewCard
                        key={facts.dir}
                        facts={facts}
                        selected={facts.dir === selected}
                        busy={busy}
                        onSelect={onSelect}
                        onArchive={props.onArchive}
                        run={run}
                    />
                ))}
                {reviews.length === 0 && (
                    <li className="muted">No reviews yet. Start one from + New review above.</li>
                )}
            </ul>
        </section>
    );
}
