// The operator agent (MISSION.md s013): one tty pi per home under `<home>/operator/`, with
// no session of its own. The daemon starts it after `adopt_all` when `settings.operator.
// enabled` is true, resumes it on restart on the same transcript (`--session-id operator`),
// and stops or starts it on `POST /operator/stop|start`. It reuses `PiTtyHarness.spawn_pty`
// and the extension channel; the extension runs in role `operator` with the home's
// `operator/` directory as its session directory and talks to `/operator/*`. The host also
// turns bus events the operator must hear about (`needs_human` set, `agent.settled`,
// `agent.exited`, a failed job, an inbox message to `operator`) into one `notify` per second
// at most, each line prefixed with the session directory. Notices wait while the agent is
// stopped and go out when it starts.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OperatorNotice, OperatorView, Settings, SpinnerEvent } from "@spinner/protocol";
import type { EventBus } from "../event-bus.js";
import type { SpinnerHome } from "../home.js";
import { is_spinner_leader, process_start_time } from "../stack/host-service.js";
import { ensure_operator_brief } from "../store/operator-brief.js";
import { pi_spawn_plan, type AgentHandle, type PiHarnessOptions } from "./harness.js";
import type { PiTtyHarness, TtyAgent } from "./tty-harness.js";

/** The key under which the harness holds the operator's pty; no session key has no slash. */
export const OPERATOR_KEY = "operator";

export const OPERATOR_NAME = "operator";

/** Notices are batched for this long after the first one, so a burst is one `notify`. */
export const NOTICE_BATCH_MS = 1_000;

/** Lines waiting for the agent. Past this the oldest go and the notice says how many. */
export const NOTICES_MAX = 100;

/** Time a leftover pi from the previous daemon gets after SIGTERM before SIGKILL. */
const LEFTOVER_STOP_GRACE_MS = 5_000;

export interface OperatorHostOptions {
    home: SpinnerHome;
    tty: PiTtyHarness;
    harness_options: PiHarnessOptions;
    bus: EventBus;
    /** The operator's `settings.yaml`, read at each start. */
    settings: () => Settings;
    log?: (line: string) => void;
    now?: () => Date;
    /** For tests: a shorter batch window. */
    batch_ms?: number;
}

/** `<home>/operator/process.json`: who ran last, so a restart can stop a leftover pi. */
interface ProcessRecord {
    pid: number;
    started: string | null;
}

export class OperatorHost {
    readonly dir: string;
    private agent: TtyAgent | null = null;
    private model: string | null = null;
    private busy = false;
    private readonly queue: string[] = [];
    private dropped = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private last_notice: OperatorNotice | null = null;
    private readonly needs_human = new Map<string, string | null>();
    private readonly unsubscribe: () => void;
    private readonly log: (line: string) => void;
    private readonly now: () => Date;
    private readonly batch_ms: number;

    constructor(private readonly options: OperatorHostOptions) {
        this.dir = join(options.home.root, "operator");
        this.log = options.log ?? (() => undefined);
        this.now = options.now ?? (() => new Date());
        this.batch_ms = options.batch_ms ?? NOTICE_BATCH_MS;
        this.unsubscribe = options.bus.subscribe((event) => this.on_event(event));
    }

    /** True when the daemon would start the agent at boot. */
    get enabled(): boolean {
        return this.options.settings().operator?.enabled ?? true;
    }

    get running(): boolean {
        return this.agent !== null;
    }

    /**
     * The pty, for the `/operator/tty` upgrade and the extension routes; null when stopped.
     * From the harness, not `this.agent`: the extension posts `hello` while `start` still
     * waits for it.
     */
    tty(): TtyAgent | null {
        return this.options.tty.lookup_key(OPERATOR_KEY);
    }

    handle(): AgentHandle | null {
        return this.agent?.handle ?? null;
    }

    view(): OperatorView {
        const process_ = this.agent === null ? "exited" : this.busy ? "running" : "idle";
        return {
            enabled: this.enabled,
            process: process_,
            ready: this.agent !== null && this.agent.channel.hello !== null,
            pid: this.agent?.pid ?? null,
            model: this.model,
            dir: this.dir,
            waiting_on: waiting_on_of(process_),
            last_notice: this.last_notice,
            notices_pending: this.queue.length,
        };
    }

