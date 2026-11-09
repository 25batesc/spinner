import { useState } from "react";

import type { PrThreadsView, ThreadView } from "@spinner/protocol";

import {
    fetchThreads,
    refreshThreads,
    threadAction,
    useLoaded,
    type ThreadVerb,
} from "./remote.ts";
import { CommentsSection } from "./CommentThreads.tsx";
import type { RunAction } from "./SessionsPane.tsx";

export interface ThreadsPanelProps {
    dir: string;
    /** Moves when the daemon sends `threads.updated` for this session. */
    revision: number;
    busy: boolean;
    run: RunAction;
    /** False hides `fix`: a review session (s015) has no pipeline but `review`. */
    fixable?: boolean;
    /** The preview comments' revision (s054); the section shows only when it is given. */
    commentsRevision?: number | undefined;
}

/** `05:08` in the operator's time zone; the full timestamp stays in the tooltip. */
function clockOf(timestamp: string): string {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
        return timestamp;
    }
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Thread({ pr, thread, dir }: { pr: PrThreadsView; thread: ThreadView; dir: string }) {
    const [error, setError] = useState<string | null>(null);
    const [reply, setReply] = useState("");
    const act = (verb: ThreadVerb, body: Record<string, string>) =>
        threadAction(dir, verb, thread.id, pr.repo, body).then(
            () => setError(null),
            (failure: unknown) => setError(String(failure)),
        );
    const line = thread.line === null ? "" : `:${thread.line}`;
    const location = thread.path === null ? "" : `${thread.path}${line}`;
    return (
        <li className={`thread thread-${thread.state}`} data-thread={thread.label}>
            <div className="thread-head">
                <strong>{thread.label}</strong>
                <span className={thread.state === "open" ? "badge pill-accent" : "badge"}>
                    {thread.state}
                </span>
                <span className="badge">{thread.author_kind}</span>
                {thread.outdated && <span className="badge">outdated</span>}
                {thread.flagged !== null && <span className="badge flagged">flagged</span>}
                <span className="muted">{thread.author}</span>
                <code className="thread-location">{location}</code>
            </div>
            <p className="thread-body">{thread.body}</p>
            {thread.flagged !== null && <p className="needs-human">Flag: {thread.flagged}</p>}
            {thread.replies.map((comment) => (
                <p key={comment.id} className="thread-reply">
                    <span className="muted">{comment.author}:</span> {comment.body}
                </p>
            ))}
            {thread.state === "open" && (
                <div className="thread-actions">
                    <input
                        aria-label={`Reply to ${thread.label}`}
                        value={reply}
                        placeholder="reply as you"
                        onChange={(event) => setReply(event.target.value)}
                    />
                    <button
                        className="primary"
                        disabled={reply.trim() === ""}
                        onClick={() =>
                            void act("reply", { text: reply.trim() }).then(() => setReply(""))
                        }
                    >
                        reply
                    </button>
                    <button disabled={!thread.replied} onClick={() => void act("resolve", {})}>
                        resolve
                    </button>
                    {thread.flagged === null && (
                        <button
                            onClick={() => void act("flag", { reason: "Flagged by the operator" })}
                        >
                            flag
                        </button>
                    )}
                </div>
            )}
            {error !== null && <p className="needs-human">{error}</p>}
        </li>
    );
}

interface PrProps {
    pr: PrThreadsView;
    dir: string;
    busy: boolean;
    run: RunAction;
    fixable: boolean;
}

function Pr({ pr, dir, busy, run, fixable }: PrProps) {
    return (
        <section className="pr-threads" data-pr={`${pr.repo}#${pr.number}`}>
            <h3>
                <a href={pr.url} target="_blank" rel="noreferrer">{pr.repo}#{pr.number}</a>{" "}
                <span className="muted">
                    {pr.checks} · {pr.review} · head {pr.head.slice(0, 7)}
                </span>
            </h3>
            <p className="muted">
                {pr.open_bot} bot open · {pr.open_human} human open · {pr.resolved} resolved ·{" "}
                {pr.flagged} flagged
            </p>
            {fixable && (
                <button
                    disabled={busy}
                    onClick={() => void run(`/sessions/${dir}/fix`, { pr: pr.repo })}
                >
                    fix
                </button>
            )}
            <ul className="thread-list">
                {pr.threads.map((thread) => (
                    <Thread key={thread.id} pr={pr} thread={thread} dir={dir} />
                ))}
                {pr.threads.length === 0 && <li className="muted">No threads.</li>}
            </ul>
        </section>
    );
}

/** One block per PR with every thread's state, author kind, location, body and flag. */
export function ThreadsPanel(props: ThreadsPanelProps) {
    const { dir, revision, busy, run, fixable = true, commentsRevision } = props;
    const loaded = useLoaded(`${dir}#${revision}`, (signal) => fetchThreads(dir, signal));
    const [error, setError] = useState<string | null>(null);
    const view = loaded.value;
    const shownError = error ?? loaded.error;
    return (
        <div className="threads" aria-label="Threads">
            <div className="thread-toolbar">
                <button
                    onClick={() =>
                        void refreshThreads(dir).then(
                            () => setError(null),
                            (failure: unknown) => setError(String(failure)),
                        )
                    }
                >
                    refresh from GitHub
                </button>
                <span className="muted" title={view?.rendered ?? undefined}>
                    {view?.rendered == null
                        ? "not rendered yet"
                        : `rendered ${clockOf(view.rendered)}`}
                </span>
            </div>
            {shownError !== null && <p className="needs-human">{shownError}</p>}
            {view?.prs.map((pr) => (
                <Pr
                    key={`${pr.repo}#${pr.number}`}
                    pr={pr}
                    dir={dir}
                    busy={busy}
                    run={run}
                    fixable={fixable}
                />
            ))}
            {view !== undefined && view.prs.length === 0 && (
                <p className="muted">No PRs with threads.</p>
            )}
            {commentsRevision !== undefined && (
                <CommentsSection dir={dir} revision={commentsRevision} />
            )}
        </div>
    );
}
