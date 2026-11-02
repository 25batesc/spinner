// The diff tab (MISSION.md s012/s014, Contracts): one `diffview` process per repo of a
// session, run in that repo's worktree as a Spinner-managed host process. The viewer is an
// optional dependency of the daemon; when its binary is absent, `SessionView.diff.available`
// is false and the tab does not appear. The operator's comments reach the session's tty
// agents as `notify` commands, and the agents answer with the `diff_comments` and
// `diff_reply` tools, which the daemon runs as `diffview comments ...` in the agent's worktree.

/** The pinned dependency the daemon declares under `optionalDependencies`. */
export const DIFF_VIEWER_DEPENDENCY = "github:adamsanghera/diff-viewer#0707cd677fd6";

/** The Spinner home subdirectory that is `DIFFVIEW_HOME`: the comment store and the registry. */
export const DIFF_HOME_DIR = "diffview";

/** The viewer's log, relative to the session directory. `<repo>` is the repo key. */
export function diff_log_path(repo: string): string {
    return `diff/${repo}.log`;
}

/**
 * The daemon waits this long for a started viewer to answer `GET /` before it marks the
 * repo `failed`. The first start also bundles the renderer, which takes about a second.
 */
export const DIFF_START_TIMEOUT_MS = 20_000;

/** Time one `diff_comments` or `diff_reply` call gets before the daemon kills the CLI. */
export const DIFF_TOOL_TIMEOUT_MS = 30_000;

/** The most `notify` commands the watcher sends per second per session; the rest wait. */
export const DIFF_NOTICES_PER_SECOND_MAX = 2;

/** How much of a comment's text a notice carries. */
export const DIFF_NOTICE_TEXT_CHARS = 200;

/**
 * A viewer's state. `stopped` is the rest state: no process, `url` null. `starting` is
 * between spawn and the first answer on `GET /`. `failed` keeps `error` from the exit or
 * the timeout; `start` clears it.
 */
export type DiffViewerState = "starting" | "running" | "stopped" | "failed";

/** How many threads wait on each side, from the last `diffview comments list --json`. */
export interface DiffWaiting {
    agent: number;
    human: number;
}

/** One repo's viewer, under `SessionView.diff.repos[repo]`. */
export interface DiffRepoView {
    state: DiffViewerState;
    /**
     * `http://127.0.0.1:<port>/`, or null when not running. The viewer refuses every other
     * Host, so the UI embeds this URL directly; it never goes through the Spinner proxy.
     */
    url: string | null;
    /** The viewer's pid while it runs, else null. */
    pid: number | null;
    /** Why the last start failed, else null. */
    error: string | null;
    waiting: DiffWaiting;
}

/** `SessionView.diff`. */
export interface DiffView {
    /** False when the daemon found no `diffview` binary; then `repos` is empty. */
    available: boolean;
    /** One entry per repo of `session.yaml`, in `repos` order, running or not. */
    repos: Record<string, DiffRepoView>;
}

/** Body of `POST /sessions/:dir/diff/start` and `.../diff/stop`. */
export interface DiffRepoRequest {
    /** The repo key; every repo of the session when absent. */
    repo?: string;
}

/** The `diffview comments` verbs the tools run. The two tools split them by who may act. */
export type DiffCommentsCommand = "list" | "show" | "reply" | "suggest-resolve";

/** Body of `POST /sessions/:dir/agents/:name/diff/comments`. */
export interface DiffCommentsRequest {
    command: DiffCommentsCommand;
    /** Thread ids. `show` takes one or more; `reply` and `suggest-resolve` take one. */
    threads?: number[];
    /** The message of `reply` and `suggest-resolve`. */
    text?: string;
}

/** The CLI's exit: 0 done, 1 refused, 2 malformed, 3 timed out, 124 killed by the daemon. */
export interface DiffCommentsResponse {
    code: number;
    stdout: string;
    stderr: string;
}

/** What the watcher learns about one thread from `diffview comments wait --json`. */
export interface DiffNotice {
    repo: string;
    thread: number;
    /** `open` or `suggested` (the agent suggested resolving; the human has not answered). */
    status: "open" | "suggested";
    /** The file, or null for a thread on the whole branch or on a description. */
    path: string | null;
    start_line: number | null;
    end_line: number | null;
    /** The author of the newest message. */
    author: string;
    /** The newest message's text, as written. */
    text: string;
}

/** `<repo> <path>:<start>[-<end>]`, `<repo> <path> (whole file)` or `<repo> (whole branch)`. */
export type DiffPlace = Pick<DiffNotice, "repo" | "thread" | "path" | "start_line" | "end_line">;

export function diff_notice_where(notice: Omit<DiffPlace, "thread">): string {
    if (notice.path === null) {
        return `${notice.repo} (whole branch)`;
    }
    if (notice.start_line === null) {
        return `${notice.repo} ${notice.path} (whole file)`;
    }
    const ranged = notice.end_line !== null && notice.end_line !== notice.start_line;
    const end = ranged ? `-${notice.end_line}` : "";
    return `${notice.repo} ${notice.path}:${notice.start_line}${end}`;
}

/**
 * The text of the `notify` command a new comment waiting on the agent sends. One line of
 * location, one of text, one of what to do. The text is cut at `DIFF_NOTICE_TEXT_CHARS`.
 */
export function diff_notice_text(notice: DiffNotice): string {
    const flat = notice.text.replace(/\s+/g, " ").trim();
    const long = flat.length > DIFF_NOTICE_TEXT_CHARS;
    const cut = long ? `${flat.slice(0, DIFF_NOTICE_TEXT_CHARS - 1)}…` : flat;
    return (
        `diff comment #${notice.thread} on ${diff_notice_where(notice)} waits on you.\n` +
        `${notice.author}: ${cut}\n` +
        `Read it with diff_comments show ${notice.thread}; answer with diff_reply.`
    );
}

/** The `needs_human` line while `count` threads wait on the operator; `first` is the oldest. */
export function diff_needs_human(count: number, first: DiffPlace): string {
    const more = count > 1 ? ` and ${count - 1} more` : "";
    return `answer diff comment #${first.thread} on ${diff_notice_where(first)}${more}`;
}
