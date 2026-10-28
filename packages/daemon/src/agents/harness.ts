// The agent adapter (docs/ARCHITECTURE.md, "Agent adapter") and its v1 implementation,
// `PiRpcHarness`: one `pi --mode rpc` child per agent tab, started in the agent's worktree
// with `--session-dir <session>/agents/<name>/pi` and `--session-id <name>`, so `resume` is
// the same spawn: pi opens the transcript with that id when it exists. The brief goes in
// through `--append-system-prompt`, the session's `AGENTS.md` through pi's own context-file
// chain. pi reads both at startup only (see MISSION.md Contracts), so a context edit means
// `stop` then `resume`. The Spinner pi extension (`packages/pi-extension`) goes in through
// `--extension` with the session directory, the agent name, the daemon URL and the role in
// the environment (`EXTENSION_ENV`); it adds the mission to the prompt, the tools and
// `/spinner-reload`, which makes a context edit a reload instead of a restart.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiEvent, SessionSummary } from "@spinner/protocol";
import { EXTENSION_ENV, type ExtensionRole } from "@spinner/protocol";
import { model_args, spawn_pi, type PiProcess } from "./pi-rpc.js";

export interface AgentSpawnSpec {
    name: string;
    /** `provider/model`, or undefined for pi's default. */
    model: string | undefined;
    /** The agent's working directory: a worktree, or the session directory. */
    cwd: string;
    /** `fixer` registers the `thread_*` tools. The agent named `fixer` gets it by default. */
    role?: ExtensionRole;
}

/** A command pi lists through `get_commands`: a skill, a prompt template or an extension. */
export interface PiCommand {
    name: string;
    description?: string;
    source: "extension" | "prompt" | "skill";
    sourceInfo?: { path?: string };
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
    /** The commands pi loaded, for the Context tab. */
    commands(): Promise<PiCommand[]>;
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
    /** The daemon's base URL for the extension's tools, known once the server listens. */
    daemon_url?: () => string;
    /** The extension entry; `default_extension_path()` when absent, none when null. */
    extension?: string | null;
}

/**
 * `packages/pi-extension/src/index.ts`, from `packages/daemon/{src,dist}/agents/harness.{ts,js}`.
 * pi loads TypeScript through jiti, so the source is the entry; the extension resolves
 * `@spinner/protocol` from its own `node_modules`, which the workspace links.
 */
export function default_extension_path(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, "..", "..", "..", "pi-extension", "src", "index.ts");
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
        const extension =
            this.options.extension === undefined
                ? default_extension_path()
                : this.options.extension;
        if (extension !== null && existsSync(extension)) {
            extra_args.push("--extension", extension);
        }
        const role: ExtensionRole = agent.role ?? (agent.name === "fixer" ? "fixer" : "worker");
        const env: Record<string, string> = {
            [EXTENSION_ENV.session_dir]: session.path,
            [EXTENSION_ENV.agent]: agent.name,
            [EXTENSION_ENV.daemon_url]: this.options.daemon_url?.() ?? "",
            [EXTENSION_ENV.role]: role,
        };
        const on_stderr = this.options.on_stderr;
        const process_ = await spawn_pi({
            pi: this.options.pi(),
            cwd: agent.cwd,
            session_dir,
            session_id: agent.name,
            ...(agent.model === undefined ? {} : { model: agent.model }),
            extra_args,
            env,
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

    async commands(): Promise<PiCommand[]> {
        const response = await this.process_.send({ type: "get_commands" });
        const data = response.data;
        if (typeof data === "object" && data !== null && "commands" in data) {
            const commands = (data as { commands: unknown }).commands;
            return Array.isArray(commands) ? (commands as PiCommand[]) : [];
        }
        return [];
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
