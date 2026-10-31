// Hosts the pi agents of every session: starts one per agent tab through the harness the
// config names (`tty` by default, `rpc` for headless runs), keeps the handles (the daemon's
// only process state), records each agent in `session.yaml` (`agents.<name>`: harness, model,
// process, pid, started), regenerates the session `AGENTS.md`, and turns pi's events into
// `agent.spawned`, `agent.event`, `agent.settled` and `agent.exited` on the bus. Every spawn
// is a `POST` or a CLI call, with one exception since s009: `adopt_all` on daemon start
// resumes the tty agents the previous daemon hosted, because a pty master dies with its
// daemon and the operator expects the tab back. The manager also holds the text waiting for
// an agent's next prompt (an inbox message or a mission-change notice for an idle agent,
// docs/SESSION_PROTOCOL.md "Messages"), which `prompt` prepends.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
    AddAgentRequest,
    AgentHarnessName,
    AgentSpec,
    SessionSummary,
    Settings,
} from "@spinner/protocol";
import { SETTINGS_DEFAULT } from "@spinner/protocol";
import type { EventBus } from "../event-bus.js";
import type { SpinnerHome } from "../home.js";
import { is_spinner_leader, process_start_time } from "../stack/host-service.js";
import { render_brief } from "../store/brief-template.js";
import { render_agents_file } from "../store/mission-template.js";
import { read_settings } from "../settings.js";
import { list_sessions, read_session, write_session } from "../store/session-store.js";
import { agent_brief_path, type AgentHandle, type AgentHarness } from "./harness.js";

/** The harnesses the daemon can start and the one `config.yaml` `agents.harness` names. */
export interface AgentHarnesses {
    default: "tty" | "rpc";
    tty?: AgentHarness;
    rpc?: AgentHarness;
}

/** Time a leftover pi from the previous daemon gets after SIGTERM before SIGKILL. */
const ADOPT_STOP_GRACE_MS = 5_000;

/** Agents one daemon hosts at once. Each is a pi process with its own model session. */
const AGENTS_RUNNING_MAX = 24;

export interface AgentManagerOptions {
    now?: () => Date;
    log?: (line: string) => void;
}

interface Hosted {
    dir: string;
    name: string;
    cwd: string;
    handle: AgentHandle;
    /** True between `agent_start` and `agent_settled`: a steer reaches this run. */
    busy: boolean;
    unsubscribe: () => void;
}

/** Upper bound on texts waiting for one agent's next prompt. */
const PENDING_MAX = 50;

export class AgentManager {
    private readonly hosted = new Map<string, Hosted>();
    private readonly pending = new Map<string, string[]>();
    private readonly now: () => Date;
    private readonly log: (line: string) => void;

    constructor(
        private readonly home: SpinnerHome,
        private readonly harnesses: AgentHarnesses,
        private readonly bus: EventBus,
        options: AgentManagerOptions = {},
    ) {
        assert.ok(harnesses[harnesses.default] !== undefined, `no ${harnesses.default} harness`);
        this.now = options.now ?? (() => new Date());
        this.log = options.log ?? (() => undefined);
    }

    /** The harness name every `add` uses, from `config.yaml`. */
    get default_harness(): "tty" | "rpc" {
        return this.harnesses.default;
    }

    /** Names of the agents whose process this daemon hosts, for `SessionView.agents_running`. */
    running(dir: string): string[] {
        const names: string[] = [];
        for (const entry of this.hosted.values()) {
            if (entry.dir === dir) {
                names.push(entry.name);
            }
        }
        return names.sort();
    }

    get(dir: string, name: string): AgentHandle | null {
        return this.hosted.get(key_of(dir, name))?.handle ?? null;
    }

    /** True while the agent's process runs a turn, so a steer enters before its next model call. */
    is_busy(dir: string, name: string): boolean {
        return this.hosted.get(key_of(dir, name))?.busy ?? false;
    }

