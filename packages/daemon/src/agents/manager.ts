// Hosts the pi agents of every session: starts one per agent tab through the harness the
// config names (`tty` by default, `rpc` for headless runs), keeps the handles (the daemon's
// only process state), records each agent in `session.yaml` (`agents.<name>`: harness, model,
// process, pid, started), regenerates the session `AGENTS.md`, and turns pi's events into
// `agent.spawned`, `agent.event`, `agent.settled` and `agent.exited` on the bus. Every spawn
// is a `POST` or a CLI call, with one exception since s009: `adopt_all` on daemon start
// resumes the tty agents the previous daemon hosted, because a pty master dies with its
// daemon and the operator expects the tab back. The manager also holds the text waiting for
// an agent's next prompt (an inbox message or a mission-change notice for an idle agent,
// docs/SESSION_PROTOCOL.md "Messages"), which `prompt` prepends. `first_turn` is the go
// signal `POST /sessions/:dir/agents` sends a new agent (dogfood row 37): the other spawn
// paths (the lead's paste, the fixer, the swarm) prompt on their own.
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
import { SETTINGS_DEFAULT, role_of_agent } from "@spinner/protocol";
import type { EventBus } from "../event-bus.js";
import { egm_spawn } from "../egm/spawn.js";
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
export const AGENTS_RUNNING_MAX = 24;

export interface AgentManagerOptions {
    now?: () => Date;
    log?: (line: string) => void;
    /** The cap on hosted agents; `AGENTS_RUNNING_MAX` when absent. Tests lower it. */
    running_max?: number;
}

/** What `add` takes beyond the request: daemon-side facts the API does not expose. */
export interface AddAgentExtra {
    /** Skill directories pi loads with `--skill` (s015, the review skill). */
    skills?: string[];
    /**
     * The harness for this agent, over the settings (s016): a review's reviewers and lead
     * run headless on `rpc`, so no startup screen eats their first message.
     */
    harness?: "tty" | "rpc";
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

/**
 * The go signal a new agent gets from `POST /sessions/:dir/agents` when the body carries no
 * `message`. The mission and the brief are in its system prompt already; the turn tells it to
 * act on them instead of waiting for the operator (dogfood row 37).
 */
export const FIRST_TURN =
    "Start. Read MISSION.md and your brief (both are in your system prompt). Take the Plan " +
    "items that carry your name as owner, update your Roster row, and begin on the first one. " +
    "Without a Plan item of yours, read your brief's `Owns` and say in the Log what you start on.";

export class AgentManager {
    private readonly hosted = new Map<string, Hosted>();
    /**
     * Agents whose pi `add` is spawning: not hosted yet, but a second `add` of one of them
     * would start a second pi on the same transcript.
     */
    private readonly starting = new Set<string>();
    private readonly pending = new Map<string, string[]>();
    /**
     * True from `stop_all`: the daemon stops its agents to shut down. Their exits are then
     * not recorded, so `session.yaml` keeps them `idle` or `running` and the next daemon's
     * `adopt_all` resumes them. Recording `exited` here left every agent dead after a
     * restart, with nothing to say so but a small line under the terminal (dogfood 49, 57).
     */
    private shutting_down = false;
    private readonly now: () => Date;
    private readonly log: (line: string) => void;
    private readonly running_max: number;

    constructor(
        private readonly home: SpinnerHome,
        private readonly harnesses: AgentHarnesses,
        private readonly bus: EventBus,
        options: AgentManagerOptions = {},
    ) {
        assert.ok(harnesses[harnesses.default] !== undefined, `no ${harnesses.default} harness`);
        this.now = options.now ?? (() => new Date());
        this.log = options.log ?? (() => undefined);
        this.running_max = options.running_max ?? AGENTS_RUNNING_MAX;
        assert.ok(this.running_max >= 1, "the agent cap must be at least 1");
    }

    /** How many agents this daemon hosts now, across sessions. */
    get running_count(): number {
        return this.hosted.size;
    }