    /** At daemon boot: starts the agent when enabled. A failed start is logged, not fatal. */
    async start_if_enabled(): Promise<boolean> {
        if (!this.enabled) {
            return false;
        }
        try {
            await this.start();
            return true;
        } catch (error) {
            this.log(`operator: start failed: ${describe(error)}`);
            return false;
        }
    }

    /**
     * Starts pi in `<home>/operator`, or resumes its transcript: `--session-id operator`
     * opens the one there. Throws when it runs already or pi fails to start. A pi the
     * previous daemon left is stopped first when its identity still matches.
     */
    async start(): Promise<OperatorView> {
        if (this.agent !== null) {
            throw new Error("the operator agent is already running");
        }
        assert.ok(existsSync(this.options.home.root), `${this.options.home.root} does not exist`);
        await this.stop_leftover();
        const settings = this.options.settings();
        const model = settings.operator?.model ?? settings.default_model;
        const spawn = pi_spawn_plan(
            {
                name: OPERATOR_NAME,
                cwd: this.options.home.root,
                model,
                role: "operator",
                brief: ensure_operator_brief(this.dir),
                pi_dir: join(this.dir, "pi"),
                session_dir: this.dir,
            },
            this.options.harness_options,
        );
        const agent = await this.options.tty.spawn_pty(OPERATOR_KEY, OPERATOR_NAME, spawn);
        this.agent = agent;
        this.model = spawn.model ?? null;
        this.busy = false;
        write_process_record(this.dir, { pid: agent.pid, started: process_start_time(agent.pid) });
        void agent.channel.wait_hello().then(
            () => this.publish(),
            () => undefined,
        );
        agent.channel.on_event((event) => {
            if (event.type === "agent_start") {
                this.busy = true;
                this.publish();
            }
            if (event.type === "agent_settled") {
                this.busy = false;
                this.publish();
            }
        });
        void agent.exited.then((code) => {
            if (this.agent !== agent) {
                return;
            }
            this.agent = null;
            this.busy = false;
            remove_process_record(this.dir);
            this.log(`operator: pi exited with ${code ?? "a signal"}`);
            this.publish();
        });
        this.log(`operator: started pi ${agent.pid} in ${this.options.home.root}`);
        this.publish();
        if (this.queue.length > 0) {
            this.schedule();
        }
        return this.view();
    }

    /** Stops the process; the transcript stays. Throws when it does not run. */
    async stop(): Promise<OperatorView> {
        const agent = this.agent;
        if (agent === null) {
            throw new Error("the operator agent is not running");
        }
        await agent.stop();
        await agent.exited;
        return this.view();
    }

    /** For daemon shutdown: stops the agent when it runs and leaves the bus. */
    async close(): Promise<void> {
        this.unsubscribe();
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.agent !== null) {
            await this.agent.stop();
        }
    }

    /** Queues one notice line; the batch goes out within `batch_ms` when the agent runs. */
    notice(line: string): void {
        assert.ok(line.length > 0, "a notice line must not be empty");
        assert.ok(!line.includes("\n"), "a notice line is one line");
        if (this.queue.length >= NOTICES_MAX) {
            this.queue.shift();
            this.dropped += 1;
        }
        this.queue.push(line);
        this.schedule();
    }

    private on_event(event: SpinnerEvent): void {
        const line = notice_line(event, this.needs_human);
        if (line !== null) {
            this.notice(line);
        }
    }

    private schedule(): void {
        if (this.timer !== null || this.agent === null) {
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush();
        }, this.batch_ms);
    }

    private async flush(): Promise<void> {
        const agent = this.agent;
        if (agent === null || this.queue.length === 0) {
            return;
        }
        const batch = this.queue.splice(0, this.queue.length);
        const dropped = this.dropped;
        this.dropped = 0;
        const text = render_notice(batch, dropped);
        try {
            await agent.channel.enqueue("notify", text);
            this.last_notice = { ts: this.now().toISOString(), text };
            this.publish();
        } catch (error) {
            // The extension is away (pi still at a startup notice, or gone); the lines wait.
            this.log(`operator: notice not delivered, kept: ${describe(error)}`);
            this.queue.unshift(...batch);
            this.dropped += dropped;
            this.schedule();
        }
    }

    private publish(): void {
        this.options.bus.publish({
            type: "operator.updated",
            ts: this.now().toISOString(),
            session: null,
            data: this.view(),
        });
    }

    /** SIGTERM, then SIGKILL, to the pi the previous daemon recorded, when it still runs. */
    private async stop_leftover(): Promise<void> {
        const record = read_process_record(this.dir);
        if (record === null || record.started === null) {
            return;
        }
        const identity = { pid: record.pid, started: record.started };
        if (!(await is_spinner_leader(identity))) {
            remove_process_record(this.dir);
            return;
        }
        this.log(`operator: pi ${record.pid} outlived the daemon; stopping it before resume`);
        process.kill(record.pid, "SIGTERM");
        const deadline = Date.now() + LEFTOVER_STOP_GRACE_MS;
        while (Date.now() < deadline && process_start_time(record.pid) === record.started) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (process_start_time(record.pid) === record.started) {
            process.kill(record.pid, "SIGKILL");
        }
        remove_process_record(this.dir);
    }
}

