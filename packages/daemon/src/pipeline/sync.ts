// Worktree sync (dogfooding, 2026-11-09): once a session's branch exists on the remote, the
// local worktree must never hold work the remote lacks. Every `SYNC_SECONDS_DEFAULT` the
// daemon reads each worktree's state (uncommitted changes, commits ahead of and behind the
// upstream) into `session.repos.<key>.sync`, and pushes the commits ahead with a plain
// `git push` (never a force). The card and the context bar show what is not on the remote.
// The agents stay unable to push themselves (the extension guard); the daemon does it.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RepoSync, Session, SessionSummary } from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";
import { list_sessions, write_session } from "../store/session-store.js";
import type { GitRunner } from "./github-write.js";

/** Seconds between two sync rounds. A round is a few local git calls per worktree. */
export const SYNC_SECONDS_DEFAULT = 15;

/** Upper bound on worktrees one round looks at; past it the rest wait for the next round. */
const WORKTREES_PER_ROUND_MAX = 200;

export interface SyncOptions {
    git: GitRunner;
    /** Pushes commits ahead when the branch has an upstream. False in a read-only daemon. */
    push: boolean;
    now?: () => Date;
    log?: (line: string) => void;
}

export interface SyncReport {
    /** Sessions whose `sync` facts changed and were written. */
    changed: string[];
    pushed: Array<{ dir: string; repo: string; commits: number }>;
    errors: Array<{ dir: string; repo: string; error: string }>;
}

/** One round over every session: the state of each worktree, a push where it is behind. */
export async function sync_once(home: SpinnerHome, options: SyncOptions): Promise<SyncReport> {
    const report: SyncReport = { changed: [], pushed: [], errors: [] };
    const listed = list_sessions(home);
    let looked = 0;
    for (const entry of listed.sessions) {
        if (entry.session.kind === "review") {
            continue;
        }
        let session_changed = false;
        for (const [repo, spec] of Object.entries(entry.session.repos)) {
            if (spec.worktree === undefined) {
                continue;
            }
            const worktree = join(entry.path, spec.worktree);
            if (!existsSync(worktree)) {
                continue;
            }
            looked += 1;
            if (looked > WORKTREES_PER_ROUND_MAX) {
                return report;
            }
            const next = await sync_worktree(worktree, entry.session, repo, options, report, entry);
            if (!same_sync(spec.sync, next)) {
                spec.sync = next;
                session_changed = true;
            }
        }
        if (session_changed) {
            write_session(entry);
            report.changed.push(entry.dir);
        }
    }
    return report;
}

/** The facts of one worktree, after the push it may need. Errors land in the facts. */
async function sync_worktree(
    worktree: string,
    session: Session,
    repo: string,
    options: SyncOptions,
    report: SyncReport,
    entry: SessionSummary,
): Promise<RepoSync> {
    const log = options.log ?? (() => {});
    const dirty = await dirty_count(options.git, worktree);
    let upstream = await has_upstream(options.git, worktree);
    const pr = session.repos[repo]?.pr;
    // A branch pushed by `create PR` has an upstream. One that lost it (a round's new
    // worktree) but has a PR gets it back from the remote branch of the same name.
    if (!upstream && pr != null && options.push) {
        try {
            await options.git(worktree, ["fetch", "origin", session.branch]);
            await options.git(worktree, [
                "branch",
                `--set-upstream-to=origin/${session.branch}`,
            ]);
            upstream = true;
        } catch {
            upstream = false;
        }
    }
    const facts: RepoSync = { dirty, ahead: 0, behind: 0, upstream, error: null };
    if (!upstream) {
        return facts;
    }
    const counts = await ahead_behind(options.git, worktree);
    facts.ahead = counts.ahead;
    facts.behind = counts.behind;
    if (facts.ahead === 0 || !options.push) {
        return facts;
    }
    try {
        await options.git(worktree, ["push", "origin", "HEAD"]);
        log(`sync ${entry.dir} ${repo}: pushed ${facts.ahead} commit(s)`);
        report.pushed.push({ dir: entry.dir, repo, commits: facts.ahead });
        facts.ahead = 0;
        facts.pushed = (options.now ?? (() => new Date()))().toISOString();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        facts.error = first_line(message);
        report.errors.push({ dir: entry.dir, repo, error: facts.error });
        log(`sync ${entry.dir} ${repo}: push failed: ${facts.error}`);
        // The remote moved: fetch it, so `behind` says by how much. A round fetches only
        // here, not every 15 s for every worktree.
        try {
            await options.git(worktree, ["fetch", "origin", session.branch]);
            const fresh = await ahead_behind(options.git, worktree);
            facts.ahead = fresh.ahead;
            facts.behind = fresh.behind;
        } catch {
            // Offline: the counts from before the push stand.
        }
    }
    return facts;
}

