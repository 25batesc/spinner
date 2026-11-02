// One `diffview` process per repo of a session, in that repo's worktree: a Spinner-managed
// host process like a `runtime: host` service, recorded under `session.yaml` `diff.repos`,
// stopped by pid identity. The viewer announces itself in `<DIFFVIEW_HOME>/servers/<pid>.json`
// with the port it really took (it moves up when its first port is busy); that file is the
// artifact a start waits on.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DIFF_START_TIMEOUT_MS, diff_log_path, type HostProcess } from "@spinner/protocol";
import type { SessionSummary } from "@spinner/protocol";
import {
    host_answers,
    is_spinner_leader,
    process_alive,
    process_start_time,
    stop_host_process,
    type ProcessIdentity,
} from "../stack/host-service.js";
import { write_session } from "../store/session-store.js";
import type { Log } from "./fetch.js";

/** Session n owns `20000 + 100 * n` to `+ 99`; host services count up from `+ 0`. */
const PORT_BASE = 20_000;
const PORTS_PER_SESSION = 100;
/** Viewers count down from the top of the host half, so they never meet the host services. */
const VIEWER_PORT_TOP = 49;
const VIEWERS_MAX = 10;

const START_POLL_MS = 200;

/** The first port the viewer of the `index`-th repo tries. */
export function diff_port(session_id: string, index: number): number {
    const match = /^s(\d+)$/.exec(session_id);
    assert.ok(match?.[1] !== undefined, `session id ${session_id} is not s<n>`);
    assert.ok(index >= 0 && index < VIEWERS_MAX, `at most ${VIEWERS_MAX} repos have a viewer`);
    const base = PORT_BASE + PORTS_PER_SESSION * Number.parseInt(match[1], 10);
    return base + VIEWER_PORT_TOP - index;
}

export function diff_url(port: number): string {
    return `http://127.0.0.1:${port}/`;
}

export interface StartViewerInput {
    /** Absolute path of the viewer's executable (`bin/diffview.mjs`, or a fake in tests). */
    bin: string;
    /** `DIFFVIEW_HOME`. */
    diff_home: string;
    repo: string;
    /** Absolute worktree path. */
    worktree: string;
    /** Absolute session directory. */
    session_dir: string;
    port: number;
    timeout_ms?: number;
}

/** What the viewer wrote to its registry file. */
interface RegistryEntry {
    pid: number;
    port: number;
}

/**
 * Spawns the viewer detached, its output appended to `diff/<repo>.log`, and waits until it
 * registered itself and answers `GET /`. Throws, with the log's tail, when it exits or the
 * bound passes first.
 */
export async function start_viewer(input: StartViewerInput): Promise<HostProcess> {
    assert.ok(existsSync(input.bin), `${input.bin} does not exist`);
    assert.ok(existsSync(input.worktree), `${input.worktree} does not exist`);
    const log = diff_log_path(input.repo);
    const log_path = join(input.session_dir, log);
    mkdirSync(dirname(log_path), { recursive: true });
    mkdirSync(input.diff_home, { recursive: true });
    const fd = openSync(log_path, "a");
    const args = [input.bin, input.worktree, "--no-open", "--port", String(input.port)];
    const child = spawn(process.execPath, args, {
        cwd: input.worktree,
        env: { ...process.env, DIFFVIEW_HOME: input.diff_home },
        stdio: ["ignore", fd, fd],
        detached: true,
    });
    child.unref();
    closeSync(fd);
    assert.ok(child.pid !== undefined, `could not start the viewer of ${input.repo}`);
    const pid = child.pid;
    const started = process_start_time(pid) ?? "";
    const entry = await wait_for_viewer(input, pid, log_path);
    return { pid, started, port: entry.port, log };
}

