// Hosts the pi agents of every session: starts one per agent tab through the harness, keeps
// the handles (the daemon's only process state), records each agent in `session.yaml`
// (`agents.<name>`: harness, model, process, pid), regenerates the session `AGENTS.md`, and
// turns pi's events into `agent.spawned`, `agent.event`, `agent.settled` and `agent.exited`
// on the bus. Nothing starts on its own: every spawn is a `POST` or a CLI call. The manager
// also holds the text waiting for an agent's next prompt (an inbox message or a mission-change
// notice for an idle agent, docs/SESSION_PROTOCOL.md "Messages"), which `prompt` prepends.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddAgentRequest, AgentSpec, SessionSummary } from "@spinner/protocol";
import type { EventBus } from "../event-bus.js";
import type { SpinnerHome } from "../home.js";
import { render_agents_file } from "../store/mission-template.js";
import { read_session, write_session } from "../store/session-store.js";
import { agent_brief_path, type AgentHandle, type AgentHarness } from "./harness.js";

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
        private readonly harness: AgentHarness,
        private readonly bus: EventBus,
        options: AgentManagerOptions = {},
    ) {
        this.now = options.now ?? (() => new Date());
        this.log = options.log ?? (() => undefined);
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
     * Adds an agent from its brief and starts it, or resumes one that `session.yaml` already
     * lists. Throws when the brief is missing, the agent runs already, or pi fails to start.
     */
    async add(summary: SessionSummary, request: AddAgentRequest): Promise<AgentHandle> {
        const key = key_of(summary.dir, request.name);
        if (this.hosted.has(key)) {
            throw new Error(`agent ${request.name} is already running in ${summary.dir}`);
        }
        assert.ok(this.hosted.size < AGENTS_RUNNING_MAX, `${AGENTS_RUNNING_MAX} agents running`);
        const brief = agent_brief_path(summary.path, request.name);
        if (!existsSync(brief)) {
            throw new Error(`${brief} does not exist; write the brief first`);
        }
        const cwd = agent_cwd(summary, request.repo);
        // The caller's summary may predate an earlier run; the file has the model it used.
        const fresh = read_session(this.home, summary.dir);
        const listed = fresh.ok ? fresh.summary.session.agents?.[request.name] : undefined;
        const model = request.model ?? listed?.model;
        this.write_agents_file(summary);
        const spawned = await this.harness.spawn(summary, { name: request.name, model, cwd });
        const handle = this.with_pending(key, spawned);
        const spec: AgentSpec = {
            harness: "pi",
            model: model ?? "default",
            process: "idle",
            pid: handle.pid,
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

    /** A handle whose `prompt` prepends the queued texts, each under its own heading. */
    private with_pending(key: string, handle: AgentHandle): AgentHandle {
        // The handle is a class instance; its methods live on the prototype, so each one is
        // forwarded by name rather than spread.
        return {
            pid: handle.pid,
            pi_session_id: handle.pi_session_id,
            exited: handle.exited,
            steer: (text) => handle.steer(text),
            abort: () => handle.abort(),
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

    /** Merges `patch` into `session.yaml`'s entry for the agent. A closed session is skipped. */
    private record(dir: string, name: string, patch: Partial<AgentSpec>, drop_pid = false): void {
        const read = read_session(this.home, dir);
        if (!read.ok) {
            return;
        }
        const session = read.summary.session;
        session.agents ??= {};
        const fresh: AgentSpec = { harness: "pi", model: "default", process: "idle" };
        const current = session.agents[name] ?? fresh;
        const next: AgentSpec = { ...current, ...patch };
        if (drop_pid) {
            delete next.pid;
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

function key_of(dir: string, name: string): string {
    return `${dir}/${name}`;
}
