// Daemon discovery. The app connects to a daemon on `localhost:7777`. When none answers at
// launch, it runs `spinner daemon start` from the checkout and polls `/health` for up to
// 30 s. After that the app never starts a daemon on its own: `spinner daemon stop` is the
// operator's, and a daemon that goes away is only polled until it answers again. The tray's
// "Start daemon" item is the one other way to start one. The class is pure: it takes the
// probe, the start command and the clock as functions so Vitest can drive it.
import assert from "node:assert/strict";
import type { BuildInfo, DaemonStatus, HealthResponse } from "@spinner/protocol";

export const START_WAIT_MS = 30_000;
export const START_POLL_MS = 500;
/** How often a lost daemon is probed until it answers again. */
export const RECONNECT_POLL_MS = 2_000;
export const HEALTH_TIMEOUT_MS = 2_000;

export interface DaemonLinkDeps {
    url: string;
    /** `GET /health`: the build when the daemon answers, null when it does not. */
    probe: () => Promise<BuildInfo | null>;
    /** Runs `spinner daemon start`; resolves when the command exits. */
    start: () => Promise<void>;
    sleep: (ms: number) => Promise<void>;
    start_wait_ms?: number;
    start_poll_ms?: number;
}

export type DaemonListener = (status: DaemonStatus) => void;

export class DaemonLink {
    private current: DaemonStatus;
    private readonly listeners = new Set<DaemonListener>();
    private readonly start_wait_ms: number;
    private readonly start_poll_ms: number;
    private starting = false;

    constructor(private readonly deps: DaemonLinkDeps) {
        this.current = { url: deps.url, state: "down", build: null };
        this.start_wait_ms = deps.start_wait_ms ?? START_WAIT_MS;
        this.start_poll_ms = deps.start_poll_ms ?? START_POLL_MS;
        assert.ok(this.start_poll_ms > 0);
        assert.ok(this.start_wait_ms >= this.start_poll_ms);
    }

    status(): DaemonStatus {
        return this.current;
    }

    subscribe(listener: DaemonListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** One probe. Moves to `connected` or `down`; never starts anything. */
    async check(): Promise<DaemonStatus> {
        const build = await this.deps.probe();
        if (build === null) {
            this.transition("down", null);
        } else {
            this.transition("connected", build);
        }
        return this.current;
    }

    /**
     * Probe; when nothing answers, start a daemon and poll until it does or the wait runs
     * out. A second call while a start is in flight only probes.
     */
    async ensure(): Promise<DaemonStatus> {
        const probed = await this.check();
        if (probed.state === "connected" || this.starting) {
            return probed;
        }
        this.starting = true;
        try {
            this.transition("starting", null);
            await this.deps.start();
            const polls_max = Math.ceil(this.start_wait_ms / this.start_poll_ms);
            for (let poll = 0; poll < polls_max; poll += 1) {
                const build = await this.deps.probe();
                if (build !== null) {
                    this.transition("connected", build);
                    return this.current;
                }
                await this.deps.sleep(this.start_poll_ms);
            }
            this.transition("down", null);
            return this.current;
        } catch (error) {
            this.transition("down", null);
            throw error;
        } finally {
            this.starting = false;
        }
    }

    /** The events socket closed: the daemon is gone until a probe answers. */
    lost(): void {
        if (this.current.state === "connected") {
            this.transition("down", null);
        }
    }

    private transition(state: DaemonStatus["state"], build: BuildInfo | null): void {
        assert.equal(build !== null, state === "connected", "only a connected daemon has a build");
        const unchanged = this.current.state === state && this.current.build === build;
        if (unchanged) {
            return;
        }
        this.current = { url: this.deps.url, state, build };
        for (const listener of this.listeners) {
            listener(this.current);
        }
    }
}

/** `GET /health` with a timeout. Any failure, including a non-2xx or a bad body, is null. */
export async function probe_health(
    url: string,
    fetch_fn: typeof fetch = fetch,
    timeout_ms = HEALTH_TIMEOUT_MS,
): Promise<BuildInfo | null> {
    try {
        const response = await fetch_fn(`${url}/health`, {
            signal: AbortSignal.timeout(timeout_ms),
        });
        if (!response.ok) {
            return null;
        }
        const body = (await response.json()) as Partial<HealthResponse>;
        if (body.ok !== true || body.build === undefined) {
            return null;
        }
        return body.build;
    } catch {
        return null;
    }
}