    /** The agent's working directory while it runs, else null. */
    cwd(dir: string, name: string): string | null {
        return this.hosted.get(key_of(dir, name))?.cwd ?? null;
    }

    /**
     * Queues text for the agent's next prompt. For an idle or stopped agent this is how a
     * message or a mission-change notice arrives; `prompt` prepends every queued text.
     */
    queue_for_next_prompt(dir: string, name: string, text: string): void {
        assert.ok(text.length > 0, "queued text must not be empty");
        const key = key_of(dir, name);
        const queue = this.pending.get(key) ?? [];
        assert.ok(queue.length < PENDING_MAX, `${PENDING_MAX} texts wait for ${name}`);
        queue.push(text);
        this.pending.set(key, queue);
    }

    /** The texts waiting for the agent's next prompt, without taking them. */
    pending_for(dir: string, name: string): string[] {
        return [...(this.pending.get(key_of(dir, name)) ?? [])];
    }

    /**
     * Adds an agent and starts it, or resumes one that `session.yaml` already lists. A session
     * without a brief for the agent gets one first: the request's text, else the default
     * brief. Throws when the agent runs already, the repo has no worktree, or pi fails to
     * start.
     */
    async add(summary: SessionSummary, request: AddAgentRequest): Promise<AgentHandle> {
        const key = key_of(summary.dir, request.name);
        if (this.hosted.has(key)) {
            throw new Error(`agent ${request.name} is already running in ${summary.dir}`);
        }
        assert.ok(this.hosted.size < AGENTS_RUNNING_MAX, `${AGENTS_RUNNING_MAX} agents running`);
        const cwd = agent_cwd(summary, request.repo);
        ensure_brief(summary, request);
        // The caller's summary may predate an earlier run; the file has the model it used.
        const fresh = read_session(this.home, summary.dir);
        const listed = fresh.ok ? fresh.summary.session.agents?.[request.name] : undefined;
        // `default` is the placeholder `record` writes for pi's own choice, not a model id.
        const listed_model = listed?.model === "default" ? undefined : listed?.model;
        // The operator's `settings.yaml` sits between the request and `config.yaml`: the
        // request's model, else the one this agent ran with, else `settings.default_model`,
        // else the harness's `config.yaml` default. The harness the same way, without the
        // per-agent step. A settings file that does not parse is logged, not fatal here.
        const settings = this.read_settings();
        const model = request.model ?? listed_model ?? settings.default_model;
        this.write_agents_file(summary);
        const harness_name = settings.agents?.harness ?? this.harnesses.default;
        const harness = this.harnesses[harness_name];
        assert.ok(harness !== undefined, `no ${harness_name} harness`);
        const spawned = await harness.spawn(summary, { name: request.name, model, cwd });
        const handle = this.with_pending(key, spawned);
        const started = process_start_time(handle.pid);
        const spec: AgentSpec = {
            harness: harness_name,
            model: model ?? "default",
            process: "idle",
            pid: handle.pid,
            ...(started === null ? {} : { started }),
            ...(request.repo === undefined ? {} : { repo: request.repo }),
        };
        this.record(summary.dir, request.name, spec);
        const dir = summary.dir;
        const agent = request.name;
        const unsubscribe = handle.on_event((event) => {
            const ts = this.now().toISOString();
            this.bus.publish({ type: "agent.event", ts, session: dir, agent, event });
            const entry = this.hosted.get(key);
            if (event.type === "agent_start") {
                if (entry !== undefined) {
                    entry.busy = true;
                }
                this.record(dir, agent, { process: "running" });
            }
            if (event.type === "agent_settled") {
                if (entry !== undefined) {
                    entry.busy = false;
                }
                this.record(dir, agent, { process: "idle" });
                this.bus.publish({ type: "agent.settled", ts, session: dir, agent });
            }
        });
        this.hosted.set(key, {
            dir: summary.dir,
            name: request.name,
            cwd,
            handle,
            busy: false,
            unsubscribe,
        });
        this.bus.publish({
            type: "agent.spawned",
            ts: this.now().toISOString(),
            session: summary.dir,
            agent: request.name,
            pid: handle.pid,
        });
        void handle.exited.then((code) => this.on_exit(key, code));
        return handle;
    }

