// The daemon's one owner of the diff viewers: the fetch state of the sources, the viewers
// per session and repo, and the `SessionView.diff` the view builder asks for. The record of
// a running viewer is `session.yaml` (`diff.repos`), so the CLI's `down` and `close` can stop
// one without the daemon; this class keeps only what the file cannot: a fetch in flight, a
// start in flight, and the error of the last failed start.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
    DiffFetchState,
    DiffRepoView,
    DiffThreadRecord,
    DiffView,
    DiffWaiting,
    SessionSummary,
} from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";
import { derive_stage } from "../pipeline/derive-stage.js";
import { config_for } from "../pipeline/poller.js";
import { facts_from_session } from "../pipeline/tracker.js";
import { process_alive } from "../stack/host-service.js";
import { read_session, write_session } from "../store/session-store.js";
import { run_comments } from "./comments.js";
import {
    diff_fetched,
    diff_home,
    diff_viewer_bin,
    fetch_diffview,
    type Log,
    type Runner,
} from "./fetch.js";
import {
    diff_port,
    diff_url,
    reattach_viewers,
    record_viewer,
    start_viewer,
    stop_viewers,
} from "./viewer.js";
import { DiffWatcher, NoticeLimiter } from "./watcher.js";

export interface DiffManagerOptions {
    home: SpinnerHome;
    /** Directory `find_spec` searches when a session names no project. */
    cwd: string;
    log: Log;
    /** Sends one notice to every running tty agent of a session; absent means no notices. */
    notify?: (dir: string, text: string) => Promise<unknown>;
    /** `diffview comments wait --timeout` of the watchers; tests shorten it. */
    wait_timeout?: string;
    /** The viewer's executable; the fetched checkout's when absent. A test passes a fake. */
    bin?: string;
    /** The fetch's command runner; a test passes one that fetches nothing. */
    runner?: Runner;
    /** Bound on one viewer start. */
    start_timeout_ms?: number;
}

type RepoMemory = { state: "starting" } | { state: "failed"; error: string };

const NO_WAITING = { agent: 0, human: 0 } as const;
const IDLE: DiffRepoView = {
    state: "stopped",
    url: null,
    pid: null,
    error: null,
    waiting: NO_WAITING,
};

export class DiffManager {
    private readonly home: SpinnerHome;
    private readonly cwd: string;
    private readonly log: Log;
    private readonly notify: ((dir: string, text: string) => Promise<unknown>) | null;
    private readonly wait_timeout: string | undefined;
    /** `<dir>/<repo>` to its watcher while the viewer runs. */
    private readonly watchers = new Map<string, DiffWatcher>();
    /** One notice bound per session, kept across viewers. */
    private readonly limiters = new Map<string, NoticeLimiter>();
    private readonly bin_override: string | null;
    private readonly runner: Runner | undefined;
    private readonly start_timeout_ms: number | undefined;
    private fetching: Promise<void> | null = null;
    private fetch_error: string | null = null;
    /** `<dir>/<repo>` to what the file cannot hold. */
    private readonly memory = new Map<string, RepoMemory>();

    constructor(options: DiffManagerOptions) {
        this.home = options.home;
        this.cwd = options.cwd;
        this.log = options.log;
        this.notify = options.notify ?? null;
        this.wait_timeout = options.wait_timeout;
        this.bin_override = options.bin ?? null;
        this.runner = options.runner;
        this.start_timeout_ms = options.start_timeout_ms;
    }

    /** `DIFFVIEW_HOME`. */
    diff_home(): string {
        return diff_home(this.home);
    }

    /** The viewer's executable, or null until the fetch succeeded. */
    bin(): string | null {
        if (this.bin_override !== null) {
            return existsSync(this.bin_override) ? this.bin_override : null;
        }
        return diff_fetched(this.home) ? diff_viewer_bin(this.home) : null;
    }

    fetch_state(): DiffFetchState {
        if (this.fetching !== null) {
            return "fetching";
        }
        if (this.bin() !== null) {
            return "ready";
        }
        return this.fetch_error === null ? "absent" : "failed";
    }

