// A thin client for `pi --mode rpc`: one child process, JSONL commands on its stdin,
// responses and events on its stdout. The protocol is pi's `docs/rpc.md` and the records are
// typed in `@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts` (commands and
// responses) and `dist/modes/json-event.d.ts` (events, restated as `PiEvent` in the protocol
// package). Own framing rather than pi's `RpcClient`, because that class spawns `node
// dist/cli.js` relative to the cwd, forwards the child's stderr to ours, and would pull the
// whole pi package into the daemon; the daemon runs the operator's installed `pi` instead.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { PiEvent } from "@spinner/protocol";

/** Upper bound on commands waiting for a response. More means the child stopped answering. */
const PENDING_MAX = 100;

/** Upper bound on one JSONL record. A `message_end` with a long tool result stays well below. */
const LINE_BYTES_MAX = 16 * 1024 * 1024;

/** Time the child gets after SIGTERM before SIGKILL. */
const STOP_GRACE_MS = 2_000;

export interface PiSpawnOptions {
    /** The `pi` executable, from `resolve_pi_binary`. */
    pi: string;
    cwd: string;
    /** `--session-dir`: where the transcript lives, `agents/<name>/pi` under the session. */
    session_dir: string;
    /** `--session-id`: opens the transcript with that id or creates it, so resume is spawn. */
    session_id: string;
    /** `provider/model`; pi's default when absent. */
    model?: string;
    /** Further CLI flags, for example `--append-system-prompt <brief>`. */
    extra_args?: string[];
    env?: Record<string, string>;
    /** Inherited variables to remove from the daemon's environment before `env` applies. */
    env_unset?: string[];
    /** Receives the child's stderr lines: pi's diagnostics, never protocol records. */
    on_stderr?: (line: string) => void;
}

/** A response record; `data` is typed per command by pi, `unknown` here. */
export interface PiResponse {
    id?: string;
    type: "response";
    command: string;
    success: boolean;
    data?: unknown;
    error?: string;
}

/** Any record pi writes: a response, a session event, or an extension UI record. */
type PiRecord =
    | PiResponse
    | PiEvent
    | { type: "extension_ui_request"; id: string; method: string };

export interface PiProcess {
    pid: number;
    /** Sends one command; resolves with its response, rejects when pi says `success: false`. */
    send(command: Record<string, unknown>): Promise<PiResponse>;
    on_event(listener: (event: PiEvent) => void): () => void;
    /** Resolves with the exit code (null on a signal) once the child is gone. */
    exited: Promise<number | null>;
    /** Closes stdin for an orderly shutdown, then SIGTERM, then SIGKILL. */
    stop(): Promise<number | null>;
}

/**
 * `SPINNER_PI` when set, else `pi` on `PATH`. pi may live under a node version other than
 * the daemon's (fnm installs it per version), so the daemon does not assume its own `bin`.
 */
export function resolve_pi_binary(env: NodeJS.ProcessEnv = process.env): string {
    const override = env["SPINNER_PI"];
    if (override !== undefined && override !== "") {
        if (!existsSync(override)) {
            throw new Error(`SPINNER_PI=${override} does not exist`);
        }
        return override;
    }
    const path = env["PATH"] ?? "";
    for (const dir of path.split(delimiter)) {
        if (dir.length === 0) {
            continue;
        }
        const candidate = join(dir, "pi");
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error(
        "pi is not on PATH; install @earendil-works/pi-coding-agent globally or set SPINNER_PI",
    );
}

/** Pi's `--model` takes a pattern and `--provider` the provider; `provider/model` splits once. */
export function model_args(model: string | undefined): string[] {
    if (model === undefined) {
        return [];
    }
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) {
        return ["--model", model];
    }
    return ["--provider", model.slice(0, slash), "--model", model.slice(slash + 1)];
}

/**
 * The argument list both harnesses hand pi: the transcript, the model and the extra flags.
 * `rpc` prepends `--mode rpc`; `tty` leaves the mode out so pi opens its terminal UI.
 * `--approve` trusts the worktree's project-local files for the run: the worktrees are the
 * operator's own repositories, and without it pi stops on its "Trust project folder?"
 * dialog, which no harness answers (dogfooding 2026-11-03, #23).
 */
export function pi_args(options: PiSpawnOptions, mode: "rpc" | "tty"): string[] {
    assert.ok(options.session_id.length > 0, "a pi session id is required");
    assert.ok(options.session_dir.length > 0, "a pi session dir is required");
    return [
        ...(mode === "rpc" ? ["--mode", "rpc"] : []),
        "--approve",
        "--session-dir",
        options.session_dir,
        "--session-id",
        options.session_id,
        ...model_args(options.model),
        ...(options.extra_args ?? []),
    ];
}

/** The daemon's environment without `env_unset`, then the spawn's own `env`. */
export function child_env(options: PiSpawnOptions): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !(options.env_unset ?? []).includes(key)) {
            env[key] = value;
        }
    }
    return { ...env, ...options.env };
}

