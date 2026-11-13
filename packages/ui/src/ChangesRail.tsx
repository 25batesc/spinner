// The Changes rail (docs/designs/talk-change-ship.md, 2.9): one card per change of the
// session. A card shows the change's state in plain words, a line per pull request (checks,
// open threads, size), what it needs from the operator, and its actions. `merge` and `post`
// act on that change, checked out or not (`?change=<id>`); `create PR` acts on the current
// one. Finished changes fold under a count.
import { useState } from "react";

import type { ChangePr, ChangeView, SessionView } from "@spinner/protocol";

import {
    changeActions,
    changeCards,
    checksText,
    diffText,
    hasStack,
    stateTone,
    threadsText,
} from "./changes.ts";
import { PostDialog } from "./PipelineActions.tsx";
import type { RunAction } from "./SessionsPane.tsx";

export interface ChangesRailProps {
    view: SessionView;
    /** True while a job runs on the session; the actions wait. */
    busy: boolean;
    run: RunAction;
    /** Moves on pipeline events; the post dialog reads the daemon's preview again. */
    revision: number;
}

function PrLine({ pr }: { pr: ChangePr }) {
    const name = `${pr.repo} #${pr.number}`;
    const checks = checksText(pr);
    const threads = threadsText(pr);
    const size = diffText(pr);
    return (
        <li className="change-pr" data-state={pr.state}>
            {pr.url === null ? (
                <span className="change-pr-name">{name}</span>
            ) : (
                <a className="change-pr-name" href={pr.url} target="_blank" rel="noreferrer">
                    {name}
                </a>
            )}
            {pr.state !== "open" && <span className="muted">{pr.state}</span>}
            {checks !== "" && (
                <span className="change-checks" data-checks={pr.checks}>{checks}</span>
            )}
            {threads !== "" && <span className="change-threads">{threads}</span>}
            {size !== "" && <span className="muted change-size">{size}</span>}
        </li>
    );
}

interface CardProps {
    dir: string;
    /** True when the session has a stack: `test locally` is offered. */
    stack: boolean;
    change: ChangeView;
    busy: boolean;
    run: RunAction;
    onPost: (id: string) => void;
}

function ChangeCard({ dir, stack, change, busy, run, onPost }: CardProps) {
    // `merge` cannot be undone, so the first click arms it and the second sends it.
    const [armed, setArmed] = useState(false);
    const actions = changeActions(change, stack);
    const testTip = change.current
        ? "Start the stack on this change."
        : "Check out this change in the worktrees and restart the stack on it.";
    const query = `?change=${encodeURIComponent(change.id)}`;
    const merge = () => {
        setArmed(false);
        void run(`/sessions/${dir}/land${query}`);
    };
    const on = change.on === null ? "" : ` · on ${change.on}`;
    return (
        <li
            className="change-card"
            data-change={change.id}
            data-current={change.current}
            data-tone={stateTone(change.state)}
        >
            <header className="change-head">
                <span className="dot change-dot" aria-hidden="true" />
                <strong className="change-title">{change.title}</strong>
                {change.verified === true && (
                    <span className="badge change-tested" title="You verified it at this head">
                        tested
                    </span>
                )}
                {change.current && (
                    <span className="badge" title="Checked out in the session's worktrees">
                        current
                    </span>
                )}
            </header>
            <div className="muted change-meta" title={change.branch}>
                <span className="change-state">{change.state}</span> · {change.branch}{on}
            </div>
            {change.prs.length > 0 && (
                <ul className="change-prs">
                    {change.prs.map((pr) => <PrLine key={`${pr.repo}#${pr.number}`} pr={pr} />)}
                </ul>
            )}
            {change.needs_human !== null && (
                <div className="needs-human change-needs">{change.needs_human}</div>
            )}
            {(actions.create || actions.merge || actions.post || actions.test) && (
                <div className="change-actions">
                    {actions.test && (
                        <button
                            disabled={busy}
                            title={testTip}
                            onClick={() => void run(`/sessions/${dir}/up`, { change: change.id })}
                        >
                            test locally
                        </button>
                    )}
                    {actions.create && (
                        <button
                            disabled={busy}
                            title="Open a pull request from this change, one per changed repo."
                            onClick={() => void run(`/sessions/${dir}/pr`)}
                        >
                            create PR
                        </button>
                    )}
                    {actions.post && (
                        <button
                            disabled={busy}
                            title="Post the review request to Slack as you, after a preview."
                            onClick={() => onPost(change.id)}
                        >
                            post
                        </button>
                    )}
                    {actions.merge && !armed && (
                        <button
                            className="danger"
                            title="Merge (or enqueue) this change's pull requests."
                            onClick={() => setArmed(true)}
                        >
                            merge
                        </button>
                    )}
                    {actions.merge && armed && (
                        <>
                            <button className="danger" onClick={merge}>confirm merge</button>
                            <button onClick={() => setArmed(false)}>cancel</button>
                        </>
                    )}
                </div>
            )}
        </li>
    );
}

export function ChangesRail({ view, busy, run, revision }: ChangesRailProps) {
    const [posting, setPosting] = useState<string | null>(null);
    const [showFinished, setShowFinished] = useState(false);
    const dir = view.summary.dir;
    const cards = changeCards(view);
    const card = (change: ChangeView) => (
        <ChangeCard
            key={change.id}
            dir={dir}
            stack={hasStack(view)}
            change={change}
            busy={busy}
            run={run}
            onPost={setPosting}
        />
    );
    return (
        <div className="changes-rail" aria-label="Changes">
            {cards.open.length === 0 && cards.finished.length === 0 && (
                <p className="muted">No change yet. Tell the agent what to build.</p>
            )}
            <ul className="change-list">{cards.open.map(card)}</ul>
            {cards.finished.length > 0 && (
                <>
                    <button
                        className="link changes-finished-toggle"
                        aria-expanded={showFinished}
                        onClick={() => setShowFinished(!showFinished)}
                    >
                        {showFinished ? "▾" : "▸"} {cards.finished.length} finished
                    </button>
                    {showFinished && (
                        <ul className="change-list change-list-finished">
                            {cards.finished.map(card)}
                        </ul>
                    )}
                </>
            )}
            {posting !== null && (
                <PostDialog
                    dir={dir}
                    change={posting}
                    revision={revision}
                    run={run}
                    close={() => setPosting(null)}
                />
            )}
        </div>
    );
}
