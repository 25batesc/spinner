// The watcher of the lead's subagents. An EGM skill starts its Goldfish reviewers through
// pi-subagents, and the lead can start any other subagent the same way: each runs as a child
// inside the lead's pi. The daemon cannot see them as agents, so it reads the files
// pi-subagents writes:
//
// 1. An async run writes `<session>/egm-runs/async-subagent-runs/<runId>/status.json`
//    (`PI_SUBAGENTS_TEMP_ROOT` is `<session>/egm-runs`). pi-subagents 0.84.0 runs a parallel
//    fan-out as one `workflow` run whose steps name a child run each, and every child also
//    writes its own run directory. A step that names a child run read here is dropped from
//    its workflow run, so each Goldfish shows once.
// 2. A foreground run (`async: false`) writes no status file (session 1, finding 4). Its
//    files are `<session>/agents/lead/pi/subagent-artifacts/<runId>_<agent>_<step>_*`. The
//    transcript exists while it runs; the `meta.json` appears when it ends.
//
// `read_runs` is pure over the files. `GoldfishWatcher` polls the runs of each session that
// may have live subagents and tells the daemon when their rows changed.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { GoldfishState, GoldfishView } from "@spinner/protocol";
import {
    EGM_RUNS_DIR,
    GOLDFISH_POLL_MS,
    GOLDFISH_RUNS_MAX,
    GOLDFISH_SETTLE_POLL_MS,
    LEAD_NAME,
} from "@spinner/protocol";
import type { AgentManager } from "../agents/manager.js";
import type { EventBus } from "../event-bus.js";
import type { SpinnerHome } from "../home.js";
import { read_session } from "../store/session-store.js";

export interface GoldfishStep {
    /** The step's index in its run's `steps`, which `child_key` uses. */
    index: number;
    agent: string;
    status: string;
    model: string | null;
    tokens: number;
    /** Epoch milliseconds. */
    started: number | null;
    /** Epoch milliseconds. */
    last_activity: number | null;
    session_file: string | null;
    /** The step's own run id (`steps[].runId`); a workflow step names its child run here. */
    child_run: string | null;
}

export interface GoldfishRun {
    run: string;
    state: string;
    /** Epoch milliseconds. */
    started: number | null;
    /** True for a foreground run read from `subagent-artifacts/`. */
    foreground: boolean;
    steps: GoldfishStep[];
}

/** pi-subagents' directory of async runs under `PI_SUBAGENTS_TEMP_ROOT`. */
const ASYNC_RUNS_DIR = "async-subagent-runs";
/** pi-subagents' debug artifacts, under the lead's pi session directory. */
const ARTIFACTS_DIR = "subagent-artifacts";
/** A foreground transcript: `<runId>_<agent>_<step>_transcript.jsonl`. */
const FOREGROUND_TRANSCRIPT = /^([0-9a-f-]{36})_(.+)_(\d{1,3})_transcript\.jsonl$/;

/**
 * Pure: one `status.json` to a run, or null when it has no `runId` (or `id`) or no `steps`.
 * Each missing step field gets its default: tokens 0, status `""`, the others null.
 */
export function parse_status(json: unknown): GoldfishRun | null {
    const record = as_record(json);
    if (record === null) {
        return null;
    }
    const run = string_or_null(record["runId"]) ?? string_or_null(record["id"]);
    const steps = record["steps"];
    if (run === null || !Array.isArray(steps)) {
        return null;
    }
    return {
        run,
        state: string_or_null(record["state"]) ?? "",
        started: number_or_null(record["startedAt"]),
        foreground: false,
        steps: steps.map((step: unknown, index) => parse_step(step, index)),
    };
}

function parse_step(json: unknown, index: number): GoldfishStep {
    const step = as_record(json) ?? {};
    const tokens = as_record(step["tokens"]);
    return {
        index,
        agent: string_or_null(step["agent"]) ?? "",
        status: string_or_null(step["status"]) ?? "",
        model: string_or_null(step["model"]),
        tokens: number_or_null(tokens?.["total"]) ?? 0,
        started: number_or_null(step["startedAt"]),
        last_activity: number_or_null(step["lastActivityAt"]),
        session_file: string_or_null(step["sessionFile"]),
        child_run: string_or_null(step["runId"]),
    };
}