/**
 * Pure apart from `needs_human`, which remembers each session's last value so only a change
 * from null to text is a notice: the line for an event the operator agent must hear about,
 * or null. Each line starts with the session directory.
 */
export function notice_line(
    event: SpinnerEvent,
    needs_human: Map<string, string | null>,
): string | null {
    switch (event.type) {
        case "session.created":
            needs_human.set(event.session, event.data.summary.session.needs_human);
            return null;
        case "session.updated": {
            const next = event.data.summary.session.needs_human;
            const before = needs_human.get(event.session);
            needs_human.set(event.session, next);
            if (before === undefined || before !== null || next === null) {
                return null;
            }
            return `${event.session}: needs a human: ${next}`;
        }
        case "session.closed":
            needs_human.delete(event.session);
            return null;
        case "agent.settled":
            return `${event.session}: agent ${event.agent} settled`;
        case "agent.exited":
            return `${event.session}: agent ${event.agent} exited (code ${event.code ?? "signal"})`;
        case "job.finished": {
            if (event.ok) {
                return null;
            }
            const where = event.session ?? "(no session)";
            return `${where}: job ${event.data.action} failed: ${event.error ?? "no message"}`;
        }
        case "inbox.message":
            if (event.to !== "operator") {
                return null;
            }
            return (
                `${event.session}: message from ${event.from} (inbox/${event.file}): ` +
                event.subject
            );
        default:
            return null;
    }
}

/** Who the agent waits on in each process state (Contracts: `OperatorView.waiting_on`). */
function waiting_on_of(process_: OperatorView["process"]): OperatorView["waiting_on"] {
    if (process_ === "exited") {
        return "start";
    }
    return process_ === "idle" ? "operator" : "model";
}

/** Pure: the lines, then one line that says how many older ones were dropped, if any. */
export function render_notice(lines: readonly string[], dropped: number): string {
    assert.ok(lines.length > 0, "a notice needs lines");
    if (dropped === 0) {
        return lines.join("\n");
    }
    return [...lines, `(${dropped} older notice${dropped === 1 ? "" : "s"} dropped)`].join("\n");
}

function process_record_path(dir: string): string {
    return join(dir, "process.json");
}

function write_process_record(dir: string, record: ProcessRecord): void {
    writeFileSync(process_record_path(dir), `${JSON.stringify(record)}\n`);
}

function read_process_record(dir: string): ProcessRecord | null {
    const path = process_record_path(dir);
    if (!existsSync(path)) {
        return null;
    }
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ProcessRecord>;
        if (typeof parsed.pid !== "number") {
            return null;
        }
        const started = typeof parsed.started === "string" ? parsed.started : null;
        return { pid: parsed.pid, started };
    } catch {
        return null;
    }
}

function remove_process_record(dir: string): void {
    rmSync(process_record_path(dir), { force: true });
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
