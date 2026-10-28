// The agent adapter (docs/ARCHITECTURE.md, "Agent adapter") and its v1 implementation,
// `PiRpcHarness`: one `pi --mode rpc` child per agent tab, started in the agent's worktree
// with `--session-dir <session>/agents/<name>/pi` and `--session-id <name>`, so `resume` is
// the same spawn: pi opens the transcript with that id when it exists. The brief goes in
// through `--append-system-prompt`, the session's `AGENTS.md` through pi's own context-file
// chain. pi reads both at startup only (see MISSION.md Contracts), so a context edit means
// `stop` then `resume`.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PiEvent, SessionSummary } from "@spinner/protocol";
import { model_args, spawn_pi, type PiProcess } from "./pi-rpc.js";

export interface AgentSpawnSpec {
    name: string;
    /** `provider/model`, or undefined for pi's default. */
    model: string | undefined;
    /** The agent's working directory: a worktree, or the session directory. */
    cwd: string;
}

export interface AgentHandle {
    pid: number;
    /** pi's session id for the transcript, for the UI and for resume. */
    pi_session_id: string;
    /** Sends a prompt; resolves with pi's disposition (`started`, `queued`, `handled`). */
    prompt(text: string): Promise<string>;
    /** Queues a steer; it enters after the current turn and its tool calls. */
    steer(text: string): Promise<string>;
    abort(): Promise<void>;
    on_event(listener: (event: PiEvent) => void): () => void;
    exited: Promise<number | null>;
    stop(): Promise<number | null>;
}

export interface AgentHarness {
    spawn(session: SessionSummary, agent: AgentSpawnSpec): Promise<AgentHandle>;
    resume(session: SessionSummary, agent: AgentSpawnSpec): Promise<AgentHandle>;
}

export interface PiRpcHarnessOptions {
    /** The pi executable, resolved at each spawn so a daemon without pi still serves the rest. */
    pi: () => string;
    /** Receives pi's stderr lines, tagged with the agent name. */
    on_stderr?: (agent: string, line: string) => void;
}

/** Where an agent's pi transcripts live, relative to the session directory. */
export function agent_pi_dir(name: string): string {
    return join("agents", name, "pi");
}

export function agent_brief_path(session_path: string, name: string): string {
    return join(session_path, "agents", name, "BRIEF.md");
}

export class PiRpcHarness implements AgentHarness {
    constructor(private readonly options: PiRpcHarnessOptions) {}

    spawn(session: SessionSummary, agent: AgentSpawnSpec): Promise<AgentHandle> {
        return this.start(session, agent);
    }

    /** The same as `spawn`: `--session-id` reopens the transcript when it exists. */
    resume(session: SessionSummary, agent: AgentSpawnSpec): Promise<AgentHandle> {
        return this.start(session, agent);
    }

    private async start(session: SessionSummary, agent: AgentSpawnSpec): Promise<AgentHandle> {
        assert.ok(/^[a-z0-9][a-z0-9-]*$/.test(agent.name), `agent name ${agent.name}`);
        const brief = agent_brief_path(session.path, agent.name);
        assert.ok(existsSync(brief), `${brief} does not exist`);
        const session_dir = join(session.path, agent_pi_dir(agent.name));
        mkdirSync(session_dir, { recursive: true });
        const extra_args = ["--append-system-prompt", brief];
        const skills = join(session.path, "skills");
        if (existsSync(skills) && has_entries(skills)) {
            extra_args.push("--skill", skills);
        }
        const on_stderr = this.options.on_stderr;
        const process_ = await spawn_pi({
            pi: this.options.pi(),
            cwd: agent.cwd,
            session_dir,
            session_id: agent.name,
            ...(agent.model === undefined ? {} : { model: agent.model }),
            extra_args,
            on_stderr: (line) => on_stderr?.(agent.name, line),
        });
        return new PiHandle(process_, agent.name);
    }
}

/** `--skill` on an empty directory is noise in pi's diagnostics; pass it only with content. */
function has_entries(dir: string): boolean {
    return readdirSync(dir).length > 0;
}

class PiHandle implements AgentHandle {
    readonly pid: number;
    readonly exited: Promise<number | null>;

    constructor(
        private readonly process_: PiProcess,
        readonly pi_session_id: string,
    ) {
        this.pid = process_.pid;
        this.exited = process_.exited;
    }

    async prompt(text: string): Promise<string> {
        assert.ok(text.length > 0, "a prompt must not be empty");
        const response = await this.process_.send({ type: "prompt", message: text });
        return disposition_of(response.data);
    }

    async steer(text: string): Promise<string> {
        assert.ok(text.length > 0, "a steer must not be empty");
        const response = await this.process_.send({ type: "steer", message: text });
        return disposition_of(response.data);
    }

    async abort(): Promise<void> {
        await this.process_.send({ type: "abort" });
    }

    on_event(listener: (event: PiEvent) => void): () => void {
        return this.process_.on_event(listener);
    }

    stop(): Promise<number | null> {
        return this.process_.stop();
    }
}

function disposition_of(data: unknown): string {
    if (typeof data === "object" && data !== null && "disposition" in data) {
        return String((data as { disposition: unknown }).disposition);
    }
    return "accepted";
}

export { model_args };
