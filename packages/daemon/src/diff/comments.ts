// Runs `diffview comments <verb> ...` for the daemon: in a repo's worktree, against the
// Spinner home's comment store, signed as the agent that asked. The watcher runs `wait` and
// `list --json` through it; the agent route runs `list`, `show`, `reply` and
// `suggest-resolve`. The parsing of `--json` output follows `lib/comments-cli.mjs` at the
// pinned commit: an array of listings, each with `threads`, each thread with `messages`.
import assert from "node:assert/strict";
import {
    DIFF_TOOL_TIMEOUT_MS,
    type DiffCommentsCommand,
    type DiffCommentsResponse,
    type DiffNotice,
    type DiffThreadRecord,
} from "@spinner/protocol";
import { run, type RunOptions, type RunResult } from "../stack/shell.js";

/** The command runner, injectable for tests. */
export type CommandRunner = (
    command: string,
    args: string[],
    options?: RunOptions,
) => Promise<RunResult>;

export interface CommentsInput {
    /** The viewer's executable. */
    bin: string;
    /** `DIFFVIEW_HOME`. */
    diff_home: string;
    /** Absolute worktree path: the CLI's scope is the branch checked out here. */
    worktree: string;
    /** `DIFFVIEW_AUTHOR`: the agent's name on its messages; `spinner` for the watcher. */
    author: string;
    /** `DIFFVIEW_SESSION`: the session directory, so messages carry where they came from. */
    session: string;
    timeout_ms?: number;
    runner?: CommandRunner;
}

/** Exit code the daemon reports when it killed the CLI at the bound. */
export const KILLED_CODE = 124;

/** Runs one `diffview comments` invocation and returns what the model (or the watcher) reads. */
export async function run_comments(
    input: CommentsInput,
    args: string[],
): Promise<DiffCommentsResponse> {
    assert.ok(args.length > 0, "a comments call names a verb");
    const runner = input.runner ?? run;
    const result = await runner(process.execPath, [input.bin, "comments", ...args], {
        cwd: input.worktree,
        env: {
            ...process.env,
            DIFFVIEW_HOME: input.diff_home,
            DIFFVIEW_AUTHOR: input.author,
            DIFFVIEW_SESSION: input.session,
        },
        timeout_ms: input.timeout_ms ?? DIFF_TOOL_TIMEOUT_MS,
    });
    return {
        code: result.code < 0 ? KILLED_CODE : result.code,
        stdout: String(result.stdout),
        stderr: result.stderr,
    };
}

/** The arguments of a tool call, as the route builds them from `DiffCommentsRequest`. */
export function comments_args(
    command: DiffCommentsCommand,
    threads: number[],
    text: string | undefined,
): string[] {
    switch (command) {
        case "list":
            return ["list"];
        case "show":
            assert.ok(threads.length > 0, "show takes at least one thread id");
            return ["show", ...threads.map(String)];
        case "reply":
        case "suggest-resolve":
            assert.ok(threads.length === 1, `${command} takes one thread id`);
            assert.ok(text !== undefined && text.trim().length > 0, `${command} needs a message`);
            return [command, String(threads[0]), "-m", text];
    }
}

/* The `--json` shapes, as much of them as the daemon reads. */

interface JsonMessage {
    id: number;
    author: string;
    body: string;
}

interface JsonThread {
    id: number;
    status: "open" | "suggested" | "resolved";
    waitingOn: "agent" | "human" | null;
    path: string | null;
    startLine: number | null;
    endLine: number | null;
    messages: JsonMessage[];
}

interface JsonListing {
    threads: JsonThread[];
}

/** The threads of a `list --json` or `wait --json` output, flattened. Throws on another shape. */
export function parse_threads(stdout: string): JsonThread[] {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) {
        // `wait --json` prints `{ "timedOut": true }` on exit 3; a caller checks the code first.
        throw new Error(`diffview comments --json did not print a list: ${stdout.slice(0, 200)}`);
    }
    const threads: JsonThread[] = [];
    for (const listing of parsed as JsonListing[]) {
        for (const thread of listing.threads ?? []) {
            assert.ok(typeof thread.id === "number", "a thread has a numeric id");
            threads.push(thread);
        }
    }
    return threads;
}

/** The unresolved threads of a listing, as `session.yaml` records them. */
export function thread_records(repo: string, threads: JsonThread[]): DiffThreadRecord[] {
    const records: DiffThreadRecord[] = [];
    for (const thread of threads) {
        if (thread.status === "resolved" || thread.waitingOn === null) {
            continue;
        }
        records.push({
            repo,
            thread: thread.id,
            waiting_on: thread.waitingOn,
            path: thread.path ?? null,
            start_line: thread.startLine ?? null,
            end_line: thread.endLine ?? null,
        });
    }
    return records;
}

/** The newest message id across threads, never below `floor`: the next `wait --after`. */
export function newest_message(threads: JsonThread[], floor: number): number {
    let newest = floor;
    for (const thread of threads) {
        for (const message of thread.messages) {
            newest = Math.max(newest, message.id);
        }
    }
    return newest;
}

/**
 * One notice per thread that waits on the agent with a message newer than `after`: the
 * thread's place and its newest message.
 */
export function notices_from(repo: string, threads: JsonThread[], after: number): DiffNotice[] {
    const notices: DiffNotice[] = [];
    for (const thread of threads) {
        if (thread.waitingOn !== "agent" || thread.status === "resolved") {
            continue;
        }
        const fresh = thread.messages.filter((message) => message.id > after);
        const latest = fresh.at(-1);
        if (latest === undefined) {
            continue;
        }
        notices.push({
            repo,
            thread: thread.id,
            status: thread.status,
            path: thread.path ?? null,
            start_line: thread.startLine ?? null,
            end_line: thread.endLine ?? null,
            author: latest.author,
            text: latest.body,
        });
    }
    return notices;
}
