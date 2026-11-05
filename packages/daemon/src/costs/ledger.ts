// The cost ledger (s013): what every agent spent, folded from the pi transcripts. pi writes
// `usage.cost.total` and the token counts into each assistant message (`docs/session-format.md`
// of the pi package), and the transcript is the record (MISSION.md Contracts): the daemon
// writes no cost file. The ledger scans `<home>/sessions/*/agents/*/pi/*.jsonl`, the archive
// and `<home>/operator/pi/*.jsonl`, keeps one `CostRow` per assistant message, and caches the
// rows per file by size and mtime, so a refold reads only the files that changed. The views
// read `session_cost` and `operator_cost`; the `/costs` route reads `rows`. `start_cost_ledger`
// wires the refold to `agent.settled` and a 60 s timer and publishes `costs` when a total moved.
// Build session 4 (T6, entry 4.6) adds the Goldfish: each session's run files name the child
// transcripts (`read_runs`), and their rows carry `child` and sum into `SessionCost.children`.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
    AgentContext,
    AgentCost,
    CostRow,
    OperatorCost,
    SessionCost,
    SpinnerEvent,
} from "@spinner/protocol";
import { COSTS_REFOLD_INTERVAL_MS, EGM_RUNS_DIR } from "@spinner/protocol";
import { child_key, inside_agents, read_runs } from "../egm/goldfish.js";
import type { EventBus } from "../event-bus.js";
import type { SpinnerHome } from "../home.js";
import { period_totals, totals_of, type LocalClock } from "./periods.js";

/** Upper bound on transcript files one home is expected to hold. */
const FILES_MAX = 20_000;

/** Upper bound on Goldfish transcripts across the home; past it the newest are kept. */
export const CHILD_FILES_MAX = 20_000;

/** Upper bound on entries one transcript is read for; pi compacts long before this. */
const ENTRIES_MAX = 200_000;

/** The operator agent's transcripts live here; its rows carry `session: null`. */
const OPERATOR_DIR = "operator";
const OPERATOR_AGENT = "operator";

interface CachedFile {
    size: number;
    mtime_ms: number;
    rows: CostRow[];
}

/** One transcript file and the agent it belongs to. */
export interface TranscriptRef {
    path: string;
    session: string | null;
    agent: string;
    /** `"<runId>/<step index>"` for a Goldfish transcript; its rows carry it. */
    child?: string;
}

export interface CostLedgerOptions {
    log?: (line: string) => void;
    /** `CHILD_FILES_MAX` unless a test lowers it. */
    child_files_max?: number;
}

export class CostLedger {
    private readonly cache = new Map<string, CachedFile>();
    private readonly listeners = new Set<(changed: Set<string | null>) => void>();
    private readonly log: (line: string) => void;
    private readonly child_files_max: number;

    constructor(
        private readonly home: SpinnerHome,
        options: CostLedgerOptions = {},
    ) {
        this.log = options.log ?? (() => undefined);
        this.child_files_max = options.child_files_max ?? CHILD_FILES_MAX;
        assert.ok(this.child_files_max > 0, "the child transcript bound must be positive");
    }

    /** Every row, in file order; the route filters and groups. */
    rows(): CostRow[] {
        const all: CostRow[] = [];
        for (const entry of this.cache.values()) {
            all.push(...entry.rows);
        }
        return all;
    }

    /** The files the ledger has folded, for a test. */
    files(): string[] {
        return [...this.cache.keys()].sort();
    }

    /** The session's cost; `window_of` gives a model's context window for `context`. */
    session_cost(dir: string, window_of: WindowOf = no_window): SessionCost {
        return session_cost_of(this.rows_of(dir), window_of);
    }

    operator_cost(): OperatorCost {
        return totals_of(this.rows_of(null));
    }

    /**
     * Reads every transcript whose size or mtime changed since the last fold, drops the ones
     * that are gone, and returns the session keys (null for the operator) whose rows changed.
     */
    refold(): Set<string | null> {
        const changed = new Set<string | null>();
        const seen = new Set<string>();
        for (const ref of this.transcripts()) {
            seen.add(ref.path);
            const stat = statSync(ref.path);
            const cached = this.cache.get(ref.path);
            const unchanged =
                cached !== undefined &&
                cached.size === stat.size &&
                cached.mtime_ms === stat.mtimeMs;
            if (unchanged) {
                continue;
            }
            const rows = fold_transcript(readFileSync(ref.path, "utf8"), ref);
            this.cache.set(ref.path, { size: stat.size, mtime_ms: stat.mtimeMs, rows });
            changed.add(ref.session);
        }
        for (const path of [...this.cache.keys()]) {
            if (!seen.has(path)) {
                const gone = this.cache.get(path);
                this.cache.delete(path);
                changed.add(gone?.rows[0]?.session ?? null);
            }
        }
        if (changed.size > 0) {
            for (const listener of this.listeners) {
                listener(changed);
            }
        }
        return changed;
    }

