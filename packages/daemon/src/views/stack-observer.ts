// Watches the services of every session whose stack is up: container health from `docker ps`
// by project label, host services by an HTTP probe on their port. The result is a cache the
// view reads; a change publishes `session.updated`, so the UI's state dots follow the stack
// without polling. The loop is intentionally unbounded; `stop()` is the only exit.
import assert from "node:assert/strict";
import type { ServiceStatus, SessionSummary, StackSpec } from "@spinner/protocol";
import type { ServiceStatus as DockerStatus } from "../stack/docker.js";
import { project_status } from "../stack/docker.js";
import { host_answers } from "../stack/host-service.js";
import type { StackObservation } from "./session-view.js";

/** How often the observer looks. Docker probes every 250 ms; `docker ps` costs ~0.3 s. */
export const OBSERVE_INTERVAL_MS = 5_000;

export interface ObserverInput {
    /** Sessions to look at. The observer picks the ones with a stack up or starting. */
    sessions: () => { summary: SessionSummary; spec: StackSpec | null }[];
    /** Called for each session whose statuses changed since the last round. */
    on_change: (dir: string, observation: StackObservation) => void;
    now?: () => Date;
    /** The docker and HTTP probes, replaceable in tests. */
    docker?: (project: string) => Promise<DockerStatus[]>;
    answers?: (port: number, path: string) => Promise<boolean>;
}

export interface StackObserver {
    get(dir: string): StackObservation | null;
    /** One round now, for a test or for a job that wants fresh facts. */
    round(): Promise<void>;
    stop(): void;
}

export function start_stack_observer(input: ObserverInput, interval_ms: number): StackObserver {
    assert.ok(interval_ms >= 100, "observe interval must be at least 100 ms");
    const now = input.now ?? (() => new Date());
    const docker = input.docker ?? project_status;
    const answers = input.answers ?? host_answers;
    const cache = new Map<string, StackObservation>();
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;
    let in_round: Promise<void> | null = null;

    const round = async (): Promise<void> => {
        const seen = new Set<string>();
        for (const { summary, spec } of input.sessions()) {
            if (spec === null || !is_live(summary)) {
                continue;
            }
            seen.add(summary.dir);
            const observation = await observe_stack(summary, spec, { docker, answers, now });
            const before = cache.get(summary.dir);
            cache.set(summary.dir, observation);
            if (before === undefined || !same_statuses(before.statuses, observation.statuses)) {
                input.on_change(summary.dir, observation);
            }
        }
        for (const dir of cache.keys()) {
            if (!seen.has(dir)) {
                cache.delete(dir);
            }
        }
    };
    const tick = async (): Promise<void> => {
        in_round = round();
        try {
            await in_round;
        } finally {
            in_round = null;
        }
        if (!stopped) {
            timer = setTimeout(() => void tick(), interval_ms);
        }
    };
    void tick();
    return {
        get: (dir) => cache.get(dir) ?? null,
        round: async () => {
            if (in_round !== null) {
                await in_round;
                return;
            }
            await round();
        },
        stop: () => {
            stopped = true;
            if (timer !== null) {
                clearTimeout(timer);
            }
        },
    };
}

function is_live(summary: SessionSummary): boolean {
    const state = summary.session.stack.state;
    return state === "up" || state === "starting" || state === "failed";
}

interface Probes {
    docker: (project: string) => Promise<DockerStatus[]>;
    answers: (port: number, path: string) => Promise<boolean>;
    now: () => Date;
}

/** One observation of one session: every service of the spec gets a status. */
export async function observe_stack(
    summary: SessionSummary,
    spec: StackSpec,
    probes: Probes,
): Promise<StackObservation> {
    const stack = summary.session.stack;
    const has_containers = Object.values(spec.services).some((s) => s.runtime !== "host");
    const project = stack.project;
    const docker = has_containers && project !== undefined ? await probes.docker(project) : [];
    const statuses: Record<string, ServiceStatus> = {};
    for (const [name, service] of Object.entries(spec.services)) {
        if (service.runtime === "host") {
            const process = stack.processes?.[name];
            if (process === undefined) {
                statuses[name] = "stopped";
                continue;
            }
            const path = health_path(service.healthcheck ?? "GET /");
            statuses[name] = (await probes.answers(process.port, path)) ? "healthy" : "starting";
            continue;
        }
        const row = docker.find((status) => status.name === name);
        statuses[name] = container_status(row, service.healthcheck !== undefined);
    }
    return { observed: probes.now().toISOString(), statuses };
}

/** Pure: a `docker ps` row into a service status. */
export function container_status(row: DockerStatus | undefined, checked: boolean): ServiceStatus {
    if (row === undefined || row.state !== "running") {
        return "stopped";
    }
    if (row.health === "healthy") {
        return "healthy";
    }
    if (row.health === "unhealthy") {
        return "unhealthy";
    }
    return checked ? "starting" : "unknown";
}

function health_path(check: string): string {
    return check.replace(/^GET\s+/, "");
}

type Statuses = Record<string, ServiceStatus>;

function same_statuses(a: Statuses, b: Statuses): boolean {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) {
        return false;
    }
    return keys.every((key) => a[key] === b[key]);
}