/**
 * The runs of one session, newest first, at most `GOLDFISH_RUNS_MAX`: the async runs under
 * `<runs_dir>/async-subagent-runs/` and the foreground runs of the lead's artifacts.
 * `runs_dir` is `<session>/egm-runs`. Unreadable files are skipped.
 */
export function read_runs(runs_dir: string): GoldfishRun[] {
    const async_runs = read_async_runs(join(runs_dir, ASYNC_RUNS_DIR));
    const session = dirname(runs_dir);
    const foreground = read_foreground_runs(session, join(runs_dir, ASYNC_RUNS_DIR));
    const runs = drop_workflow_duplicates([...async_runs, ...foreground]);
    runs.sort((a, b) => (b.started ?? 0) - (a.started ?? 0));
    return runs.slice(0, GOLDFISH_RUNS_MAX);
}

function read_async_runs(root: string): GoldfishRun[] {
    const dirs = newest_entries(root, GOLDFISH_RUNS_MAX, true);
    const runs: GoldfishRun[] = [];
    for (const dir of dirs) {
        const file = join(root, dir, "status.json");
        try {
            const run = parse_status(JSON.parse(readFileSync(file, "utf8")));
            if (run !== null) {
                runs.push(run);
            }
        } catch {
            continue;
        }
    }
    return runs;
}

/** Foreground runs: transcripts in `subagent-artifacts/` whose run has no async directory. */
function read_foreground_runs(session: string, async_root: string): GoldfishRun[] {
    const pi_dir = join(session, "agents", LEAD_NAME, "pi");
    const artifacts = join(pi_dir, ARTIFACTS_DIR);
    // Each run leaves 4 artifact files, so the bound on files is 4 times the bound on runs.
    const names = newest_entries(artifacts, GOLDFISH_RUNS_MAX * 4, false);
    const by_run = new Map<string, GoldfishRun>();
    for (const name of names) {
        const match = FOREGROUND_TRANSCRIPT.exec(name);
        if (match === null || existsSync(join(async_root, match[1] as string))) {
            continue;
        }
        const run_id = match[1] as string;
        let step: GoldfishStep;
        try {
            step = foreground_step(pi_dir, artifacts, run_id, match[2] as string, match[3]);
        } catch {
            continue;
        }
        const run = by_run.get(run_id) ?? {
            run: run_id,
            state: "complete",
            started: null,
            foreground: true,
            steps: [],
        };
        run.steps.push(step);
        run.steps.sort((a, b) => a.index - b.index);
        if (step.status === "running") {
            run.state = "running";
        }
        run.started = Math.min(run.started ?? Infinity, step.started ?? Infinity);
        if (!Number.isFinite(run.started)) {
            run.started = null;
        }
        by_run.set(run_id, run);
    }
    return [...by_run.values()];
}

function foreground_step(
    pi_dir: string,
    artifacts: string,
    run_id: string,
    agent: string,
    index_text: string | undefined,
): GoldfishStep {
    const index = Number(index_text);
    const prefix = join(artifacts, `${run_id}_${agent}_${index}`);
    const transcript = statSync(`${prefix}_transcript.jsonl`);
    const meta = read_json(`${prefix}_meta.json`);
    const usage = as_record(meta?.["usage"]);
    const exit = meta === null ? null : number_or_null(meta["exitCode"]);
    return {
        index,
        agent,
        status: meta === null ? "running" : exit === 0 ? "complete" : "failed",
        model: meta === null ? null : string_or_null(meta["model"]),
        tokens: (number_or_null(usage?.["input"]) ?? 0) + (number_or_null(usage?.["output"]) ?? 0),
        started: transcript.birthtimeMs,
        last_activity: transcript.mtimeMs,
        session_file: foreground_session_file(pi_dir, run_id, index),
        child_run: null,
    };
}

/** pi-subagents keeps a child's pi session at `<lead pi>/<lead session>/<runId>/run-<i>/`. */
function foreground_session_file(pi_dir: string, run_id: string, index: number): string | null {
    for (const entry of readdirSync(pi_dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === ARTIFACTS_DIR) {
            continue;
        }
        const file = join(pi_dir, entry.name, run_id, `run-${index}`, "session.jsonl");
        if (existsSync(file)) {
            return file;
        }
    }
    return null;
}

