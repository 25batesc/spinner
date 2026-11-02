// The agent adapter (docs/ARCHITECTURE.md, "Agent adapter") and its v1 implementation,
// `PiRpcHarness`: one `pi --mode rpc` child per agent tab, started in the agent's worktree
// with `--session-dir <session>/agents/<name>/pi` and `--session-id <name>`, so `resume` is
// the same spawn: pi opens the transcript with that id when it exists. The brief goes in
// through `--append-system-prompt`, the session's `AGENTS.md` through pi's own context-file
// chain. pi reads both at startup only (see MISSION.md Contracts), so a context edit means
// `stop` then `resume`. The Spinner pi extension (`packages/pi-extension`) goes in through
// `--extension` with the session directory, the agent name, the daemon URL and the role in
// the environment (`EXTENSION_ENV`); it adds the mission to the prompt, the tools and
// `/spinner-reload`, which makes a context edit a reload instead of a restart. `PiTtyHarness`
// (`tty-harness.ts`) runs the same pi interactively in a pty; `pi_spawn_options` is the
// builder both share.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiEvent, SessionSummary } from "@spinner/protocol";
import { EXTENSION_ENV, role_of_agent, type ExtensionRole } from "@spinner/protocol";
import { model_args, spawn_pi, type PiProcess, type PiSpawnOptions } from "./pi-rpc.js";

export interface AgentSpawnSpec {
    name: string;
    /** `provider/model`, or undefined for pi's default. */
    model: string | undefined;
    /** The agent's working directory: a worktree, or the session directory. */
    cwd: string;
    /** `fixer` registers the `thread_*` tools. The agent named `fixer` gets it by default. */
    role?: ExtensionRole;
    /** Skill directories beyond the session's `skills/`, each one `--skill` (s015). */
    skills?: string[];
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
    /**
     * A message from the daemon itself (a failed stack job), not from a person: delivered as
     * a custom message that starts a turn, or steers the running one. Only the tty harness
     * has it; the RPC path has no custom-message command.
     */
    notify?(text: string): Promise<string>;
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

/** What a pi harness needs to build a spawn. The tty harness takes the same options. */
export interface PiHarnessOptions {
    /** The pi executable, resolved at each spawn so a daemon without pi still serves the rest. */
    pi: () => string;
    /** Receives pi's stderr lines, tagged with the agent name. */
    on_stderr?: (agent: string, line: string) => void;
    /** The daemon's base URL for the extension's tools, known once the server listens. */
    daemon_url?: () => string;
    /** The extension entry; `default_extension_path()` when absent, none when null. */
    extension?: string | null;
    /** `provider/model` for an agent that names none (`config.yaml` `default_model`). */
    default_model?: string;
}

export type PiRpcHarnessOptions = PiHarnessOptions;

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
        const on_stderr = this.options.on_stderr;
        const process_ = await spawn_pi({
            ...pi_spawn_options(session, agent, this.options),
            on_stderr: (line) => on_stderr?.(agent.name, line),
        });
        return new PiHandle(process_, agent.name);
    }
}

/**
 * The spawn both harnesses share for a session agent: the brief at `agents/<name>/BRIEF.md`,
 * the transcript under `agents/<name>/pi`, the session's `skills/`, and the session directory
 * in the extension's environment. `pi_spawn_plan` does the rest.
 */
export function pi_spawn_options(
    session: SessionSummary,
    agent: AgentSpawnSpec,
    options: PiHarnessOptions,
): PiSpawnOptions {
    const role: ExtensionRole = agent.role ?? role_of_agent(agent.name);
    return pi_spawn_plan(
        {
            name: agent.name,
            cwd: agent.cwd,
            model: agent.model,
            role,
            brief: agent_brief_path(session.path, agent.name),
            pi_dir: join(session.path, agent_pi_dir(agent.name)),
            skills_dir: join(session.path, "skills"),
            session_dir: session.path,
            ...(agent.skills === undefined ? {} : { skills: agent.skills }),
        },
        options,
    );
}

/** What one pi spawn needs, independent of where the files live. The operator host builds one. */
export interface PiSpawnInput {
    name: string;
    cwd: string;
    /** `provider/model`, or undefined for `options.default_model`, else pi's default. */
    model: string | undefined;
    role: ExtensionRole;
    /** The brief file; it must exist. */
    brief: string;
    /** `--session-dir`: where the transcript lives. Created when absent. */
    pi_dir: string;
    /** `--skill` when it exists and has entries. */
    skills_dir?: string;
    /** Further `--skill` directories; each must exist. */
    skills?: string[];
    /** `SPINNER_SESSION_DIR` for the extension. */
    session_dir: string;
}

/**
 * The spawn: cwd, transcript dir and id, model, `--skill` when the directory has entries,
 * `--extension` when the extension exists (else the brief through `--append-system-prompt`),
 * and the extension's environment. Creates the transcript dir.
 */
export function pi_spawn_plan(input: PiSpawnInput, options: PiHarnessOptions): PiSpawnOptions {
    assert.ok(/^[a-z0-9][a-z0-9-]*$/.test(input.name), `agent name ${input.name}`);
    assert.ok(existsSync(input.brief), `${input.brief} does not exist`);
    mkdirSync(input.pi_dir, { recursive: true });
    const extra_args: string[] = [];
    const skills = input.skills_dir;
    if (skills !== undefined && existsSync(skills) && has_entries(skills)) {
        extra_args.push("--skill", skills);
    }
    for (const skill of input.skills ?? []) {
        assert.ok(existsSync(skill), `skill directory ${skill} does not exist`);
        extra_args.push("--skill", skill);
    }
    const extension = resolved_extension(options);
    if (extension !== null) {
        // The extension puts the brief in its prompt section; without it, pi appends it.
        extra_args.push("--extension", extension);
    } else {
        extra_args.push("--append-system-prompt", input.brief);
    }
    const model = input.model ?? options.default_model;
    const env: Record<string, string> = {
        [EXTENSION_ENV.session_dir]: input.session_dir,
        [EXTENSION_ENV.agent]: input.name,
        [EXTENSION_ENV.daemon_url]: options.daemon_url?.() ?? "",
        [EXTENSION_ENV.role]: input.role,
    };
    return {
        pi: options.pi(),
        cwd: input.cwd,
        session_dir: input.pi_dir,
        session_id: input.name,
        ...(model === undefined ? {} : { model }),
        extra_args,
        env,
    };
}

/** The extension entry that exists, or null: absent means the checkout's, null means none. */
export function resolved_extension(options: PiHarnessOptions): string | null {
    const extension =
        options.extension === undefined ? default_extension_path() : options.extension;
    if (extension !== null && existsSync(extension)) {
        return extension;
    }
    return null;
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
