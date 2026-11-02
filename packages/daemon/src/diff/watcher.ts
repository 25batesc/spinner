// One watcher per running viewer: it parks `diffview comments wait --after <cursor>` in the
// repo's worktree, and when the CLI returns with threads that wait on the agent it sends one
// `notify` per new thread to the session's tty agents, at most `DIFF_NOTICES_PER_SECOND_MAX`
// per second per session. Each round also runs `list --json`, so `session.yaml` holds the
// unresolved threads of both sides: the view counts them, and the stage derivation turns the
// ones waiting on the operator into `needs_human`. The wait is short (`wait_timeout`) so a
// thread the operator resolved in the page leaves `needs_human` within one round.
import assert from "node:assert/strict";
import {
    DIFF_NOTICES_PER_SECOND_MAX,
    diff_notice_text,
    type DiffThreadRecord,
} from "@spinner/protocol";
import {
    newest_message,
    notices_from,
    parse_threads,
    run_comments,
    thread_records,
    type CommentsInput,
} from "./comments.js";

/** How long one `wait` parks before it returns empty and the round refreshes the list. */
export const WAIT_TIMEOUT_DEFAULT = "30s";
/** After a CLI failure the watcher pauses this long before its next round. */
const BACKOFF_MS = 5_000;
/** The upper bound on rounds; a viewer lives hours, not years. */
const ROUNDS_MAX = 1_000_000;

export interface DiffWatcherInput {
    repo: string;
    comments: Omit<CommentsInput, "author">;
    /** `diffview comments wait --timeout`, as the CLI spells it (`30s`, `2m`). */
    wait_timeout?: string;
    /**
     * `wait --after` to start from: 0 notifies every thread already waiting on the agent;
     * null starts from the newest message there is, so a reattach repeats no notice.
     */
    cursor: number | null;
    /** True while the viewer runs; the loop ends when it stops. */
    alive: () => boolean;
    /** Sends one notice to the session's agents. */
    notify: (text: string) => Promise<unknown>;
    /** Receives the repo's unresolved threads after each round. */
    on_threads: (records: DiffThreadRecord[]) => void;
    limiter: NoticeLimiter;
    log: (line: string) => void;
    /** The pause after a failed round, for tests. */
    backoff_ms?: number;
}

/** A per-session bound on notices: `take` resolves when the next one may go. */
export class NoticeLimiter {
    private next_at = 0;

    constructor(private readonly per_second = DIFF_NOTICES_PER_SECOND_MAX) {
        assert.ok(per_second > 0);
    }

    async take(): Promise<void> {
        const now = Date.now();
        const wait = this.next_at - now;
        this.next_at = Math.max(now, this.next_at) + 1_000 / this.per_second;
        if (wait > 0) {
            await sleep(wait);
        }
    }
}

export class DiffWatcher {
    private stopped = false;
    private cursor: number | null;
    readonly done: Promise<void>;

    constructor(private readonly input: DiffWatcherInput) {
        this.cursor = input.cursor;
        this.done = this.run();
    }

    /** Ends the loop after the current round; the parked CLI returns at its own timeout. */
    stop(): void {
        this.stopped = true;
    }

    private async run(): Promise<void> {
        for (let round = 0; round < ROUNDS_MAX; round += 1) {
            if (this.stopped || !this.input.alive()) {
                return;
            }
            try {
                await this.refresh();
                await this.wait();
            } catch (error) {
                // A viewer stopped under a parked `wait` ends the CLI badly; that is expected.
                if (this.stopped || !this.input.alive()) {
                    return;
                }
                const reason = error instanceof Error ? error.message : String(error);
                this.input.log(`diff watcher of ${this.input.repo}: ${reason}`);
                await sleep(this.input.backoff_ms ?? BACKOFF_MS);
            }
        }
    }

    private comments(): CommentsInput {
        return { ...this.input.comments, author: "spinner" };
    }

    /** `list --json`: the unresolved threads of both sides, to `session.yaml`. */
    private async refresh(): Promise<void> {
        const result = await run_comments(this.comments(), ["list", "--json"]);
        if (result.code !== 0) {
            throw new Error(`list exited ${result.code}: ${result.stderr.trim()}`);
        }
        const threads = parse_threads(result.stdout);
        this.cursor ??= newest_message(threads, 0);
        this.input.on_threads(thread_records(this.input.repo, threads));
    }

    /** `wait --after <cursor> --json`: parks, then one notice per new thread on the agent. */
    private async wait(): Promise<void> {
        const timeout = this.input.wait_timeout ?? WAIT_TIMEOUT_DEFAULT;
        const cursor = this.cursor ?? 0;
        const args = ["wait", "--after", String(cursor), "--json", "--timeout", timeout];
        // The CLI bounds itself; the daemon's bound is a little longer, so a healthy wait is
        // never killed from outside.
        const timeout_ms = duration_ms(timeout) + 10_000;
        const result = await run_comments({ ...this.comments(), timeout_ms }, args);
        if (result.code === 3) {
            return;
        }
        if (result.code !== 0) {
            const output = `${result.stderr.trim()}\n${result.stdout.trim()}`.trim();
            throw new Error(`wait exited ${result.code}: ${output}`);
        }
        const threads = parse_threads(result.stdout);
        const notices = notices_from(this.input.repo, threads, cursor);
        this.cursor = newest_message(threads, cursor);
        // The wait prints only the agent's side; the next round's `list` records both sides.
        for (const notice of notices) {
            if (this.stopped) {
                return;
            }
            await this.input.limiter.take();
            await this.input.notify(diff_notice_text(notice));
            this.input.log(`diff comment #${notice.thread} on ${this.input.repo}: notified`);
        }
    }
}

/** `30s`, `10m`, `1h` to milliseconds, as the CLI reads them. */
export function duration_ms(text: string): number {
    const match = /^(\d+)(s|m|h)?$/.exec(text);
    assert.ok(match?.[1] !== undefined, `${text} is not a duration like 30s`);
    const unit = { s: 1_000, m: 60_000, h: 3_600_000 }[match[2] ?? "s"];
    assert.ok(unit !== undefined);
    return Number.parseInt(match[1], 10) * unit;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
