// Hosts the pi agents of every session: starts one per agent tab through the harness, keeps
// the handles (the daemon's only process state), records each agent in `session.yaml`
// (`agents.<name>`: harness, model, process, pid), regenerates the session `AGENTS.md`, and
// turns pi's events into `agent.spawned`, `agent.event`, `agent.settled` and `agent.exited`
// on the bus. Nothing starts on its own: every spawn is a `POST` or a CLI call.
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
    handle: AgentHandle;
    unsubscribe: () => void;
}

export class AgentManager {
    private readonly hosted = new Map<string, Hosted>();
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
        const handle = await this.harness.spawn(summary, { name: request.name, model, cwd });
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
            if (event.type === "agent_start") {
                this.record(dir, agent, { process: "running" });
            }
            if (event.type === "agent_settled") {
                this.record(dir, agent, { process: "idle" });
                this.bus.publish({ type: "agent.settled", ts, session: dir, agent });
            }
        });
        this.hosted.set(key, { dir: summary.dir, name: request.name, handle, unsubscribe });
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