/** Drops each workflow step whose child run is read too; a run left without steps goes. */
function drop_workflow_duplicates(runs: GoldfishRun[]): GoldfishRun[] {
    const ids = new Set(runs.map((run) => run.run));
    const kept: GoldfishRun[] = [];
    for (const run of runs) {
        const steps = run.steps.filter(
            (step) =>
                step.child_run === null || step.child_run === run.run || !ids.has(step.child_run),
        );
        if (steps.length > 0 || run.steps.length === 0) {
            kept.push({ ...run, steps });
        }
    }
    return kept;
}

/**
 * Pure: a pi-subagents step status to a chip state. An unknown word reads `running` while
 * the run's state is `running`, else `failed`. The words are those of pi-subagents 0.83.0.
 */
export function chip_state(step_status: string, run_state: string): GoldfishState {
    switch (step_status) {
        case "queued":
        case "pending":
            return "queued";
        case "running":
            return "running";
        case "complete":
        case "completed":
            return "done";
        case "failed":
        case "rejected":
            return "failed";
        case "stopped":
        case "paused":
            return "stopped";
        default:
            return run_state === "running" ? "running" : "failed";
    }
}

/** The key of one Goldfish step in `SessionCost.children` and in the chips. */
export function child_key(run: string, step_index: number): string {
    return `${run}/${step_index}`;
}

/**
 * The runs of a session as the chips show them. A foreground step without its `meta.json`
 * runs inside the lead's turn, so it reads `stopped` while the lead is not busy: its turn
 * ended without the file, and the step must not count as live.
 */
export function session_runs(session_path: string, lead_busy: boolean): GoldfishRun[] {
    const runs = read_runs(join(session_path, EGM_RUNS_DIR));
    if (lead_busy) {
        return runs;
    }
    return runs.map((run) => {
        if (!run.foreground || run.state !== "running") {
            return run;
        }
        const steps = run.steps.map((step) =>
            step.status === "running" ? { ...step, status: "stopped" } : step,
        );
        return { ...run, state: "stopped", steps };
    });
}

/** The number of steps that read `running` as chips. */
export function running_steps(runs: GoldfishRun[]): number {
    let count = 0;
    for (const run of runs) {
        for (const step of run.steps) {
            if (chip_state(step.status, run.state) === "running") {
                count += 1;
            }
        }
    }
    return count;
}

/** True when `file` resolves to a path inside `<session_path>/agents/`. */
export function inside_agents(session_path: string, file: string): boolean {
    try {
        const agents = realpathSync(join(session_path, "agents"));
        return realpathSync(file).startsWith(`${agents}${sep}`);
    } catch {
        return false;
    }
}

/**
 * The subagent steps of a session as the agents table shows them, newest run first. `usd`
 * comes from `children`, the cost ledger's rows by `child_key`; a step it has not priced yet
 * reads 0.
 */
export function subagent_views(
    session_path: string,
    lead_busy: boolean,
    children: Readonly<Record<string, { usd: number }>>,
): GoldfishView[] {
    const views: GoldfishView[] = [];
    for (const run of session_runs(session_path, lead_busy)) {
        for (const step of run.steps) {
            views.push({
                run: run.run,
                step: step.index,
                agent: step.agent,
                persona: step.agent.startsWith("egm-") ? step.agent.slice(4) : null,
                state: chip_state(step.status, run.state),
                model: step.model,
                tokens: step.tokens,
                usd: children[child_key(run.run, step.index)]?.usd ?? 0,
                started: iso_or_null(step.started ?? run.started),
                last_activity: iso_or_null(step.last_activity),
                transcript: step.session_file !== null && existsSync(step.session_file),
            });
        }
    }
    return views;
}

function iso_or_null(ms: number | null): string | null {
    return ms === null ? null : new Date(ms).toISOString();
}

export interface GoldfishWatcherDeps {
    home: SpinnerHome;
    agents: Pick<AgentManager, "is_busy">;
    bus: EventBus;
    on_change: (dir: string) => Promise<void>;
    log: (line: string) => void;
    /** Epoch milliseconds; tests pass a fake clock. */
    now?: () => number;
}

interface Watched {
    timer: ReturnType<typeof setInterval>;
    /** `(run, step, status, tokens)` of the last tick. */
    signature: string;
    running: number;
}

/** At most this many sessions are polled at once; past it a wake is logged and dropped. */
const WATCHED_MAX = 200;

