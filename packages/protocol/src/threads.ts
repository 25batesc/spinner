// Types for review threads: what the daemon renders into `threads/<repo>-<pr>.md`, what
// `GET /sessions/:dir/threads` returns, and what the fixer's `thread_*` tools act on. The
// shape follows docs/SESSION_PROTOCOL.md, section "Threads". A thread's `id` is the GitHub
// GraphQL node id, which the reply and resolve mutations take; its `label` (`T1`, `T2`) is
// the short name the rendered file and the Log use. `flagged` is Spinner-local state: GitHub
// has no flag, so the daemon keeps it beside the rendered file and the UI shows it.

import type { CheckState, ReviewDecision } from "./session.js";

export type ThreadState = "open" | "resolved";

/** Who opened the thread: a login in `github.bot_logins` is a bot, anyone else a human. */
export type ThreadAuthorKind = "bot" | "human";

/** One comment of a thread. The first comment is the thread's `body`; the rest are replies. */
export interface ThreadComment {
    /** GraphQL node id of the comment. */
    id: string;
    author: string;
    body: string;
    /** ISO 8601. */
    created: string;
}

export interface ThreadView {
    /** GraphQL node id of the review thread (`PRRT_...`), for reply and resolve. */
    id: string;
    /** `T<n>`, numbered in GitHub order within the PR, stable across renders. */
    label: string;
    state: ThreadState;
    /** True when the code the thread points at changed since; GitHub's `isOutdated`. */
    outdated: boolean;
    /** Login of the first comment's author. */
    author: string;
    author_kind: ThreadAuthorKind;
    /** File the thread is on; null for a thread without a location. */
    path: string | null;
    /** Line in the file; null when GitHub reports none (outdated or file-level thread). */
    line: number | null;
    /** The first comment's text. */
    body: string;
    /** Comments after the first, oldest first. */
    replies: ThreadComment[];
    /** True once the operator's login (or the fixer acting as it) replied in the thread. */
    replied: boolean;
    /** The reason the fixer gave `thread_flag`, or null when the thread is not flagged. */
    flagged: string | null;
}

/** The threads of one PR, with the facts the file header shows. */
export interface PrThreadsView {
    repo: string;
    number: number;
    url: string;
    head: string;
    checks: CheckState;
    review: ReviewDecision;
    /** Open threads by author kind, and resolved ones, as `session.yaml` counts them. */
    open_bot: number;
    open_human: number;
    resolved: number;
    /** Open threads the fixer flagged for the operator. */
    flagged: number;
    /** Every thread, open first, then resolved, each in GitHub order. */
    threads: ThreadView[];
    /** The rendered file, relative to the session directory: `threads/<repo>-<n>.md`. */
    file: string;
}

/** `GET /sessions/:dir/threads`: every PR of the session that has a thread file. */
export interface ThreadsView {
    /** Session directory name. */
    session: string;
    /** One entry per PR, in `session.yaml` repo order. */
    prs: PrThreadsView[];
    /** ISO 8601 time of the last render from GitHub, or null before the first one. */
    rendered: string | null;
}

/** Upper bound on threads per PR the daemon renders; the GraphQL query fetches 100. */
export const THREADS_PER_PR_MAX = 100;