    /** `SessionView.diff` for one session. Cheap: one `kill 0` per recorded viewer. */
    view(summary: SessionSummary): DiffView {
        const fetch = this.fetch_state();
        const repos: Record<string, DiffRepoView> = {};
        const recorded = summary.session.diff?.repos ?? {};
        for (const repo of Object.keys(summary.session.repos ?? {})) {
            const record = recorded[repo];
            const remembered = this.memory.get(`${summary.dir}/${repo}`);
            if (record !== undefined && process_alive(record.pid)) {
                repos[repo] = {
                    state: "running",
                    url: diff_url(record.port),
                    pid: record.pid,
                    error: null,
                    waiting: waiting_of(summary.session.diff?.threads ?? [], repo),
                };
            } else if (remembered?.state === "starting") {
                repos[repo] = { ...IDLE, state: "starting" };
            } else {
                const error = remembered?.state === "failed" ? remembered.error : null;
                repos[repo] = { ...IDLE, state: error === null ? "stopped" : "failed", error };
            }
        }
        return { available: fetch === "ready", fetch, fetch_error: this.fetch_error, repos };
    }

    /**
     * The `diff` job: fetches the sources when they are not ready, then starts the viewer of
     * `repo` (every repo of the session when absent) and waits for each to answer. A repo
     * whose viewer already runs is left alone.
     */
    async start(summary: SessionSummary, repo: string | undefined, log: Log): Promise<void> {
        const names = this.repo_names(summary, repo);
        if (this.bin() === null) {
            await this.fetch(log);
        }
        const bin = this.bin();
        assert.ok(bin !== null, "the fetch succeeded, so the viewer's executable exists");
        const order = Object.keys(summary.session.repos ?? {});
        for (const name of names) {
            const fresh = this.reread(summary);
            const record = fresh.session.diff?.repos[name];
            if (record !== undefined && process_alive(record.pid)) {
                log(`diff viewer of ${name} already runs (pid ${record.pid}, port ${record.port})`);
                continue;
            }
            const worktree = fresh.session.repos?.[name]?.worktree;
            if (worktree === undefined) {
                throw new Error(`repo ${name} has no worktree yet; attach the project first`);
            }
            const key = `${fresh.dir}/${name}`;
            this.memory.set(key, { state: "starting" });
            try {
                const started = await start_viewer({
                    bin,
                    diff_home: this.diff_home(),
                    repo: name,
                    worktree: join(fresh.path, worktree),
                    session_dir: fresh.path,
                    port: diff_port(fresh.session.id, order.indexOf(name)),
                    ...(this.start_timeout_ms === undefined
                        ? {}
                        : { timeout_ms: this.start_timeout_ms }),
                });
                record_viewer(fresh, name, started);
                this.memory.delete(key);
                log(`diff viewer of ${name}: pid ${started.pid} on ${diff_url(started.port)}`);
                this.watch(fresh, name, 0);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.memory.set(key, { state: "failed", error: message });
                throw error;
            }
        }
    }

    /** Stops the viewer of `repo`, or every viewer of the session. Synchronous for the caller. */
    async stop(summary: SessionSummary, repo: string | undefined, log: Log): Promise<void> {
        const names = this.repo_names(summary, repo);
        for (const name of names) {
            this.memory.delete(`${summary.dir}/${name}`);
            this.unwatch(summary.dir, name);
        }
        const fresh = this.reread(summary);
        await stop_viewers(fresh, this.diff_home(), log, names);
        this.record_threads(fresh, names, []);
    }

    /**
     * At daemon start: validates every recorded viewer by pid identity and watches the live
     * ones from their newest message, so a restart repeats no notice.
     */
    async reattach_all(summaries: SessionSummary[]): Promise<void> {
        for (const summary of summaries) {
            if (summary.session.diff === undefined) {
                continue;
            }
            for (const repo of await reattach_viewers(summary, this.log)) {
                this.watch(summary, repo, null);
            }
        }
    }

    /** Ends every watcher; the viewers stay, they outlive the daemon. */
    close(): void {
        for (const watcher of this.watchers.values()) {
            watcher.stop();
        }
        this.watchers.clear();
    }

    /**
     * Runs `diffview comments <args>` in `agent`'s worktree as that agent, then refreshes the
     * repo's thread records: a reply turns a thread to the operator at once.
     */
    async comments(
        summary: SessionSummary,
        repo: string,
        agent: string,
        args: string[],
    ): Promise<{ code: number; stdout: string; stderr: string }> {
        const bin = this.bin();
        assert.ok(bin !== null, "the caller checked that the viewer is available");
        const worktree = summary.session.repos?.[repo]?.worktree;
        assert.ok(worktree !== undefined, `repo ${repo} has a worktree`);
        const result = await run_comments(
            {
                bin,
                diff_home: this.diff_home(),
                worktree: join(summary.path, worktree),
                author: agent,
                session: summary.dir,
            },
            args,
        );
        return result;
    }

