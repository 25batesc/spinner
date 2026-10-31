// Goal: the usage sampler turns `docker stats` lines and a `ps` listing into bytes and
// per-core percentages per service, attributes a host service's whole process tree to it,
// sums a stack, publishes one `usage` event per sample, idles when no stack is up, and
// `GET /usage` answers the machine with no stack. Method: fixtures of the two commands'
// output, pure calls, a sampler with stubbed probes, and a daemon on port 0.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionSummary, SpinnerEvent, StackSpec, UsageResponse } from "@spinner/protocol";
import { EventBus } from "../event-bus.js";
import { resolve_home } from "../home.js";
import { start_daemon } from "../server.js";
import { build_stack } from "../views/session-view.js";
import {
    memory_available_bytes,
    parse_bytes,
    parse_container_list,
    parse_docker_stats,
    parse_meminfo_available,
    parse_percent,
    parse_ps,
    parse_vm_stat,
    process_tree,
    session_usage,
    start_usage_sampler,
    tree_usage,
} from "./usage.js";

const API_ID = "d4a03c8e8fb154d805793eedb5fb143c9d3d64d17c9129bf10a2219faddbafbb";

const STATS_LINES = [
    `{"BlockIO":"55.5MB / 61.6MB","CPUPerc":"0.00%","Container":"${API_ID}",` +
        '"ID":"d4a03c8e8fb1","MemPerc":"2.43%","MemUsage":"190.7MiB / 7.652GiB",' +
        '"Name":"spinner-s017-api-1","NetIO":"1.74kB / 126B","PIDs":"11"}',
    '{"BlockIO":"0B / 0B","CPUPerc":"104.29%","Container":"93390808da1d3e675b8594eb4827ca7e",' +
        '"ID":"93390808da1d","MemPerc":"1.19%","MemUsage":"93.27MiB / 512MiB",' +
        '"Name":"spinner-s017-worker-1","NetIO":"1.86kB / 126B","PIDs":"12"}',
    "not json",
    "",
].join("\n");

const PS = [
    "    1     0  25152   0.7",
    " 4000     1  10240   1.5",
    " 4001  4000   2048   0.5",
    " 4002  4001   1024  10.0",
    " 5000     1   4096   3.0",
    "garbage line",
    "",
].join("\n");

const spec: StackSpec = {
    name: "sample",
    base: "main",
    repos: { app: { path: "/repo" } },
    services: {
        api: { port: 3000, host: "api" },
        worker: { port: 3001 },
        backend: { port: 8000, host: "backend", runtime: "host" },
    },
};

function summary(path: string, state: "up" | "down"): SessionSummary {
    return {
        dir: "s017-x",
        path,
        session: {
            version: 1,
            id: "s017",
            slug: "x",
            title: "x",
            created: "2026-10-28T13:00:00Z",
            stage: "building",
            needs_human: null,
            branch: "feat/x",
            base: "main",
            repos: {},
            stack: { state, project: "spinner-s017" },
            agents: {},
        },
    };
}

describe("docker stats parsing", () => {
    it("reads bytes in SI and IEC units and percentages", () => {
        expect(parse_bytes("0B")).toBe(0);
        expect(parse_bytes("1.74kB")).toBe(1_740);
        expect(parse_bytes("55.5MB")).toBe(55_500_000);
        expect(parse_bytes("190.7MiB")).toBe(Math.round(190.7 * 1_048_576));
        expect(parse_bytes("7.652GiB")).toBe(Math.round(7.652 * 1_073_741_824));
        expect(parse_bytes("weird")).toBe(0);
        expect(parse_percent("4.29%")).toBe(4.29);
        expect(parse_percent(undefined)).toBe(0);
    });

    it("maps each json line to a service usage by container id, skipping bad lines", () => {
        const by_container = parse_docker_stats(STATS_LINES);
        expect([...by_container.keys()]).toEqual([API_ID, "93390808da1d3e675b8594eb4827ca7e"]);
        const api = by_container.get(API_ID);
        expect(api).toEqual({
            cpu_pct: 0,
            mem_bytes: Math.round(190.7 * 1_048_576),
            mem_limit_bytes: Math.round(7.652 * 1_073_741_824),
            net_rx_bytes: 1_740,
            net_tx_bytes: 126,
            block_read_bytes: 55_500_000,
            block_write_bytes: 61_600_000,
        });
        // The limit is what docker prints, the container's own here.
        const worker = by_container.get("93390808da1d3e675b8594eb4827ca7e");
        expect(worker?.cpu_pct).toBe(104.29);
        expect(worker?.mem_limit_bytes).toBe(512 * 1_048_576);
    });

    it("reads the container list with compose labels and drops unlabeled containers", () => {
        const refs = parse_container_list(
            ["abc\tspinner-s017\tapi", "def\t\t", "ghi\tspinner-s017\tworker", ""].join("\n"),
        );
        expect(refs).toEqual([
            { id: "abc", project: "spinner-s017", service: "api" },
            { id: "ghi", project: "spinner-s017", service: "worker" },
        ]);
    });
});