async function wait_for_viewer(
    input: StartViewerInput,
    pid: number,
    log_path: string,
): Promise<RegistryEntry> {
    const timeout_ms = input.timeout_ms ?? DIFF_START_TIMEOUT_MS;
    const polls_max = Math.ceil(timeout_ms / START_POLL_MS);
    const registry = join(input.diff_home, "servers", `${pid}.json`);
    for (let poll = 0; poll < polls_max; poll += 1) {
        if (!process_alive(pid)) {
            throw new Error(`the viewer of ${input.repo} exited:\n${log_tail(log_path)}`);
        }
        const entry = read_registry(registry);
        if (entry !== null && (await host_answers(entry.port, "/"))) {
            return entry;
        }
        await sleep(START_POLL_MS);
    }
    await stop_host_process({ pid, session_dir: input.session_dir });
    throw new Error(
        `the viewer of ${input.repo} did not answer within ${timeout_ms / 1000} s:\n` +
            log_tail(log_path),
    );
}

function read_registry(path: string): RegistryEntry | null {
    if (!existsSync(path)) {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        // The viewer may be mid-write.
        return null;
    }
    if (typeof parsed !== "object" || parsed === null) {
        return null;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record["pid"] !== "number" || typeof record["port"] !== "number") {
        return null;
    }
    return { pid: record["pid"], port: record["port"] };
}

const TAIL_LINES = 20;

function log_tail(path: string): string {
    if (!existsSync(path)) {
        return "(no log)";
    }
    return readFileSync(path, "utf8").trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
}

/**
 * Stops the viewers of `repos` (every recorded one when absent), removes their entries from
 * `session.yaml` and their registry files, and writes the file. Safe when nothing runs.
 */
export async function stop_viewers(
    summary: SessionSummary,
    diff_home: string,
    log: Log,
    repos?: string[],
): Promise<void> {
    const recorded = summary.session.diff?.repos ?? {};
    const names = repos ?? Object.keys(recorded);
    let changed = false;
    for (const repo of names) {
        const record = recorded[repo];
        if (record === undefined) {
            continue;
        }
        changed = true;
        const outcome = await stop_host_process(identity_of(record, summary.path));
        log(`diff viewer of ${repo} (pid ${record.pid}): ${outcome}`);
        rmSync(join(diff_home, "servers", `${record.pid}.json`), { force: true });
        delete recorded[repo];
    }
    if (summary.session.diff !== undefined && Object.keys(recorded).length === 0) {
        delete summary.session.diff;
    }
    if (changed) {
        write_session(summary);
    }
}

/**
 * After a daemon restart: keeps the recorded viewers that are still Spinner's processes
 * (same pid, same start time) and drops the rest from `session.yaml`. Returns the repos kept.
 */
export async function reattach_viewers(summary: SessionSummary, log: Log): Promise<string[]> {
    const recorded = summary.session.diff?.repos;
    if (recorded === undefined) {
        return [];
    }
    const kept: string[] = [];
    for (const [repo, record] of Object.entries(recorded)) {
        const alive = await is_spinner_leader(identity_of(record, summary.path));
        if (alive) {
            kept.push(repo);
            log(`diff viewer of ${repo}: reattached pid ${record.pid} on port ${record.port}`);
        } else {
            log(`diff viewer of ${repo}: pid ${record.pid} is gone`);
            delete recorded[repo];
        }
    }
    if (kept.length === 0) {
        delete summary.session.diff;
    }
    write_session(summary);
    return kept;
}

/** Records a started viewer under `session.yaml` `diff.repos` and writes the file. */
export function record_viewer(summary: SessionSummary, repo: string, record: HostProcess): void {
    summary.session.diff ??= { repos: {} };
    summary.session.diff.repos[repo] = record;
    write_session(summary);
}

/** A recorded viewer as `stop_host_process` and `is_spinner_leader` identify it. */
function identity_of(record: HostProcess, session_dir: string): ProcessIdentity {
    if (record.started === undefined || record.started === "") {
        return { pid: record.pid, session_dir };
    }
    return { pid: record.pid, session_dir, started: record.started };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
