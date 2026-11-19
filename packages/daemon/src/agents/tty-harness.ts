// `PiTtyHarness`: the default agent adapter since s009. pi runs interactively in a pseudo-
// terminal (`node-pty`) in the agent's worktree with the same arguments as the RPC harness
// (`pi_spawn_options`, `pi_args` without `--mode rpc`), plus `SPINNER_HARNESS=tty` and
// `TERM=xterm-256color`. The agent tab renders the pty over a WebSocket (`routes-tty.ts`):
// one pty, up to `TTY_ATTACHMENTS_MAX` clients, a `TTY_SCROLLBACK_BYTES` ring the daemon
// replays on attach. The daemon never types into the pty for the operator: `prompt`, `steer`
// and `abort` go through the Spinner extension inside pi, over `ExtensionChannel`
// (MISSION.md s009, Contracts), so the transcript records a message, not keystrokes.
// `spawn` resolves when the extension posts `hello`, or `READY_GRACE_MS` after the pty
// started when pi is still alive but has not (pi can sit on a "Press any key" notice that the
// operator answers in the tab); the pty's exit before either is a failed start. `stop` is
// SIGTERM, then SIGKILL after `STOP_GRACE_MS`.
import assert from "node:assert/strict";
import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { IPty, spawn as PtySpawn } from "node-pty";
import type {
    PiCommandInfo,
    PiEvent,
    SessionSummary,
    ThinkingLevel,
    TtyResize,
} from "@spinner/protocol";
import { TTY_ATTACHMENTS_MAX, TTY_SCROLLBACK_BYTES, TTY_SIZE_DEFAULT } from "@spinner/protocol";
import { ExtensionChannel, type AgentSetting } from "./extension-channel.js";
import {
    pi_spawn_options,
    resolved_extension,
    type AgentHandle,
    type AgentHarness,
    type AgentSpawnSpec,
    type PiCommand,
    type PiHarnessOptions,
} from "./harness.js";
import { child_env, pi_args, PiRefusal, type PiSpawnOptions } from "./pi-rpc.js";

/** Time pi gets after SIGTERM before SIGKILL. pi flushes its transcript on SIGTERM. */
const STOP_GRACE_MS = 5_000;

/**
 * Time a pty that has not posted `hello` gets before `spawn` resolves anyway. pi's startup
 * notices wait for a key the operator presses in the tab; the extension's `hello` then
 * follows. A pty that exits inside the grace is a failed start.
 */
const READY_GRACE_MS = 3_000;

export interface PiTtyHarnessOptions extends PiHarnessOptions {
    /** For tests: a shorter grace before `spawn` resolves without `hello`. */
    ready_grace_ms?: number;
    /** For tests: a shorter wait for the extension's ack. */
    ack_timeout_ms?: number;
}

/** One attached WebSocket, as the pty side sees it. The route adapts `ws` to this. */
export interface TtyClient {
    send_bytes(chunk: Buffer): void;
    send_text(text: string): void;
    close(code: number, reason: string): void;
}

export class PiTtyHarness implements AgentHarness {
    private readonly agents = new Map<string, TtyAgent>();

    constructor(private readonly options: PiTtyHarnessOptions) {}

    spawn(session: SessionSummary, agent: AgentSpawnSpec): Promise<AgentHandle> {
        return this.start(session, agent);
    }

    /** The same as `spawn`: `--session-id` reopens the transcript when it exists. */
    resume(session: SessionSummary, agent: AgentSpawnSpec): Promise<AgentHandle> {
        return this.start(session, agent);
    }

    /** The running tty agent of `dir/name`, for the routes; null when none runs here. */
    lookup(dir: string, name: string): TtyAgent | null {
        return this.lookup_key(key_of(dir, name));
    }

    /**
     * The tty agent under `key` (`spawn_pty`'s), from the moment the pty exists: the
     * extension's `hello` must find it while `spawn_pty` still waits for that hello.
     */
    lookup_key(key: string): TtyAgent | null {
        return this.agents.get(key) ?? null;
    }

    private async start(session: SessionSummary, agent: AgentSpawnSpec): Promise<AgentHandle> {
        const key = key_of(session.dir, agent.name);
        assert.ok(!this.agents.has(key), `tty agent ${agent.name} already runs in ${session.dir}`);
        const spawn = pi_spawn_options(session, agent, this.options);
        const tty = await this.spawn_pty(key, agent.name, spawn);
        return tty.handle;
    }