export class GoldfishWatcher {
    private readonly watched = new Map<string, Watched>();
    private readonly settled = new Map<string, number>();
    private readonly unsubscribe: () => void;
    private readonly now: () => number;

    constructor(private readonly deps: GoldfishWatcherDeps) {
        this.now = deps.now ?? Date.now;
        this.unsubscribe = deps.bus.subscribe((event) => {
            if (event.type === "session.closed") {
                this.forget(event.session);
                return;
            }
            if (event.session === null) {
                return;
            }
            if (event.type === "agent.settled" && event.agent === LEAD_NAME) {
                this.settled.set(event.session, this.now());
                this.wake(event.session);
                return;
            }
            if (event.type !== "agent.event" || event.agent !== LEAD_NAME) {
                return;
            }
            const pi = event.event;
            if (pi.type === "agent_start") {
                this.wake(event.session);
            }
            if (pi.type === "tool_execution_start" && pi.toolName === "subagent") {
                this.wake(event.session);
            }
        });
    }

    /** Starts the session's poll timer unless it runs, and ticks once at once. */
    wake(dir: string): void {
        if (this.watched.has(dir)) {
            return;
        }
        if (this.watched.size >= WATCHED_MAX) {
            this.deps.log(`goldfish ${dir}: ${WATCHED_MAX} sessions are watched; not watched`);
            return;
        }
        const timer = setInterval(() => void this.tick(dir), GOLDFISH_POLL_MS);
        this.watched.set(dir, { timer, signature: "", running: 0 });
        void this.tick(dir);
    }

    /** True while the session's poll timer runs, for a test. */
    watching(dir: string): boolean {
        return this.watched.has(dir);
    }

    close(): void {
        this.unsubscribe();
        for (const dir of [...this.watched.keys()]) {
            this.forget(dir);
        }
    }

    /** One poll: read, compare, and stop the timer once nothing can change. */
    async tick(dir: string): Promise<void> {
        const entry = this.watched.get(dir);
        const read = read_session(this.deps.home, dir);
        if (entry === undefined || !read.ok) {
            this.forget(dir);
            return;
        }
        const busy = this.deps.agents.is_busy(dir, LEAD_NAME);
        let runs: GoldfishRun[];
        try {
            runs = session_runs(read.summary.path, busy);
        } catch (error) {
            this.deps.log(`goldfish ${dir}: ${String(error)}`);
            return;
        }
        entry.running = running_steps(runs);
        const signature = signature_of(runs);
        const changed = signature !== entry.signature;
        entry.signature = signature;
        const settled_at = this.settled.get(dir) ?? 0;
        const settle_over = this.now() - settled_at > GOLDFISH_SETTLE_POLL_MS;
        if (!busy && entry.running === 0 && settle_over) {
            this.forget(dir);
        }
        if (changed) {
            await this.deps.on_change(dir);
        }
    }

    private forget(dir: string): void {
        const entry = this.watched.get(dir);
        if (entry !== undefined) {
            clearInterval(entry.timer);
        }
        this.watched.delete(dir);
    }
}

function signature_of(runs: GoldfishRun[]): string {
    const parts: string[] = [];
    for (const run of runs) {
        for (const step of run.steps) {
            parts.push(
                `${run.run}/${step.index}:${chip_state(step.status, run.state)}:${step.tokens}`,
            );
        }
    }
    return parts.join("|");
}

/**
 * The names in `dir`, newest first by modification time, at most `max`. With `dirs`, only
 * directories; else only files.
 */
function newest_entries(dir: string, max: number, dirs: boolean): string[] {
    if (!existsSync(dir)) {
        return [];
    }
    const entries: { name: string; mtime: number }[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() !== dirs || (!dirs && !entry.isFile())) {
            continue;
        }
        try {
            entries.push({ name: entry.name, mtime: statSync(join(dir, entry.name)).mtimeMs });
        } catch {
            continue;
        }
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    return entries.slice(0, max).map((entry) => entry.name);
}

function read_json(file: string): Record<string, unknown> | null {
    try {
        return as_record(JSON.parse(readFileSync(file, "utf8")));
    } catch {
        return null;
    }
}

function as_record(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }
    return value as Record<string, unknown>;
}

function string_or_null(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function number_or_null(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