describe("available memory", () => {
    // Real `vm_stat` output from the operator's machine (52 GB, 16 KiB pages).
    const VM_STAT = [
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
        "Pages free:                                    61128.",
        "Pages active:                                 999498.",
        "Pages inactive:                               997924.",
        "Pages speculative:                              1019.",
        "Pages throttled:                                   0.",
        "Pages wired down:                             310472.",
        "",
    ].join("\n");

    it("sums free, inactive and speculative pages at the header's page size", () => {
        expect(parse_vm_stat(VM_STAT)).toBe((61_128 + 997_924 + 1_019) * 16_384);
        expect(parse_vm_stat("Pages free: 10.")).toBeNull();
        const header_only = "Mach Virtual Memory Statistics: (page size of 4096 bytes)";
        expect(parse_vm_stat(header_only)).toBeNull();
    });

    it("reads MemAvailable from /proc/meminfo in kB", () => {
        const meminfo = "MemTotal:       16000000 kB\nMemFree:         1000000 kB\n" +
            "MemAvailable:    9000000 kB\nBuffers:          200000 kB\n";
        expect(parse_meminfo_available(meminfo)).toBe(9_000_000 * 1_024);
        expect(parse_meminfo_available("MemTotal: 1 kB\n")).toBeNull();
    });

    it("answers a positive number at most the machine's memory on this host", () => {
        const available = memory_available_bytes();
        expect(available).toBeGreaterThan(0);
        expect(available).toBeLessThanOrEqual(totalmem());
    });
});

describe("ps parsing and process trees", () => {
    it("reads pid, ppid, rss and %cpu and skips garbage", () => {
        const rows = parse_ps(PS);
        expect(rows).toHaveLength(5);
        expect(rows[1]).toEqual({ pid: 4000, ppid: 1, rss_kib: 10_240, cpu_pct: 1.5 });
    });

    it("attributes the root and its descendants, not a sibling; a gone root is null", () => {
        const tree = process_tree(parse_ps(PS));
        expect(tree_usage(tree, 4000)).toEqual({
            cpu_pct: 12,
            mem_bytes: (10_240 + 2_048 + 1_024) * 1_024,
        });
        expect(tree_usage(tree, 4002)).toEqual({ cpu_pct: 10, mem_bytes: 1_024 * 1_024 });
        expect(tree_usage(tree, 9999)).toBeNull();
    });
});

describe("session_usage", () => {
    it("joins containers by project and service, host services by pid, and sums the stack", () => {
        const usage = session_usage({
            project: "spinner-s017",
            spec,
            refs: parse_container_list(
                [
                    `${API_ID}\tspinner-s017\tapi`,
                    "93390808da1d3e675b8594eb4827ca7e\tspinner-s017\tworker",
                    "zzz\tspinner-s018\tapi",
                ].join("\n"),
            ),
            by_container: parse_docker_stats(STATS_LINES),
            tree: process_tree(parse_ps(PS)),
            host_pids: { backend: 4000 },
            sampled: "2026-10-29T22:00:00.000Z",
        });
        expect(Object.keys(usage.services).sort()).toEqual(["api", "backend", "worker"]);
        expect(usage.services["backend"]).toEqual({
            cpu_pct: 12,
            mem_bytes: 13_312 * 1_024,
            pid: 4000,
        });
        expect(usage.services["api"]?.container).toBe(API_ID);
        expect(usage.stack).toEqual({
            cpu_pct: 116.3,
            mem_bytes:
                Math.round(190.7 * 1_048_576) + Math.round(93.27 * 1_048_576) + 13_312 * 1_024,
            sampled: "2026-10-29T22:00:00.000Z",
        });
    });

    it("leaves out a service without a sample and a host service without a pid", () => {
        const usage = session_usage({
            project: "spinner-s017",
            spec,
            refs: [],
            by_container: new Map(),
            tree: process_tree([]),
            host_pids: {},
            sampled: "t",
        });
        expect(usage.services).toEqual({});
        expect(usage.stack).toEqual({ cpu_pct: 0, mem_bytes: 0, sampled: "t" });
    });
});