/** Starts the child and resolves once its stdout answered a first `get_state`. */
export async function spawn_pi(options: PiSpawnOptions): Promise<PiProcess> {
    assert.ok(existsSync(options.cwd), `agent cwd ${options.cwd} does not exist`);
    // A missing binary makes `spawn` emit `error` after it returns, with no pid; checking
    // first turns that into a rejection the caller reports as "did not start".
    if (!existsSync(options.pi)) {
        throw new Error(`pi binary ${options.pi} does not exist`);
    }
    const args = pi_args(options, "rpc");
    const child = spawn(options.pi, args, {
        cwd: options.cwd,
        env: child_env(options),
        stdio: ["pipe", "pipe", "pipe"],
    });
    const process_ = new PiChild(child, options.on_stderr ?? (() => undefined));
    // The first command doubles as the startup check: a pi that fails to start closes
    // stdout without answering, and `send` rejects with its stderr.
    await process_.send({ type: "get_state" });
    return process_;
}

interface Pending {
    resolve: (response: PiResponse) => void;
    reject: (error: Error) => void;
}

class PiChild implements PiProcess {
    readonly pid: number;
    readonly exited: Promise<number | null>;
    private readonly pending = new Map<string, Pending>();
    private readonly listeners = new Set<(event: PiEvent) => void>();
    private next_id = 1;
    private stderr_tail: string[] = [];
    private exit_code: number | null | undefined;

    constructor(
        private readonly child: ChildProcess,
        on_stderr: (line: string) => void,
    ) {
        assert.ok(child.pid !== undefined, "pi did not spawn");
        assert.ok(child.stdout !== null && child.stdin !== null && child.stderr !== null);
        this.pid = child.pid;
        read_lines(child.stdout, (line) => this.handle_line(line));
        read_lines(child.stderr, (line) => {
            this.stderr_tail = [...this.stderr_tail.slice(-19), line];
            on_stderr(line);
        });
        this.exited = new Promise((resolve) => {
            child.once("exit", (code) => {
                this.exit_code = code;
                const tail = this.stderr_tail.join("\n");
                const error = new Error(`pi exited with ${code ?? "a signal"}: ${tail}`);
                for (const entry of this.pending.values()) {
                    entry.reject(error);
                }
                this.pending.clear();
                resolve(code);
            });
            child.once("error", (error) => {
                this.exit_code = null;
                for (const entry of this.pending.values()) {
                    entry.reject(error);
                }
                this.pending.clear();
                resolve(null);
            });
        });
    }

    send(command: Record<string, unknown>): Promise<PiResponse> {
        if (this.exit_code !== undefined) {
            return Promise.reject(new Error(`pi exited with ${this.exit_code ?? "a signal"}`));
        }
        assert.ok(this.pending.size < PENDING_MAX, "pi stopped answering commands");
        const id = `c-${this.next_id}`;
        this.next_id += 1;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            const stdin = this.child.stdin;
            assert.ok(stdin !== null);
            stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
                if (error !== null && error !== undefined) {
                    this.pending.delete(id);
                    reject(error);
                }
            });
        });
    }

    on_event(listener: (event: PiEvent) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    async stop(): Promise<number | null> {
        if (this.exit_code !== undefined) {
            return this.exit_code;
        }
        this.child.stdin?.end();
        const timer = setTimeout(() => this.child.kill("SIGTERM"), STOP_GRACE_MS);
        const killer = setTimeout(() => this.child.kill("SIGKILL"), STOP_GRACE_MS * 2);
        const code = await this.exited;
        clearTimeout(timer);
        clearTimeout(killer);
        return code;
    }

    private handle_line(line: string): void {
        let record: PiRecord;
        try {
            record = JSON.parse(line) as PiRecord;
        } catch {
            return;
        }
        if (record.type === "response") {
            const entry = record.id === undefined ? undefined : this.pending.get(record.id);
            if (entry === undefined) {
                return;
            }
            this.pending.delete(record.id ?? "");
            if (record.success) {
                entry.resolve(record);
            } else {
                entry.reject(new Error(record.error ?? `${record.command} failed`));
            }
            return;
        }
        if (record.type === "extension_ui_request") {
            // Dialogs cannot be answered without a person; `notify`, `setTitle` and the
            // widget calls need no answer. The daemon drops them all in v1.
            return;
        }
        for (const listener of this.listeners) {
            listener(record);
        }
    }
}

/**
 * Splits a byte stream on LF only. `readline` would also split on U+2028 and U+2029, which
 * are legal inside JSON strings (pi's `docs/rpc.md`, "Framing").
 */
function read_lines(stream: NodeJS.ReadableStream, on_line: (line: string) => void): void {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
        buffer += chunk;
        assert.ok(buffer.length <= LINE_BYTES_MAX, "pi wrote a record over the size bound");
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
            const line = buffer.slice(0, newline).replace(/\r$/, "");
            buffer = buffer.slice(newline + 1);
            if (line.length > 0) {
                on_line(line);
            }
            newline = buffer.indexOf("\n");
        }
    });
    stream.on("end", () => {
        if (buffer.length > 0) {
            on_line(buffer);
            buffer = "";
        }
    });
}