    /**
     * One pty under `key`, for a session agent (`<dir>/<name>`) or the operator agent
     * (`operator`, from `operator.ts`): spawns pi, waits for `hello` or the grace, and
     * forgets the entry when the pty exits. A failed start stops the pty and rethrows.
     */
    async spawn_pty(key: string, name: string, spawn: PiSpawnOptions): Promise<TtyAgent> {
        assert.ok(!this.agents.has(key), `a tty agent already runs under ${key}`);
        assert.ok(
            resolved_extension(this.options) !== null,
            "the tty harness needs the Spinner pi extension; it is the daemon's only channel",
        );
        assert.ok(existsSync(spawn.cwd), `agent cwd ${spawn.cwd} does not exist`);
        if (!existsSync(spawn.pi)) {
            throw new Error(`pi binary ${spawn.pi} does not exist`);
        }
        const env: Record<string, string> = {
            ...child_env(spawn),
            SPINNER_HARNESS: "tty",
            TERM: "xterm-256color",
        };
        const pty = load_node_pty();
        const child = pty.spawn(spawn.pi, pi_args(spawn, "tty"), {
            name: "xterm-256color",
            cols: TTY_SIZE_DEFAULT.cols,
            rows: TTY_SIZE_DEFAULT.rows,
            cwd: spawn.cwd,
            env,
        });
        const channel = new ExtensionChannel(this.options.ack_timeout_ms);
        const tty = new TtyAgent(child, channel, name);
        this.agents.set(key, tty);
        void tty.exited.then(() => {
            this.agents.delete(key);
        });
        const on_stderr = this.options.on_stderr;
        try {
            await tty.wait_ready(this.options.ready_grace_ms ?? READY_GRACE_MS);
        } catch (error) {
            const tail = tty.scrollback_text().split("\n").slice(-20).join("\n");
            on_stderr?.(name, tail);
            await tty.stop();
            throw error;
        }
        return tty;
    }
}

/** The line pi prints under a startup warning; it waits for a key before the session starts. */
export const PI_STARTUP_NOTICE = "Press any key to continue";

/** The gap between the two resizes of a redraw nudge; pi coalesces renders within a frame. */
const REDRAW_NUDGE_MS = 60;

/** One pty and what hangs off it: the extension channel, the scrollback, the attachments. */
export class TtyAgent {
    readonly exited: Promise<number | null>;
    readonly handle: AgentHandle;
    private readonly attachments = new Set<TtyClient>();
    private scrollback: Buffer = Buffer.alloc(0);
    private size: TtyResize = { ...TTY_SIZE_DEFAULT };
    private sized_by_client = false;
    /** Set by `attach`; the next same-size resize nudges pi into a full redraw. */
    private redraw_pending = false;
    private exit_code: number | null | undefined;
    /** pi's startup notice waits for a key; the daemon presses it once, nobody else can. */
    private startup_notice_answered = false;

    constructor(
        private readonly pty: IPty,
        readonly channel: ExtensionChannel,
        readonly name: string,
    ) {
        this.pty.onData((data) => this.on_data(Buffer.from(data, "utf8")));
        this.exited = new Promise((resolve) => {
            this.pty.onExit(({ exitCode, signal }) => {
                const code = signal !== undefined && signal !== 0 ? null : exitCode;
                this.exit_code = code;
                this.channel.close(`pi exited with ${code ?? "a signal"}`);
                const frame = JSON.stringify({ exit: { code } });
                for (const client of this.attachments) {
                    client.send_text(frame);
                    client.close(1000, "pi exited");
                }
                this.attachments.clear();
                resolve(code);
            });
        });
        this.handle = new PiTtyHandle(this, name);
    }

    get pid(): number {
        return this.pty.pid;
    }

    get attachment_count(): number {
        return this.attachments.size;
    }

    /**
     * Adds a client: it receives the scrollback at once, then every chunk. Returns the detach.
     * Throws past `TTY_ATTACHMENTS_MAX`; the route answers 409 before the upgrade.
     */
    attach(client: TtyClient): () => void {
        assert.ok(this.attachments.size < TTY_ATTACHMENTS_MAX, "too many tty attachments");
        assert.ok(this.exit_code === undefined, "the pty has exited");
        this.attachments.add(client);
        client.send_bytes(Buffer.from(this.scrollback));
        this.redraw_pending = true;
        return () => {
            this.attachments.delete(client);
        };
    }

    /** Keystrokes from a client, unchanged. */
    write(bytes: Buffer): void {
        if (this.exit_code !== undefined) {
            return;
        }
        this.pty.write(bytes.toString("utf8"));
    }

    /** The pty's size is the last resize from any client (Contracts). */
    resize(size: TtyResize): void {
        if (this.exit_code !== undefined) {
            return;
        }
        if (size.cols === this.size.cols && size.rows === this.size.rows) {
            this.sized_by_client = true;
            if (this.redraw_pending) {
                this.nudge_redraw();
            }
            return;
        }
        this.size = { ...size };
        this.sized_by_client = true;
        this.redraw_pending = false;
        this.pty.resize(size.cols, size.rows);
    }

    /**
     * A client that attaches replays the scrollback ring, which starts at an arbitrary byte
     * and holds pi's relative cursor moves; the screen it paints differs from what pi
     * believes is there, and every later differential update leaves stale rows (dogfooding
     * #30). pi's TUI clears the screen and renders everything on a width change, so one
     * column off and back, two SIGWINCHes, gives the client a screen that matches pi's model.
     * A same-size resize alone sends no SIGWINCH.
     */
    private nudge_redraw(): void {
        this.redraw_pending = false;
        const { cols, rows } = this.size;
        if (cols < 3) {
            return;
        }
        this.pty.resize(cols - 1, rows);
        setTimeout(() => {
            const unchanged = this.size.cols === cols && this.size.rows === rows;
            if (this.exit_code === undefined && unchanged) {
                this.pty.resize(cols, rows);
            }
        }, REDRAW_NUDGE_MS);
    }

