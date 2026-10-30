import type { MachineUsage, ServiceUsage } from "@spinner/protocol";
import { describe, expect, it } from "vitest";

import {
    formatBytes,
    ioCell,
    machineLine,
    memoryCell,
    memoryLow,
    processCell,
    shareLine,
    stackLine,
} from "./usage.ts";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const machine: MachineUsage = {
    mem_total_bytes: 32 * GB, mem_free_bytes: 22.2 * GB, cpu_count: 10, load_1m: 2.3,
    stacks_up: 3, mem_sessions_bytes: 4 * GB,
};

const container: ServiceUsage = {
    cpu_pct: 14.4, mem_bytes: 3.4 * MB, mem_limit_bytes: 512 * MB,
    net_rx_bytes: 12 * 1024, net_tx_bytes: 3.4 * MB, block_read_bytes: 0,
    block_write_bytes: 1.2 * MB, container: "9f3c2a1b7d6e4f5a",
};

const host: ServiceUsage = { cpu_pct: 3, mem_bytes: 3.4 * MB, pid: 44823 };

describe("the usage lines", () => {
    it("prints a stack as GB with one decimal and a whole percent", () => {
        const stack = { mem_bytes: 1.2 * GB, cpu_pct: 14.4, sampled: "t" };
        expect(stackLine(stack)).toBe("1.2 GB · 14 %");
    });

    it("prints the machine line from total and free, a whole total without a decimal", () => {
        expect(machineLine(machine)).toBe("machine 9.8 / 32 GB · 3 stacks up");
        const odd = { ...machine, mem_total_bytes: 16.5 * GB, mem_free_bytes: 6.7 * GB };
        expect(machineLine({ ...odd, stacks_up: 1 })).toBe("machine 9.8 / 16.5 GB · 1 stack up");
    });

    it("flags free memory under 10 %", () => {
        expect(memoryLow(machine)).toBe(false);
        expect(memoryLow({ ...machine, mem_free_bytes: 3 * GB })).toBe(true);
    });

    it("prints compact bytes", () => {
        expect(formatBytes(512)).toBe("512 B");
        expect(formatBytes(12 * 1024)).toBe("12 kB");
        expect(formatBytes(3.4 * MB)).toBe("3.4 MB");
        expect(formatBytes(1.2 * GB)).toBe("1.2 GB");
        expect(formatBytes(0)).toBe("0 B");
    });

    it("prints the table cells for a container and a host service", () => {
        expect(memoryCell(container)).toBe("3.4 MB / 512 MB");
        expect(ioCell(container)).toBe("net ↓12 kB ↑3.4 MB · disk r 0 B w 1.2 MB");
        expect(processCell(container)).toBe("9f3c2a1b7d6e");
        expect(memoryCell(host)).toBe("3.4 MB");
        expect(ioCell(host)).toBe("—");
        expect(processCell(host)).toBe("pid 44823");
    });

    it("prints the share line above the table", () => {
        const stack = { mem_bytes: 1.6 * GB, cpu_pct: 14, sampled: "t" };
        expect(shareLine(machine, stack)).toBe(
            "machine 9.8 / 32 GB · 3 stacks up · this session 1.6 GB · 14 % (5.0 % of memory)",
        );
    });
});