    /** Starts the watcher of a running viewer. `cursor` null means "from the newest message". */
    private watch(summary: SessionSummary, repo: string, cursor: number | null): void {
        const bin = this.bin();
        const worktree = summary.session.repos?.[repo]?.worktree;
        if (bin === null || worktree === undefined) {
            return;
        }
        const key = `${summary.dir}/${repo}`;
        this.unwatch(summary.dir, repo);
        const dir = summary.dir;
        const limiter = this.limiters.get(dir) ?? new NoticeLimiter();
        this.limiters.set(dir, limiter);
        const alive = (): boolean => {
            const read = read_session(this.home, dir);
            const record = read.ok ? read.summary.session.diff?.repos[repo] : undefined;
            return record !== undefined && process_alive(record.pid);
        };
        const watcher = new DiffWatcher({
            repo,
            comments: {
                bin,
                diff_home: this.diff_home(),
                worktree: join(summary.path, worktree),
                session: dir,
            },
            ...(this.wait_timeout === undefined ? {} : { wait_timeout: this.wait_timeout }),
            cursor,
            alive,
            notify: (text) => this.notify?.(dir, text) ?? Promise.resolve(),
            on_threads: (records) => {
                const read = read_session(this.home, dir);
                if (read.ok) {
                    this.record_threads(read.summary, [repo], records);
                }
            },
            limiter,
            log: this.log,
        });
        this.watchers.set(key, watcher);
        void watcher.done.then(() => {
            if (this.watchers.get(key) === watcher) {
                this.watchers.delete(key);
            }
        });
    }

    private unwatch(dir: string, repo: string): void {
        const key = `${dir}/${repo}`;
        this.watchers.get(key)?.stop();
        this.watchers.delete(key);
    }

    /**
     * Replaces the records of `repos` with `records`, re-derives `stage` and `needs_human`
     * from the facts, and writes `session.yaml` when the records changed.
     */
    private record_threads(
        summary: SessionSummary,
        repos: string[],
        records: DiffThreadRecord[],
    ): void {
        const session = summary.session;
        const before = session.diff?.threads ?? [];
        const kept = before.filter((t) => !repos.includes(t.repo));
        const threads = [...kept, ...records].sort((a, b) => a.thread - b.thread);
        if (JSON.stringify(before) === JSON.stringify(threads)) {
            return;
        }
        if (threads.length > 0) {
            session.diff ??= { repos: {} };
            session.diff.threads = threads;
        } else if (session.diff !== undefined) {
            delete session.diff.threads;
            if (Object.keys(session.diff.repos).length === 0) {
                delete session.diff;
            }
        }
        const config = config_for(session, this.home, this.cwd, this.log);
        const result = derive_stage(facts_from_session(session, config, new Date()));
        session.stage = result.stage;
        session.needs_human = result.needs_human;
        write_session(summary);
    }

    /** Validates `repo` against the session, or lists every repo. */
    private repo_names(summary: SessionSummary, repo: string | undefined): string[] {
        const all = Object.keys(summary.session.repos ?? {});
        if (repo === undefined) {
            return all;
        }
        if (!all.includes(repo)) {
            throw new UnknownRepoError(`session ${summary.dir} has no repo ${repo}`);
        }
        return [repo];
    }

    /** One fetch at a time, shared by every session that asks during it. */
    private fetch(log: Log): Promise<void> {
        if (this.fetching === null) {
            this.fetching = fetch_diffview(this.home, log, this.runner)
                .then(() => {
                    this.fetch_error = null;
                })
                .catch((error: unknown) => {
                    this.fetch_error = error instanceof Error ? error.message : String(error);
                    throw error;
                })
                .finally(() => {
                    this.fetching = null;
                });
        }
        return this.fetching;
    }

    /** The job may run after the file changed; the file is the record. */
    private reread(summary: SessionSummary): SessionSummary {
        const read = read_session(this.home, summary.dir);
        return read.ok ? read.summary : summary;
    }
}

/** How many of a repo's recorded threads wait on each side. */
function waiting_of(threads: DiffThreadRecord[], repo: string): DiffWaiting {
    const mine = threads.filter((t) => t.repo === repo);
    return {
        agent: mine.filter((t) => t.waiting_on === "agent").length,
        human: mine.filter((t) => t.waiting_on === "human").length,
    };
}

/** `POST diff/start` or `diff/stop` named a repo the session does not have: a 404. */
export class UnknownRepoError extends Error {}