describe("the sampler", () => {
    let root: string | null = null;

    afterEach(() => {
        if (root !== null) {
            rmSync(root, { recursive: true, force: true });
            root = null;
        }
    });

    it("samples live stacks with the probes, publishes usage, idles when none is up", async () => {
        root = mkdtempSync(join(tmpdir(), "spinner-usage-"));
        mkdirSync(join(root, "stack", "pids"), { recursive: true });
        writeFileSync(join(root, "stack", "pids", "backend.pid"), "4000 Thu Oct 29\n");
        let state: "up" | "down" = "up";
        let probes = 0;
        const bus = new EventBus();
        const events: SpinnerEvent[] = [];
        bus.subscribe((event) => events.push(event));
        const sampler = start_usage_sampler(
            {
                sessions: () => [{ summary: summary(root ?? "", state), spec }],
                bus,
                now: () => new Date("2026-10-29T22:00:00.000Z"),
                containers: async () => {
                    probes += 1;
                    return parse_container_list(`${API_ID}\tspinner-s017\tapi`);
                },
                stats: async () => parse_docker_stats(STATS_LINES),
                processes: async () => parse_ps(PS),
                machine: () => ({
                    mem_total_bytes: 16e9,
                    mem_free_bytes: 4e9,
                    cpu_count: 8,
                    load_1m: 2.5,
                }),
            },
            100,
        );
        await sampler.sample();
        const usage = sampler.get("s017-x");
        expect(usage?.stack).toEqual({
            cpu_pct: 12,
            mem_bytes: Math.round(190.7 * 1_048_576) + 13_312 * 1_024,
            sampled: "2026-10-29T22:00:00.000Z",
        });
        expect(usage?.services["worker"]).toBeUndefined();
        const published = events.filter((event) => event.type === "usage");
        expect(published).toHaveLength(1);
        expect(published[0]).toMatchObject({
            type: "usage",
            session: null,
            machine: { cpu_count: 8, stacks_up: 1, mem_sessions_bytes: usage?.stack.mem_bytes },
            sessions: { "s017-x": usage },
        });
        const response: UsageResponse = sampler.response();
        expect(response.sampled).toBe("2026-10-29T22:00:00.000Z");
        expect(response.machine.load_1m).toBe(2.5);

        // The view carries the sample on the stack and on each service.
        const view = build_stack(summary(root, "up"), spec, null, usage);
        expect(view.usage).toEqual(usage?.stack);
        expect(view.services.find((s) => s.name === "backend")?.usage?.pid).toBe(4000);
        expect(view.services.find((s) => s.name === "worker")?.usage).toBeNull();

        // Down: the cache empties, no probe runs, no event is published.
        state = "down";
        const before = probes;
        await sampler.sample();
        expect(probes).toBe(before);
        expect(sampler.get("s017-x")).toBeNull();
        expect(events.filter((event) => event.type === "usage")).toHaveLength(1);
        expect(sampler.response().machine.stacks_up).toBe(0);
        sampler.stop();
    });
});

describe("GET /usage through the daemon", () => {
    it("answers the machine with no stack up", async () => {
        const root = mkdtempSync(join(tmpdir(), "spinner-usage-route-"));
        const home = resolve_home({ SPINNER_HOME: join(root, "home") });
        mkdirSync(home.root, { recursive: true });
        const daemon = await start_daemon({
            home,
            port: 0,
            operator: false,
            log: () => undefined,
            poll_seconds: 0,
            notify: async () => undefined,
            ui_dir: null,
            observe_interval_ms: 60_000,
            usage_interval_ms: 60_000,
            pi: "/bin/false",
            cwd: root,
        });
        try {
            const response = await fetch(`http://127.0.0.1:${daemon.port}/usage`);
            expect(response.status).toBe(200);
            const body = (await response.json()) as UsageResponse;
            expect(body.sessions).toEqual({});
            expect(body.sampled).toBeNull();
            expect(body.machine.cpu_count).toBeGreaterThan(0);
            expect(body.machine.mem_total_bytes).toBeGreaterThan(body.machine.mem_free_bytes);
            expect(body.machine.stacks_up).toBe(0);
        } finally {
            await daemon.close();
            rmSync(root, { recursive: true, force: true });
        }
    });
});
