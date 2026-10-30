// Resource usage at a glance: how the UI prints the daemon's samples (`MachineUsage`,
// `StackUsage`, `ServiceUsage` in `@spinner/protocol`). The `usage` event carries the machine
// and each up session's stack total and services; a `SessionView` carries the last sample on
// its stack and services too, for a page that loads before the next one.
import type {
    MachineUsage,
    ServiceUsage,
    ServiceView,
    SessionView,
    StackUsage,
    UsageResponse,
} from "@spinner/protocol";

/** The latest sample the UI holds: `GET /usage` at load, then every `usage` event. */
export type UsageSample = Pick<UsageResponse, "machine" | "sessions">;

/** Free memory under this share of the total paints the machine line red. */
export const MEMORY_LOW_SHARE = 0.1;

const GB = 1024 ** 3;

/**
 * This session's stack total: the latest sample first, else what its `SessionView` carries.
 * Nothing while the stack is not up.
 */
export function stackUsageOf(view: SessionView, latest: UsageSample | null): StackUsage | null {
    if (view.stack.state !== "up") {
        return null;
    }
    return latest?.sessions[view.summary.dir]?.stack ?? view.stack.usage ?? null;
}

/** One service's sample: the latest event first, else what its `ServiceView` carries. */
export function serviceUsageOf(
    view: SessionView,
    service: ServiceView,
    latest: UsageSample | null,
): ServiceUsage | null {
    if (view.stack.state !== "up") {
        return null;
    }
    return latest?.sessions[view.summary.dir]?.services[service.name] ?? service.usage ?? null;
}

/** Gigabytes with one decimal: `1.2 GB`. */
export function formatGb(bytes: number): string {
    return `${(bytes / GB).toFixed(1)} GB`;
}

/** A whole percent: `14 %`. Docker and ps count per core, so 200 means two cores busy. */
export function formatPercent(percent: number): string {
    return `${Math.round(percent)} %`;
}

/** Compact bytes: `512 B`, `12 kB`, `3.4 MB`, `1.2 GB`; one decimal under 10. */
export function formatBytes(bytes: number): string {
    const units = ["B", "kB", "MB", "GB", "TB"];
    let value = Math.max(0, bytes);
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const digits = unit === 0 ? 0 : value < 10 ? 1 : 0;
    return `${value.toFixed(digits)} ${units[unit]}`;
}

/** The card's and the context bar's line for a stack: `1.2 GB · 14 %`. */
export function stackLine(usage: StackUsage): string {
    return `${formatGb(usage.mem_bytes)} · ${formatPercent(usage.cpu_pct)}`;
}

/** `machine 9.8 / 32 GB · 3 stacks up`; the total drops its decimal when it is whole. */
export function machineLine(machine: MachineUsage): string {
    const total = machine.mem_total_bytes / GB;
    const totalText = Number.isInteger(total) ? String(total) : total.toFixed(1);
    const used = ((machine.mem_total_bytes - machine.mem_free_bytes) / GB).toFixed(1);
    const stacks = machine.stacks_up === 1 ? "1 stack up" : `${machine.stacks_up} stacks up`;
    return `machine ${used} / ${totalText} GB · ${stacks}`;
}

/** True when free memory is under `MEMORY_LOW_SHARE` of the total. */
export function memoryLow(machine: MachineUsage): boolean {
    return machine.mem_free_bytes < machine.mem_total_bytes * MEMORY_LOW_SHARE;
}

/** The table's memory cell: `used / limit` for a container with a limit, else `used`. */
export function memoryCell(usage: ServiceUsage): string {
    const used = formatBytes(usage.mem_bytes);
    return usage.mem_limit_bytes === undefined
        ? used
        : `${used} / ${formatBytes(usage.mem_limit_bytes)}`;
}

/** The table's i/o cell: `net ↓12 kB ↑3.4 MB · disk r 0 B w 1.2 MB`; `—` for a host service. */
export function ioCell(usage: ServiceUsage): string {
    const parts: string[] = [];
    if (usage.net_rx_bytes !== undefined || usage.net_tx_bytes !== undefined) {
        const rx = formatBytes(usage.net_rx_bytes ?? 0);
        const tx = formatBytes(usage.net_tx_bytes ?? 0);
        parts.push(`net ↓${rx} ↑${tx}`);
    }
    if (usage.block_read_bytes !== undefined || usage.block_write_bytes !== undefined) {
        const read = formatBytes(usage.block_read_bytes ?? 0);
        const write = formatBytes(usage.block_write_bytes ?? 0);
        parts.push(`disk r ${read} w ${write}`);
    }
    return parts.length === 0 ? "—" : parts.join(" · ");
}

/** The table's process cell: `pid 44823` for a host service, the container's short id. */
export function processCell(usage: ServiceUsage): string {
    if (usage.pid !== undefined) {
        return `pid ${usage.pid}`;
    }
    return usage.container === undefined ? "" : usage.container.slice(0, 12);
}

/** The line above the services table: the machine totals and this session's share. */
export function shareLine(machine: MachineUsage, stack: StackUsage): string {
    const share =
        machine.mem_total_bytes === 0 ? 0 : (stack.mem_bytes / machine.mem_total_bytes) * 100;
    const own = `this session ${stackLine(stack)} (${share.toFixed(1)} % of memory)`;
    return `${machineLine(machine)} · ${own}`;
}