    on_change(listener: (changed: Set<string | null>) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * The transcript files of live sessions, archived sessions and the operator agent, then
     * the Goldfish transcripts that the sessions' run files name.
     */
    transcripts(): TranscriptRef[] {
        const refs: TranscriptRef[] = [];
        const children: TranscriptRef[] = [];
        for (const root of [this.home.sessions, this.home.archive]) {
            for (const dir of subdirectories(root)) {
                const agents = join(root, dir, "agents");
                for (const agent of subdirectories(agents)) {
                    for (const file of jsonl_files(join(agents, agent, "pi"))) {
                        refs.push({ path: file, session: dir, agent });
                    }
                }
                children.push(...child_transcripts(join(root, dir), dir));
            }
        }
        for (const file of jsonl_files(join(this.home.root, OPERATOR_DIR, "pi"))) {
            refs.push({ path: file, session: null, agent: OPERATOR_AGENT });
        }
        assert.ok(refs.length <= FILES_MAX, `more than ${FILES_MAX} transcripts in the home`);
        return [...refs, ...this.bounded(children)];
    }

    /** The newest `child_files_max` child refs by mtime; one log line when it drops some. */
    private bounded(children: TranscriptRef[]): TranscriptRef[] {
        if (children.length <= this.child_files_max) {
            return children;
        }
        const dated = children.map((ref) => ({ ref, mtime: statSync(ref.path).mtimeMs }));
        dated.sort((a, b) => b.mtime - a.mtime);
        const skipped = children.length - this.child_files_max;
        this.log(`cost ledger: ${skipped} child transcripts past ${this.child_files_max} skipped`);
        return dated.slice(0, this.child_files_max).map((entry) => entry.ref);
    }

    private rows_of(session: string | null): CostRow[] {
        return this.rows().filter((row) => row.session === session);
    }
}

/**
 * The Goldfish transcripts of one session: each step's `session_file` inside the session's
 * `agents/`, as a ref of the lead with its child key. Other paths are skipped (T6).
 */
function child_transcripts(session_path: string, dir: string): TranscriptRef[] {
    const refs: TranscriptRef[] = [];
    const seen = new Set<string>();
    for (const run of read_runs(join(session_path, EGM_RUNS_DIR))) {
        for (const step of run.steps) {
            const file = step.session_file;
            if (file === null || seen.has(file) || !inside_agents(session_path, file)) {
                continue;
            }
            seen.add(file);
            refs.push({
                path: file,
                session: dir,
                agent: "lead",
                child: child_key(run.run, step.index),
            });
        }
    }
    return refs;
}

/**
 * Pure: a transcript's text to its rows. Only `message` entries whose message is an
 * assistant message with `usage.cost.total` count; a user message, a tool result, a
 * compaction or an unreadable line is skipped.
 */
export function fold_transcript(text: string, ref: TranscriptRef): CostRow[] {
    const rows: CostRow[] = [];
    const lines = text.split("\n").slice(0, ENTRIES_MAX);
    for (const line of lines) {
        if (line.trim().length === 0) {
            continue;
        }
        let entry: unknown;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        const row = row_of(entry, ref);
        if (row !== null) {
            rows.push(row);
        }
    }
    return rows;
}

function row_of(entry: unknown, ref: TranscriptRef): CostRow | null {
    const record = as_record(entry);
    if (record === null || record["type"] !== "message") {
        return null;
    }
    const message = as_record(record["message"]);
    if (message === null || message["role"] !== "assistant") {
        return null;
    }
    const usage = as_record(message["usage"]);
    const cost = usage === null ? null : as_record(usage["cost"]);
    if (usage === null || cost === null || typeof cost["total"] !== "number") {
        return null;
    }
    const ts = timestamp_of(record["timestamp"], message["timestamp"]);
    if (ts === null) {
        return null;
    }
    const provider = typeof message["provider"] === "string" ? message["provider"] : "";
    const model = typeof message["model"] === "string" ? message["model"] : "unknown";
    const row: CostRow = {
        ts,
        session: ref.session,
        agent: ref.agent,
        model: provider.length > 0 ? `${provider}/${model}` : model,
        usd: cost["total"],
        tokens_in: number_of(usage["input"]),
        tokens_out: number_of(usage["output"]),
        cache_read: number_of(usage["cacheRead"]),
        cache_write: number_of(usage["cacheWrite"]),
    };
    if (ref.child !== undefined) {
        row.child = ref.child;
    }
    return row;
}

/** The entry's ISO `timestamp`, else the message's epoch-millisecond one, else null. */
function timestamp_of(entry_ts: unknown, message_ts: unknown): string | null {
    if (typeof entry_ts === "string" && !Number.isNaN(Date.parse(entry_ts))) {
        return new Date(entry_ts).toISOString();
    }
    if (typeof message_ts === "number" && Number.isFinite(message_ts)) {
        return new Date(message_ts).toISOString();
    }
    return null;
}

/** A model's context window in tokens (`provider/id`), or null when it is not known. */
export type WindowOf = (model: string) => number | null;

const no_window: WindowOf = () => null;

/**
 * Pure: rows of one session to its cost; each agent's model is that of its latest row, and
 * its `context` is that row's prompt (`input + cacheRead + cacheWrite`) against the model's
 * window (dogfood #45), null while the window is unknown. A row with `child` sums into
 * `children[child]`, not into its agent; the totals include all rows.
 */
export function session_cost_of(rows: CostRow[], window_of: WindowOf = no_window): SessionCost {
    const agents: Record<string, AgentCost> = {};
    const children: Record<string, AgentCost> = {};
    const latest = new Map<string, CostRow>();
    for (const row of rows) {
        const group = row.child === undefined ? agents : children;
        const key = row.child ?? row.agent;
        const current = group[key] ?? { usd: 0, tokens_in: 0, tokens_out: 0, model: null };
        current.usd += row.usd;
        current.tokens_in += row.tokens_in;
        current.tokens_out += row.tokens_out;
        const slot = row.child === undefined ? `agent:${key}` : `child:${key}`;
        const seen = latest.get(slot);
        if (seen === undefined || row.ts >= seen.ts) {
            latest.set(slot, row);
            current.model = row.model;
        }
        group[key] = current;
    }
    for (const [key, cost] of Object.entries(agents)) {
        const row = latest.get(`agent:${key}`);
        assert.ok(row !== undefined, `agent ${key} must have a latest row`);
        cost.context = context_of(row, window_of(row.model));
    }
    const cost: SessionCost = { ...totals_of(rows), agents };
    if (Object.keys(children).length > 0) {
        cost.children = children;
    }
    return cost;
}

/** The context use of a latest row, or null without a positive window. */
export function context_of(row: CostRow, window: number | null): AgentContext | null {
    if (window === null || !(window > 0)) {
        return null;
    }
    const tokens = row.tokens_in + row.cache_read + row.cache_write;
    assert.ok(tokens >= 0, "a row's token counts are not negative");
    return { tokens, window, pct: Math.floor((tokens * 100) / window) };
}

export interface LedgerLoopInput {
    home: SpinnerHome;
    bus: EventBus;
    clock?: LocalClock;
    log?: (line: string) => void;
    /** Called per session whose cost changed, after the `costs` event, to republish its view. */
    on_session_changed?: (dir: string) => void;
}

export interface LedgerLoop {
    ledger: CostLedger;
    /** One refold now, for a test or a route that wants fresh numbers. */
    refold(): void;
    stop(): void;
}

/**
 * Folds once, then again on every `agent.settled` and every `interval_ms`. A refold that
 * changed a total publishes `costs` with the local-zone figures and the changed sessions.
 */
export function start_cost_ledger(
    input: LedgerLoopInput,
    interval_ms = COSTS_REFOLD_INTERVAL_MS,
): LedgerLoop {
    assert.ok(interval_ms >= 100, "refold interval must be at least 100 ms");
    const log = input.log ?? (() => undefined);
    const ledger = new CostLedger(input.home, { log });
    const clock: LocalClock = input.clock ?? { now: () => new Date() };
    let stopped = false;
    let in_flight = false;

    const refold = (): void => {
        if (stopped || in_flight) {
            return;
        }
        in_flight = true;
        try {
            const changed = ledger.refold();
            if (changed.size === 0) {
                return;
            }
            const rows = ledger.rows();
            const figures = period_totals(rows, clock);
            const changed_sessions: Record<string, SessionCost> = {};
            for (const key of changed) {
                if (key !== null) {
                    changed_sessions[key] = ledger.session_cost(key);
                }
            }
            input.bus.publish({
                type: "costs",
                ts: clock.now().toISOString(),
                session: null,
                today: figures.today,
                week: figures.week,
                month: figures.month,
                changed: changed_sessions,
            });
            for (const dir of Object.keys(changed_sessions)) {
                input.on_session_changed?.(dir);
            }
        } catch (error) {
            log(`costs refold: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            in_flight = false;
        }
    };

    refold();
    const unsubscribe = input.bus.subscribe((event: SpinnerEvent) => {
        if (event.type === "agent.settled") {
            refold();
        }
    });
    const timer = setInterval(refold, interval_ms);
    return {
        ledger,
        refold,
        stop: () => {
            stopped = true;
            clearInterval(timer);
            unsubscribe();
        },
    };
}

function subdirectories(dir: string): string[] {
    if (!existsSync(dir)) {
        return [];
    }
    return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort();
}

function jsonl_files(dir: string): string[] {
    if (!existsSync(dir)) {
        return [];
    }
    return readdirSync(dir)
        .filter((name) => name.endsWith(".jsonl"))
        .sort()
        .map((name) => join(dir, name));
}

function as_record(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }
    return value as Record<string, unknown>;
}

function number_of(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