/** Tracked files with changes, staged or not. Untracked files do not count: installs. */
async function dirty_count(git: GitRunner, worktree: string): Promise<number> {
    const out = await git(worktree, ["status", "--porcelain", "--untracked-files=no"]);
    return out.split("\n").filter((line) => line.trim().length > 0).length;
}

async function has_upstream(git: GitRunner, worktree: string): Promise<boolean> {
    try {
        const args = ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"];
        const out = await git(worktree, args);
        return out.trim().length > 0;
    } catch {
        return false;
    }
}

/** `git rev-list --left-right --count @{u}...HEAD` prints `<behind>\t<ahead>`. */
export async function ahead_behind(
    git: GitRunner,
    worktree: string,
): Promise<{ ahead: number; behind: number }> {
    const out = await git(worktree, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
    const [behind_text, ahead_text] = out.trim().split(/\s+/);
    const behind = Number.parseInt(behind_text ?? "0", 10);
    const ahead = Number.parseInt(ahead_text ?? "0", 10);
    assert.ok(Number.isInteger(behind) && behind >= 0, `rev-list behind: ${out}`);
    assert.ok(Number.isInteger(ahead) && ahead >= 0, `rev-list ahead: ${out}`);
    return { ahead, behind };
}

/** Equal facts apart from the push stamp, so a round that changes nothing writes nothing. */
export function same_sync(a: RepoSync | undefined, b: RepoSync): boolean {
    if (a === undefined) {
        return false;
    }
    return (
        a.dirty === b.dirty &&
        a.ahead === b.ahead &&
        a.behind === b.behind &&
        a.upstream === b.upstream &&
        (a.error ?? null) === (b.error ?? null) &&
        (b.pushed === undefined || a.pushed === b.pushed)
    );
}

function first_line(text: string): string {
    return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? text;
}

export interface Syncer {
    round(): Promise<SyncReport>;
    stop(): void;
}

/** Rounds every `interval_ms`, one at a time; `round()` runs one now. */
export function start_syncer(
    home: SpinnerHome,
    options: SyncOptions,
    interval_ms: number,
    on_round: (report: SyncReport) => void,
): Syncer {
    assert.ok(interval_ms >= 1000, "sync interval must be at least one second");
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;
    let chain: Promise<unknown> = Promise.resolve();
    const run = (): Promise<SyncReport> => {
        const next = chain.then(() => sync_once(home, options));
        chain = next.catch(() => undefined);
        return next;
    };
    const round = async (): Promise<void> => {
        try {
            const report = await run();
            if (!stopped) {
                on_round(report);
            }
        } catch (error) {
            (options.log ?? (() => {}))(`sync: ${error instanceof Error ? error.message : error}`);
        }
        if (!stopped) {
            timer = setTimeout(() => void round(), interval_ms);
        }
    };
    void round();
    return {
        round: run,
        stop: () => {
            stopped = true;
            if (timer !== null) {
                clearTimeout(timer);
            }
        },
    };
}