    /**
     * Pushes a daemon notice (a failed stack job) to every running agent of `dir` whose
     * harness can take one. Returns the names reached; a failed delivery is logged, not thrown.
     */
    async notify_all(dir: string, text: string): Promise<string[]> {
        assert.ok(text.length > 0, "a notice must not be empty");
        const reached: string[] = [];
        for (const entry of this.hosted.values()) {
            if (entry.dir !== dir || entry.handle.notify === undefined) {
                continue;
            }
            try {
                await entry.handle.notify(text);
                reached.push(entry.name);
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                this.log(`notify ${entry.name} in ${dir}: ${reason}`);
            }
        }
        return reached.sort();
    }

    /** Stops the agent's process. The transcript stays; `add` resumes it. */
    async stop(dir: string, name: string): Promise<void> {
        const entry = this.hosted.get(key_of(dir, name));
        if (entry === undefined) {
            throw new Error(`agent ${name} is not running in ${dir}`);
        }
        await entry.handle.stop();
    }

    /** Stops every agent, for daemon shutdown. */
    async stop_all(): Promise<void> {
        await Promise.all([...this.hosted.values()].map((entry) => entry.handle.stop()));
    }

    /**
     * On daemon start: every `tty` agent `session.yaml` lists as `running` or `idle` was hosted
     * by the previous daemon. Its pty master died with that daemon, so the pi behind it is
     * stopped when its identity (pid and start time) is still live, then the agent is resumed
     * on the same transcript. Returns the names resumed, as `dir/name`. An `rpc` agent is
     * marked `exited`: its stdin pipe is gone and the operator resumes it from the tab.
     */
    async adopt_all(): Promise<string[]> {
        const resumed: string[] = [];
        for (const summary of list_sessions(this.home).sessions) {
            for (const [name, spec] of Object.entries(summary.session.agents ?? {})) {
                if (spec.process === "exited") {
                    continue;
                }
                await this.stop_leftover(name, spec);
                if (harness_of(spec.harness) !== "tty" || this.harnesses.tty === undefined) {
                    this.record(summary.dir, name, { process: "exited" }, true);
                    continue;
                }
                try {
                    const request: AddAgentRequest = { name };
                    if (spec.repo !== undefined) {
                        request.repo = spec.repo;
                    }
                    await this.add(summary, request);
                    resumed.push(`${summary.dir}/${name}`);
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    this.log(`adopt ${summary.dir}/${name}: resume failed: ${reason}`);
                    this.record(summary.dir, name, { process: "exited" }, true);
                }
            }
        }
        return resumed;
    }

    /** SIGTERM, then SIGKILL, to a pi the previous daemon left, when its identity still matches. */
    private async stop_leftover(name: string, spec: AgentSpec): Promise<void> {
        if (spec.pid === undefined || spec.started === undefined) {
            return;
        }
        const identity = { pid: spec.pid, started: spec.started };
        if (!(await is_spinner_leader(identity))) {
            return;
        }
        this.log(`adopt ${name}: pi ${spec.pid} outlived the daemon; stopping it before resume`);
        process.kill(spec.pid, "SIGTERM");
        const deadline = Date.now() + ADOPT_STOP_GRACE_MS;
        while (Date.now() < deadline && process_start_time(spec.pid) === spec.started) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (process_start_time(spec.pid) === spec.started) {
            process.kill(spec.pid, "SIGKILL");
        }
    }

