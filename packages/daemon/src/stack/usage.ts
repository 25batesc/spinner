// Resource usage per session and per service, so the operator sees how much of the machine
// each stack takes. A sampler runs every `USAGE_INTERVAL_MS` while at least one stack is up:
// one `docker ps` to map containers to compose projects and services, one `docker stats
// --no-stream` for every container, and one `ps -axo pid,ppid,rss,%cpu` pass that attributes
// each host service's process tree (the pid in `stack/pids/` and its descendants) to the
// service. The sample lives in memory; the view and `GET /usage` read it; the bus gets one
// `usage` event per sample. One sample is in flight at a time; the loop stops when no stack
// is up and `wake()` starts it again (the server calls it after a job and on a stack change).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cpus, freemem, loadavg, platform, totalmem } from "node:os";
import type {
    MachineUsage,
    ServiceUsage,
    SessionSummary,
    SessionUsage,
    StackSpec,
    UsageResponse,
} from "@spinner/protocol";
import { USAGE_INTERVAL_MS } from "@spinner/protocol";
import type { EventBus } from "../event-bus.js";
import { compose_project } from "./compose.js";
import { read_pid_files } from "./host-service.js";
import { run_ok } from "./shell.js";

/** Upper bound on processes one `ps` pass is expected to list; more means a runaway parse. */
const PROCESSES_MAX = 200_000;

/** Upper bound on the depth of a process tree walk; a deeper tree is a cycle in bad data. */
const TREE_DEPTH_MAX = 64;

/** One container as `docker ps` lists it, with its compose labels. */
export interface ContainerRef {
    id: string;
    project: string;
    service: string;
}

/** One process as `ps -axo pid,ppid,rss,%cpu` lists it; `rss_kib` is what ps prints. */
export interface ProcessRow {
    pid: number;
    ppid: number;
    rss_kib: number;
    cpu_pct: number;
}

export interface UsageSamplerInput {
    /** Sessions to look at. The sampler picks the ones with a stack up or starting. */
    sessions: () => { summary: SessionSummary; spec: StackSpec | null }[];
    bus: EventBus;
    now?: () => Date;
    log?: (line: string) => void;
    /** The probes, replaceable in tests. */
    containers?: () => Promise<ContainerRef[]>;
    stats?: () => Promise<Map<string, ServiceUsage>>;
    processes?: () => Promise<ProcessRow[]>;
    machine?: () => Omit<MachineUsage, "stacks_up" | "mem_sessions_bytes">;
}

export interface UsageSampler {
    get(dir: string): SessionUsage | null;
    /** `GET /usage`: the machine and every sampled stack. */
    response(): UsageResponse;
    /** One sample now, for a test or a job that wants fresh numbers. */
    sample(): Promise<void>;
    /** Starts the loop when it is stopped; a no-op while it runs. */
    wake(): void;
    stop(): void;
}

export function start_usage_sampler(
    input: UsageSamplerInput,
    interval_ms = USAGE_INTERVAL_MS,
): UsageSampler {
    assert.ok(interval_ms >= 100, "usage interval must be at least 100 ms");
    const now = input.now ?? (() => new Date());
    const log = input.log ?? (() => undefined);
    const containers = input.containers ?? list_containers;
    const stats = input.stats ?? container_stats;
    const processes = input.processes ?? list_processes;
    const machine = input.machine ?? machine_usage;
    const cache = new Map<string, SessionUsage>();
    let sampled: string | null = null;
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;
    let in_flight: Promise<void> | null = null;

    const live = (): { summary: SessionSummary; spec: StackSpec }[] => {
        const found: { summary: SessionSummary; spec: StackSpec }[] = [];
        for (const { summary, spec } of input.sessions()) {
            if (spec !== null && is_live(summary)) {
                found.push({ summary, spec });
            }
        }
        return found;
    };

    const sample_once = async (): Promise<void> => {
        const sessions = live();
        if (sessions.length === 0) {
            cache.clear();
            return;
        }
        const needs_docker = sessions.some(({ spec }) => has_containers(spec));
        const needs_ps = sessions.some(({ spec }) => has_host_services(spec));
        const [refs, by_container, rows] = await Promise.all([
            needs_docker ? containers() : Promise.resolve([]),
            needs_docker ? stats() : Promise.resolve(new Map<string, ServiceUsage>()),
            needs_ps ? processes() : Promise.resolve([]),
        ]);
        const tree = process_tree(rows);
        const ts = now().toISOString();
        const seen = new Set<string>();
        for (const { summary, spec } of sessions) {
            const pids = read_pid_files(summary.path);
            const usage = session_usage({
                project: compose_project(summary.session.id),
                spec,
                refs,
                by_container,
                tree,
                host_pids: Object.fromEntries(
                    Object.entries(pids).map(([name, identity]) => [name, identity.pid]),
                ),
                sampled: ts,
            });
            cache.set(summary.dir, usage);
            seen.add(summary.dir);
        }
        for (const dir of cache.keys()) {
            if (!seen.has(dir)) {
                cache.delete(dir);
            }
        }
        sampled = ts;
        input.bus.publish({
            type: "usage",
            ts,
            session: null,
            machine: machine_of(machine(), cache),
            sessions: Object.fromEntries(cache),
        });
    };

    const sample = (): Promise<void> => {
        if (in_flight !== null) {
            return in_flight;
        }
        in_flight = sample_once()
            .catch((error: unknown) => {
                log(`usage sample: ${error instanceof Error ? error.message : String(error)}`);
            })
            .finally(() => {
                in_flight = null;
            });
        return in_flight;
    };

    const tick = async (): Promise<void> => {
        timer = null;
        if (stopped) {
            return;
        }
        await sample();
        if (stopped) {
            return;
        }
        if (live().length === 0) {
            // Nothing is up: the loop ends here. `wake()` starts it again.
            cache.clear();
            return;
        }
        timer = setTimeout(() => void tick(), interval_ms);
    };

    const wake = (): void => {
        if (stopped || timer !== null || in_flight !== null) {
            return;
        }
        timer = setTimeout(() => void tick(), 0);
    };

    wake();
    return {
        get: (dir) => cache.get(dir) ?? null,
        response: () => ({
            machine: machine_of(machine(), cache),
            sessions: Object.fromEntries(cache),
            sampled,
        }),
        sample,
        wake,
        stop: () => {
            stopped = true;
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
        },
    };
}