    /** `{cols, rows}` and whether a client set it, for the route test and the docs' claim. */
    current_size(): TtyResize & { from_client: boolean } {
        return { ...this.size, from_client: this.sized_by_client };
    }

    scrollback_text(): string {
        return this.scrollback.toString("utf8");
    }

    /** Resolves on `hello`, or after `grace_ms` with pi still alive; rejects when pi exits. */
    wait_ready(grace_ms: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.exit_code === undefined) {
                    resolve();
                }
            }, grace_ms);
            this.channel.wait_hello().then(
                () => {
                    clearTimeout(timer);
                    resolve();
                },
                (error: Error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            );
        });
    }

    /** SIGTERM, then SIGKILL after `STOP_GRACE_MS`; resolves with the exit code. */
    async stop(): Promise<number | null> {
        if (this.exit_code !== undefined) {
            return this.exit_code;
        }
        this.pty.kill("SIGTERM");
        const killer = setTimeout(() => {
            if (this.exit_code === undefined) {
                this.pty.kill("SIGKILL");
            }
        }, STOP_GRACE_MS);
        const code = await this.exited;
        clearTimeout(killer);
        return code;
    }

    private on_data(chunk: Buffer): void {
        const joined = Buffer.concat([this.scrollback, chunk]);
        this.scrollback =
            joined.length > TTY_SCROLLBACK_BYTES
                ? joined.subarray(joined.length - TTY_SCROLLBACK_BYTES)
                : joined;
        for (const client of this.attachments) {
            client.send_bytes(chunk);
        }
        if (!this.startup_notice_answered && chunk.includes(PI_STARTUP_NOTICE)) {
            // Before `hello`, no human watches this terminal; the notice would block pi for good.
            this.startup_notice_answered = true;
            this.pty.write("\r");
        }
    }
}

class PiTtyHandle implements AgentHandle {
    readonly pid: number;
    readonly exited: Promise<number | null>;

    constructor(
        private readonly tty: TtyAgent,
        readonly pi_session_id: string,
    ) {
        this.pid = tty.pid;
        this.exited = tty.exited;
    }

    prompt(text: string, images: readonly string[] = []): Promise<string> {
        assert.ok(text.length > 0, "a prompt must not be empty");
        return this.tty.channel.enqueue("prompt", text, images);
    }

    steer(text: string, images: readonly string[] = []): Promise<string> {
        assert.ok(text.length > 0, "a steer must not be empty");
        return this.tty.channel.enqueue("steer", text, images);
    }

    async abort(): Promise<void> {
        await this.tty.channel.enqueue("abort");
    }

    compact(): Promise<string> {
        return this.tty.channel.enqueue("compact");
    }

    notify(text: string): Promise<string> {
        assert.ok(text.length > 0, "a notice must not be empty");
        return this.tty.channel.enqueue("notify", text);
    }

    set_model(model: string): Promise<void> {
        return this.configure({ type: "set_model", model });
    }

    set_thinking(level: ThinkingLevel): Promise<void> {
        return this.configure({ type: "set_thinking", level });
    }

    /** The extension acks a setting with `ok`, or with pi's error text. */
    private async configure(setting: AgentSetting): Promise<void> {
        const disposition = await this.tty.channel.configure(setting);
        if (disposition !== "ok") {
            throw new PiRefusal(disposition);
        }
    }

    /** What the extension posted with its last `hello`; empty before it. */
    commands(): Promise<PiCommand[]> {
        const hello = this.tty.channel.hello;
        const commands: PiCommandInfo[] = hello === null ? [] : hello.commands;
        return Promise.resolve(commands as PiCommand[]);
    }

    on_event(listener: (event: PiEvent) => void): () => void {
        return this.tty.channel.on_event(listener);
    }

    stop(): Promise<number | null> {
        return this.tty.stop();
    }
}

/**
 * `node-pty` through `require`: it is a CommonJS native module, and loading it lazily keeps
 * a daemon whose prebuilt binary is missing able to serve everything but tty agents. pnpm
 * installs the darwin prebuilt's `spawn-helper` without the exec bit, which makes every spawn
 * fail with `posix_spawnp failed`; the bit is set here once, before the first spawn.
 */
function load_node_pty(): { spawn: typeof PtySpawn } {
    const require_ = createRequire(import.meta.url);
    const entry = require_.resolve("node-pty");
    const helper = join(
        dirname(dirname(entry)),
        "prebuilds",
        `${process.platform}-${process.arch}`,
        "spawn-helper",
    );
    if (existsSync(helper)) {
        try {
            accessSync(helper, constants.X_OK);
        } catch {
            chmodSync(helper, 0o755);
        }
    }
    return require_("node-pty") as { spawn: typeof PtySpawn };
}

function key_of(dir: string, name: string): string {
    return `${dir}/${name}`;
}