    /** A handle whose `prompt` prepends the queued texts, each under its own heading. */
    private with_pending(key: string, handle: AgentHandle): AgentHandle {
        // The handle is a class instance; its methods live on the prototype, so each one is
        // forwarded by name rather than spread.
        const notify = handle.notify?.bind(handle);
        return {
            pid: handle.pid,
            pi_session_id: handle.pi_session_id,
            exited: handle.exited,
            steer: (text) => handle.steer(text),
            abort: () => handle.abort(),
            ...(notify === undefined ? {} : { notify }),
            commands: () => handle.commands(),
            on_event: (listener) => handle.on_event(listener),
            stop: () => handle.stop(),
            prompt: (text: string) => {
                const queued = this.pending.get(key) ?? [];
                this.pending.delete(key);
                if (queued.length === 0) {
                    return handle.prompt(text);
                }
                return handle.prompt(`${queued.join("\n\n")}\n\n---\n\n${text}`);
            },
        };
    }

    private on_exit(key: string, code: number | null): void {
        const entry = this.hosted.get(key);
        if (entry === undefined) {
            return;
        }
        entry.unsubscribe();
        this.hosted.delete(key);
        this.record(entry.dir, entry.name, { process: "exited" }, true);
        this.bus.publish({
            type: "agent.exited",
            ts: this.now().toISOString(),
            session: entry.dir,
            agent: entry.name,
            process: "exited",
            code,
        });
        this.log(`agent ${entry.name} in ${entry.dir} exited with ${code ?? "a signal"}`);
    }

    private read_settings(): Settings {
        try {
            return read_settings(this.home).settings;
        } catch (error) {
            this.log(`settings: ${error instanceof Error ? error.message : String(error)}`);
            return SETTINGS_DEFAULT;
        }
    }

    /** Merges `patch` into `session.yaml`'s entry for the agent. A closed session is skipped. */
    private record(dir: string, name: string, patch: Partial<AgentSpec>, drop_pid = false): void {
        const read = read_session(this.home, dir);
        if (!read.ok) {
            return;
        }
        const session = read.summary.session;
        session.agents ??= {};
        const fresh: AgentSpec = {
            harness: this.harnesses.default,
            model: "default",
            process: "idle",
        };
        const current = session.agents[name] ?? fresh;
        const next: AgentSpec = { ...current, ...patch };
        if (drop_pid) {
            delete next.pid;
            delete next.started;
        }
        session.agents[name] = next;
        write_session(read.summary);
    }

    private write_agents_file(summary: SessionSummary): void {
        const hosts = summary.session.stack?.hosts;
        writeFileSync(
            join(summary.path, "AGENTS.md"),
            render_agents_file({
                id: summary.session.id,
                dir: summary.dir,
                path: summary.path,
                ...(hosts === undefined ? {} : { hosts }),
            }),
        );
    }
}

/**
 * Writes `agents/<name>/BRIEF.md` when the session has none: the request's text when it
 * carries one, else the default brief. An existing brief is the operator's and stays.
 */
export function ensure_brief(summary: SessionSummary, request: AddAgentRequest): string {
    const path = agent_brief_path(summary.path, request.name);
    if (existsSync(path)) {
        return path;
    }
    const text = request.brief ?? default_brief(summary, request.name, request.repo);
    assert.ok(text.trim().length > 0, "a brief must not be empty");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
    return path;
}

/** The brief the daemon writes for `name` without one, for the route and the UI form. */
export function default_brief(summary: SessionSummary, name: string, repo?: string): string {
    return render_brief({
        name,
        session: summary.session,
        ...(repo === undefined ? {} : { repo }),
    });
}

/** The worktree of `repo` when given, else the session directory. */
export function agent_cwd(summary: SessionSummary, repo: string | undefined): string {
    if (repo === undefined) {
        return summary.path;
    }
    const entry = summary.session.repos[repo];
    if (entry === undefined || entry.worktree === undefined) {
        throw new Error(`session ${summary.session.id} has no worktree for repo "${repo}"`);
    }
    return join(summary.path, entry.worktree);
}

/** `pi`, the value files before s009 carry, is the RPC harness. */
export function harness_of(name: AgentHarnessName): "tty" | "rpc" {
    return name === "tty" ? "tty" : "rpc";
}

function key_of(dir: string, name: string): string {
    return `${dir}/${name}`;
}