function is_live(summary: SessionSummary): boolean {
    const state = summary.session.stack?.state;
    return state === "up" || state === "starting";
}

function has_containers(spec: StackSpec): boolean {
    return Object.values(spec.services).some((service) => service.runtime !== "host");
}

function has_host_services(spec: StackSpec): boolean {
    return Object.values(spec.services).some((service) => service.runtime === "host");
}

export interface SessionUsageInput {
    project: string;
    spec: StackSpec;
    refs: ContainerRef[];
    /** `docker stats` by container id (the long one `docker ps` lists under `.ID` is a prefix). */
    by_container: Map<string, ServiceUsage>;
    tree: ProcessTree;
    /** Host service name to its root pid, from `stack/pids/`. */
    host_pids: Record<string, number>;
    sampled: string;
}

/** Pure: one session's usage from the shared probes. A service without a sample is left out. */
export function session_usage(input: SessionUsageInput): SessionUsage {
    const services: Record<string, ServiceUsage> = {};
    for (const [name, service] of Object.entries(input.spec.services)) {
        if (service.runtime === "host") {
            const pid = input.host_pids[name];
            if (pid === undefined) {
                continue;
            }
            const usage = tree_usage(input.tree, pid);
            if (usage !== null) {
                services[name] = { ...usage, pid };
            }
            continue;
        }
        const ref = input.refs.find(
            (entry) => entry.project === input.project && entry.service === name,
        );
        if (ref === undefined) {
            continue;
        }
        const usage = stats_for(input.by_container, ref.id);
        if (usage !== undefined) {
            services[name] = { ...usage, container: ref.id };
        }
    }
    let cpu_pct = 0;
    let mem_bytes = 0;
    for (const usage of Object.values(services)) {
        cpu_pct += usage.cpu_pct;
        mem_bytes += usage.mem_bytes;
    }
    return {
        stack: { cpu_pct: round1(cpu_pct), mem_bytes, sampled: input.sampled },
        services,
    };
}

/** `docker stats` keys by the short id; `docker ps` gives the long one, or the other way. */
function stats_for(by_container: Map<string, ServiceUsage>, id: string): ServiceUsage | undefined {
    const direct = by_container.get(id);
    if (direct !== undefined) {
        return direct;
    }
    for (const [key, usage] of by_container) {
        if (id.startsWith(key) || key.startsWith(id)) {
            return usage;
        }
    }
    return undefined;
}

function machine_of(
    base: Omit<MachineUsage, "stacks_up" | "mem_sessions_bytes">,
    cache: Map<string, SessionUsage>,
): MachineUsage {
    let mem_sessions_bytes = 0;
    for (const usage of cache.values()) {
        mem_sessions_bytes += usage.stack.mem_bytes;
    }
    return { ...base, stacks_up: cache.size, mem_sessions_bytes };
}

function machine_usage(): Omit<MachineUsage, "stacks_up" | "mem_sessions_bytes"> {
    return {
        mem_total_bytes: totalmem(),
        mem_free_bytes: memory_available_bytes(),
        cpu_count: cpus().length,
        load_1m: round1(loadavg()[0] ?? 0),
    };
}