    /** True when `add` would refuse: the cap is reached (s015, the swarm queues behind it). */
    get at_cap(): boolean {
        return this.hosted.size >= this.running_max;
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

    /** True while the agent runs or its pi is starting: an `add` of it now would throw. */
    has(dir: string, name: string): boolean {
        const key = key_of(dir, name);
        return this.hosted.has(key) || this.starting.has(key);
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

    /**
     * Sends `text` as the agent's first prompt and answers pi's disposition. A pi that refuses
     * it (not ready yet, a tty still attaching) keeps the text for the next prompt and answers
     * `queued`, as the lead's paste does; the agent then starts on the operator's first word.
     */
    async first_turn(
        dir: string,
        name: string,
        handle: AgentHandle,
        text: string,
    ): Promise<string> {
        assert.ok(text.trim().length > 0, "a first turn must not be empty");
        try {
            return await handle.prompt(text);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.log(`${dir}/${name}: first turn not delivered (${reason}); queued for the next`);
            this.queue_for_next_prompt(dir, name, text);
            return "queued";
        }
    }

    /**
     * A one-line notice from the daemon to one agent (the track change, dogfood #44), by the
     * rule the review swarm uses for its verdict notice: a tty agent takes `notify`; an rpc
     * agent gets a steer while it runs and a prompt while idle; a prompt that loses that race
     * goes as a steer. A stopped agent, or a failed delivery, queues the text for its next
     * prompt. Answers the disposition, or `queued`.
     */
    async deliver_notice(dir: string, name: string, text: string): Promise<string> {
        assert.ok(text.trim().length > 0, "a notice must not be empty");
        const handle = this.get(dir, name);
        if (handle === null) {
            this.queue_for_next_prompt(dir, name, text);
            return "queued";
        }
        try {
            if (handle.notify !== undefined) {
                return await handle.notify(text);
            }
            if (this.is_busy(dir, name)) {
                return await handle.steer(text);
            }
            return await handle.prompt(text).catch(() => handle.steer(text));
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.log(`${dir}/${name}: notice not delivered (${reason}); queued for the next`);
            this.queue_for_next_prompt(dir, name, text);
            return "queued";
        }
    }

    /**
     * A message from the operator with images (a preview comment, s054): a prompt while the
     * agent is idle, a steer while it runs, and a steer when the prompt loses that race. A
     * stopped agent, or a failed delivery, keeps the text for its next prompt (the text names
     * the image's path; the image itself is not kept) and answers `stopped` or `queued`.
     */
    async deliver_message(
        dir: string,
        name: string,
        text: string,
        images: readonly string[],
    ): Promise<string> {
        assert.ok(text.trim().length > 0, "a message must not be empty");
        const handle = this.get(dir, name);
        if (handle === null) {
            this.queue_for_next_prompt(dir, name, text);
            return "stopped";
        }
        try {
            if (this.is_busy(dir, name)) {
                return await handle.steer(text, images);
            }
            return await handle.prompt(text, images).catch(() => handle.steer(text, images));
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.log(`${dir}/${name}: message not delivered (${reason}); queued for the next`);
            this.queue_for_next_prompt(dir, name, text);
            return "queued";
        }
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
    async add(
        summary: SessionSummary,
        request: AddAgentRequest,
        extra: AddAgentExtra = {},
    ): Promise<AgentHandle> {
        const key = key_of(summary.dir, request.name);
        if (this.has(summary.dir, request.name)) {
            throw new Error(`agent ${request.name} is already running in ${summary.dir}`);
        }
        if (this.at_cap) {
            throw new Error(`${this.running_max} agents running; the cap is reached`);
        }
        this.starting.add(key);
        try {
            return await this.spawn_agent(summary, request, extra, key);
        } finally {
            this.starting.delete(key);
        }
    }

    /** The body of `add` once the agent is reserved in `starting`. */
    private async spawn_agent(
        summary: SessionSummary,
        request: AddAgentRequest,
        extra: AddAgentExtra,
        key: string,
    ): Promise<AgentHandle> {
        // The caller's summary may predate an earlier run; the file has the model it used.
        const fresh = read_session(this.home, summary.dir);
        const listed = fresh.ok ? fresh.summary.session.agents?.[request.name] : undefined;
        // A resume that names no repo (the tab's `resume`) runs where the agent ran before,
        // not in the session directory.
        const repo = request.repo ?? listed?.repo;
        const cwd = agent_cwd(summary, repo);
        ensure_brief(summary, request);
        // `default` is the placeholder `record` writes for pi's own choice, not a model id.
        const listed_model = listed?.model === "default" ? undefined : listed?.model;
        // The operator's `settings.yaml` sits between the request and `config.yaml`: the
        // request's model, else the one this agent ran with, else `settings.default_model`,
        // else the harness's `config.yaml` default. The harness the same way, without the
        // per-agent step. A settings file that does not parse is logged, not fatal here.
        const settings = this.read_settings();
        const model = request.model ?? listed_model ?? settings.default_model;
        this.write_agents_file(summary);
        const harness_name = extra.harness ?? settings.agents?.harness ?? this.harnesses.default;
        const harness = this.harnesses[harness_name];
        assert.ok(harness !== undefined, `no ${harness_name} harness`);
        const skills = extra.skills ?? listed?.skills;
        // EGM paths are computed on every spawn, not recorded, so a resume after a fetch
        // picks them up.
        const egm =
            role_of_agent(request.name) === "lead"
                ? egm_spawn(this.home, summary, process.env)
                : null;
        const spawned = await harness.spawn(summary, {
            name: request.name,
            model,
            cwd,
            ...(skills === undefined ? {} : { skills }),
            ...(egm === null ? {} : { egm }),
        });
        const handle = this.with_pending(key, spawned);
        const started = process_start_time(handle.pid);
        const spec: AgentSpec = {
            harness: harness_name,
            model: model ?? "default",
            process: "idle",
            pid: handle.pid,
            ...(started === null ? {} : { started }),
            ...(repo === undefined ? {} : { repo }),
            ...(skills === undefined ? {} : { skills }),
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
     * harness can take one. With `steer_fallback` (the design-change notice, 6.4), a handle
     * without `notify` gets the text as a steer, so the rpc harness is reached too. Returns the
     * names reached; a failed delivery is logged, not thrown.
     */
    async notify_all(
        dir: string,
        text: string,
        options: { steer_fallback: boolean } = { steer_fallback: false },
    ): Promise<string[]> {
        assert.ok(text.length > 0, "a notice must not be empty");
        const reached: string[] = [];
        for (const entry of this.hosted.values()) {
            if (entry.dir !== dir) {
                continue;
            }
            const handle = entry.handle;
            if (handle.notify === undefined && !options.steer_fallback) {
                continue;
            }
            try {
                if (handle.notify === undefined) {
                    await handle.steer(text);
                } else {
                    await handle.notify(text);
                }
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

    /**
     * The running agent, or a listed and stopped one resumed on its transcript. For a message
     * the operator sends from a place with no `resume` button (an EGM gate card, a skill
     * button): the message must not fail because a restart stopped the agent. Throws when
     * the session does not list the agent or pi does not start.
     */
    async ensure_running(dir: string, name: string): Promise<AgentHandle> {
        const running = this.get(dir, name);
        if (running !== null) {
            return running;
        }
        const read = read_session(this.home, dir);
        if (!read.ok) {
            throw new Error(read.error);
        }
        if (read.summary.session.agents?.[name] === undefined) {
            throw new Error(`agent ${name} is not in ${dir}`);
        }
        this.log(`resume ${dir}/${name}: a message arrived while it was stopped`);
        return this.add(read.summary, { name });
    }

    /** Stops every agent, for daemon shutdown. Their exits stay unrecorded; see the flag. */
    async stop_all(): Promise<void> {
        this.shutting_down = true;
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
            steer: (text, images) => handle.steer(text, images),
            abort: () => handle.abort(),
            compact: () => handle.compact(),
            ...(notify === undefined ? {} : { notify }),
            commands: () => handle.commands(),
            on_event: (listener) => handle.on_event(listener),
            stop: () => handle.stop(),
            prompt: (text: string, images?: readonly string[]) => {
                const queued = this.pending.get(key) ?? [];
                this.pending.delete(key);
                if (queued.length === 0) {
                    return handle.prompt(text, images);
                }
                return handle.prompt(`${queued.join("\n\n")}\n\n---\n\n${text}`, images);
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
        if (this.shutting_down) {
            this.log(`agent ${entry.name} in ${entry.dir} stopped with the daemon`);
            return;
        }
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
                egm: (summary.session.kind ?? "session") === "session",
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
        ...(role_of_agent(name) === "lead" ? { kind: "lead" as const } : {}),
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