/**
 * Memory the stacks could still take. `os.freemem()` on macOS counts only the "free" pages
 * (1.4 GB of 52 GB on the operator's machine while 17 GB were reclaimable), so darwin reads
 * `vm_stat` and sums free, inactive and speculative pages; linux reads `MemAvailable` from
 * `/proc/meminfo`. `os.freemem()` stays the fallback when either is unreadable.
 */
export function memory_available_bytes(): number {
    if (platform() === "darwin") {
        const result = spawnSync("vm_stat", [], { encoding: "utf8" });
        if (result.status === 0) {
            const parsed = parse_vm_stat(String(result.stdout));
            if (parsed !== null) {
                return parsed;
            }
        }
    }
    if (platform() === "linux" && existsSync("/proc/meminfo")) {
        const parsed = parse_meminfo_available(readFileSync("/proc/meminfo", "utf8"));
        if (parsed !== null) {
            return parsed;
        }
    }
    return freemem();
}

/**
 * Pure: `vm_stat` output to (free + inactive + speculative) × page size, the page size from
 * the header line `Mach Virtual Memory Statistics: (page size of 16384 bytes)`. Null when the
 * header or the free count is missing.
 */
export function parse_vm_stat(out: string): number | null {
    const header = /page size of (\d+) bytes/.exec(out);
    if (header === null) {
        return null;
    }
    const page_size = Number.parseInt(header[1] ?? "", 10);
    const pages = (label: string): number | null => {
        const match = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.?$`, "m").exec(out);
        return match === null ? null : Number.parseInt(match[1] ?? "", 10);
    };
    const free = pages("free");
    if (free === null || !Number.isInteger(page_size) || page_size <= 0) {
        return null;
    }
    const inactive = pages("inactive") ?? 0;
    const speculative = pages("speculative") ?? 0;
    return (free + inactive + speculative) * page_size;
}

/** Pure: `/proc/meminfo` to `MemAvailable` in bytes (the file counts kB), or null. */
export function parse_meminfo_available(text: string): number | null {
    const match = /^MemAvailable:\s+(\d+)\s*kB$/m.exec(text);
    if (match === null) {
        return null;
    }
    return Number.parseInt(match[1] ?? "", 10) * 1_024;
}

// ---------------------------------------------------------------------------------------
// docker

/** `docker ps` with the compose labels, for every running container. */
async function list_containers(): Promise<ContainerRef[]> {
    const out = await run_ok("docker", [
        "ps",
        "--no-trunc",
        "--format",
        '{{.ID}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}',
    ]);
    return parse_container_list(out);
}

/** Pure: `id\tproject\tservice` lines to refs; a container without compose labels is dropped. */
export function parse_container_list(out: string): ContainerRef[] {
    const refs: ContainerRef[] = [];
    for (const line of out.split("\n")) {
        const [id, project, service] = line.split("\t");
        if (id === undefined || id.length === 0) {
            continue;
        }
        if (project === undefined || project.length === 0 || service === undefined) {
            continue;
        }
        if (service.length === 0) {
            continue;
        }
        refs.push({ id, project, service });
    }
    return refs;
}

/** `docker stats --no-stream` for every container, by container id. */
async function container_stats(): Promise<Map<string, ServiceUsage>> {
    const out = await run_ok("docker", [
        "stats",
        "--no-stream",
        "--no-trunc",
        "--format",
        "{{json .}}",
    ]);
    return parse_docker_stats(out);
}

interface StatsLine {
    Container?: string;
    ID?: string;
    CPUPerc?: string;
    MemUsage?: string;
    NetIO?: string;
    BlockIO?: string;
}

/**
 * Pure: one JSON object per line, as `docker stats --format '{{json .}}'` prints, to usage by
 * container id. `MemUsage` is `used / limit`, `NetIO` is `rx / tx`, `BlockIO` is `read /
 * write`. The limit is what docker prints: the container's own, or the engine's memory
 * (Docker Desktop's VM) for a container without one.
 */
export function parse_docker_stats(out: string): Map<string, ServiceUsage> {
    const by_container = new Map<string, ServiceUsage>();
    for (const line of out.split("\n")) {
        if (line.trim().length === 0) {
            continue;
        }
        let record: StatsLine;
        try {
            record = JSON.parse(line) as StatsLine;
        } catch {
            continue;
        }
        const id = record.Container ?? record.ID;
        if (id === undefined || id.length === 0) {
            continue;
        }
        const [mem_bytes, mem_limit_bytes] = parse_pair(record.MemUsage);
        const [net_rx_bytes, net_tx_bytes] = parse_pair(record.NetIO);
        const [block_read_bytes, block_write_bytes] = parse_pair(record.BlockIO);
        const usage: ServiceUsage = {
            cpu_pct: parse_percent(record.CPUPerc),
            mem_bytes,
            net_rx_bytes,
            net_tx_bytes,
            block_read_bytes,
            block_write_bytes,
        };
        if (mem_limit_bytes > 0) {
            usage.mem_limit_bytes = mem_limit_bytes;
        }
        by_container.set(id, usage);
    }
    return by_container;
}

/** `a / b` to two byte counts; a missing or unreadable half is 0. */
function parse_pair(text: string | undefined): [number, number] {
    if (text === undefined) {
        return [0, 0];
    }
    const [left, right] = text.split("/");
    return [parse_bytes(left ?? ""), parse_bytes(right ?? "")];
}

const UNITS: Record<string, number> = {
    b: 1,
    kb: 1_000,
    mb: 1_000_000,
    gb: 1_000_000_000,
    tb: 1_000_000_000_000,
    kib: 1_024,
    mib: 1_024 ** 2,
    gib: 1_024 ** 3,
    tib: 1_024 ** 4,
};

/** `190.7MiB`, `1.74kB`, `0B` to bytes, rounded. Docker uses both SI and IEC suffixes. */
export function parse_bytes(text: string): number {
    const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]*)\s*$/.exec(text);
    if (match === null) {
        return 0;
    }
    const value = Number(match[1]);
    const unit = (match[2] ?? "b").toLowerCase();
    const factor = UNITS[unit.length === 0 ? "b" : unit];
    if (factor === undefined) {
        return 0;
    }
    return Math.round(value * factor);
}

/** `4.29%` to 4.29; unreadable is 0. */
export function parse_percent(text: string | undefined): number {
    if (text === undefined) {
        return 0;
    }
    const value = Number.parseFloat(text.replace("%", "").trim());
    return Number.isFinite(value) ? value : 0;
}

// ---------------------------------------------------------------------------------------
// ps

/** `ps -axo pid=,ppid=,rss=,%cpu=`: every process, no header. */
async function list_processes(): Promise<ProcessRow[]> {
    const out = await run_ok("ps", ["-axo", "pid=,ppid=,rss=,%cpu="]);
    return parse_ps(out);
}

/** Pure: `ps` rows to numbers. `rss` is KiB on macOS and Linux. */
export function parse_ps(out: string): ProcessRow[] {
    const rows: ProcessRow[] = [];
    for (const line of out.split("\n")) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 4) {
            continue;
        }
        const pid = Number.parseInt(fields[0] ?? "", 10);
        const ppid = Number.parseInt(fields[1] ?? "", 10);
        const rss_kib = Number.parseInt(fields[2] ?? "", 10);
        const cpu_pct = Number.parseFloat(fields[3] ?? "");
        if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
            continue;
        }
        rows.push({
            pid,
            ppid,
            rss_kib: Number.isInteger(rss_kib) ? rss_kib : 0,
            cpu_pct: Number.isFinite(cpu_pct) ? cpu_pct : 0,
        });
        assert.ok(rows.length <= PROCESSES_MAX, "ps listed more processes than expected");
    }
    return rows;
}

export interface ProcessTree {
    rows: Map<number, ProcessRow>;
    children: Map<number, number[]>;
}

/** Pure: rows to a parent-to-children index. */
export function process_tree(rows: ProcessRow[]): ProcessTree {
    const by_pid = new Map<number, ProcessRow>();
    const children = new Map<number, number[]>();
    for (const row of rows) {
        by_pid.set(row.pid, row);
        const siblings = children.get(row.ppid) ?? [];
        siblings.push(row.pid);
        children.set(row.ppid, siblings);
    }
    return { rows: by_pid, children };
}

/**
 * Pure: the root and every descendant summed; null when the root is not in the tree (the
 * process is gone). Memory is the sum of RSS, so shared pages count once per process, as
 * Activity Monitor does.
 */
export function tree_usage(tree: ProcessTree, root: number): ServiceUsage | null {
    if (!tree.rows.has(root)) {
        return null;
    }
    let cpu_pct = 0;
    let rss_kib = 0;
    const seen = new Set<number>();
    let frontier = [root];
    for (let depth = 0; depth < TREE_DEPTH_MAX && frontier.length > 0; depth += 1) {
        const next: number[] = [];
        for (const pid of frontier) {
            if (seen.has(pid)) {
                continue;
            }
            seen.add(pid);
            const row = tree.rows.get(pid);
            if (row !== undefined) {
                cpu_pct += row.cpu_pct;
                rss_kib += row.rss_kib;
            }
            next.push(...(tree.children.get(pid) ?? []));
        }
        frontier = next;
    }
    return { cpu_pct: round1(cpu_pct), mem_bytes: rss_kib * 1_024 };
}

function round1(value: number): number {
    return Math.round(value * 10) / 10;
}
