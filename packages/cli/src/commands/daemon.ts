// `spinner daemon start|stop|status|logs|install|uninstall`: the daemon as a tool. `start`
// runs the checkout's build (`packages/daemon/dist/main.js`) in the background with its
// output in `<home>/daemon.log`; the daemon writes `<home>/daemon.pid` itself, so `status`
// and `stop` find a daemon no matter who started it, the CLI or launchd. `install` writes a
// macOS launch agent that starts the daemon at login; it sources `<home>/env` for secrets
// (mode 600, written by the user, never by Spinner). The port comes from `config.yaml` or
// `SPINNER_PORT`, the same way the daemon reads it, so both sides agree on the URL.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    realpathSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    daemon_log_file,
    daemon_pid_file,
    describe_build,
    load_config,
    pid_alive,
    read_daemon_pid,
    run,
    run_attached,
    type SpinnerHome,
} from "@spinner/daemon";
import { DAEMON_HOST, DAEMON_PORT, type HealthResponse } from "@spinner/protocol";
import { describe_error, type CliIo, type Command } from "./command.js";

export const daemon_command: Command = {
    name: "daemon",
    usage: "start|stop|status|logs [--no-follow]|install|uninstall",
    summary: "run spinnerd in the background; launch it at login (macOS)",
    run: run_daemon,
};

/** How long `start` waits for `/health` before it gives up and shows the log. */
const START_WAIT_MS = 20_000;
/** How long `stop` waits after SIGTERM before SIGKILL. */
const STOP_WAIT_MS = 10_000;
const POLL_MS = 200;
const HEALTH_TIMEOUT_MS = 2_000;
/** Lines of the log shown when `start` fails. */
const LOG_TAIL_LINES = 20;
const LAUNCHD_LABEL_DEFAULT = "dev.spinner.daemon";

async function run_daemon(args: string[], home: SpinnerHome, io: CliIo): Promise<number> {
    const verb = args[0];
    const rest = args.slice(1);
    let port: number;
    try {
        port = load_config(home, io.env).config.port ?? DAEMON_PORT;
    } catch (error) {
        io.err(`spinner daemon: ${describe_error(error)}`);
        return 1;
    }
    const target: Target = { home, port, url: `http://${DAEMON_HOST}:${port}` };
    switch (verb) {
        case "start":
            return start(target, io);
        case "stop":
            return stop(target, io);
        case "status":
            return status(target, io);
        case "logs":
            return logs(target, rest, io);
        case "install":
            return install(target, io);
        case "uninstall":
            return uninstall(io);
        default:
            io.err(`spinner daemon: expected start, stop, status, logs, install or uninstall`);
            return 1;
    }
}

interface Target {
    home: SpinnerHome;
    port: number;
    url: string;
}

/** The daemon's process, from the pid file: alive, stale (file removed), or absent. */
type Presence =
    | { state: "alive"; pid: number }
    | { state: "stale"; pid: number }
    | { state: "absent" };

function presence(home: SpinnerHome): Presence {
    const pid = read_daemon_pid(home);
    if (pid === null) {
        return { state: "absent" };
    }
    if (pid_alive(pid)) {
        return { state: "alive", pid };
    }
    // A daemon that was killed leaves its file; the next start must not be blocked by it.
    unlinkSync(daemon_pid_file(home));
    return { state: "stale", pid };
}

async function start(target: Target, io: CliIo): Promise<number> {
    const found = presence(target.home);
    if (found.state === "alive") {
        io.out(`spinner daemon: already running (pid ${found.pid}) at ${target.url}`);
        return 0;
    }
    if (found.state === "stale") {
        io.out(`spinner daemon: removed stale pid file (pid ${found.pid} is gone)`);
    }
    const main = daemon_main_path();
    if (!existsSync(main)) {
        io.err(`spinner daemon: ${main} does not exist; run \`pnpm -r build\` first`);
        return 1;
    }
    mkdirSync(target.home.root, { recursive: true });
    const log_file = daemon_log_file(target.home);
    const log_fd = openSync(log_file, "a");
    const child = spawn(process.execPath, [main], {
        cwd: repo_root(),
        env: { ...io.env, SPINNER_HOME: target.home.root },
        detached: true,
        stdio: ["ignore", log_fd, log_fd],
    });
    closeSync(log_fd);
    let exited: number | null | undefined;
    child.on("exit", (code) => {
        exited = code;
    });
    child.unref();
    assert.ok(child.pid !== undefined, "spawn without an error must have a pid");

    const deadline = Date.now() + START_WAIT_MS;
    while (Date.now() < deadline) {
        if (exited !== undefined) {
            const how = exited ?? "a signal";
            io.err(`spinner daemon: spinnerd exited with ${how} before it listened`);
            io.err(tail(log_file, LOG_TAIL_LINES));
            return 1;
        }
        const health = await fetch_health(target.url);
        if (health !== null) {
            io.out(`spinner daemon: started (pid ${child.pid}) at ${target.url}`);
            io.out(`spinner daemon: build ${describe_build(health.build)}, log ${log_file}`);
            return 0;
        }
        await sleep(POLL_MS);
    }
    io.err(`spinner daemon: ${target.url} did not answer within ${START_WAIT_MS / 1000} s`);
    io.err(tail(log_file, LOG_TAIL_LINES));
    return 1;
}

async function stop(target: Target, io: CliIo): Promise<number> {
    const found = presence(target.home);
    if (found.state !== "alive") {
        io.out(`spinner daemon: not running`);
        return 0;
    }
    process.kill(found.pid, "SIGTERM");
    const deadline = Date.now() + STOP_WAIT_MS;
    while (Date.now() < deadline) {
        if (!pid_alive(found.pid)) {
            io.out(`spinner daemon: stopped (pid ${found.pid})`);
            return 0;
        }
        await sleep(POLL_MS);
    }
    // A daemon stuck in shutdown (a hung agent, a Docker call) must still go away.
    process.kill(found.pid, "SIGKILL");
    io.out(`spinner daemon: pid ${found.pid} ignored SIGTERM for ${STOP_WAIT_MS / 1000} s; killed`);
    if (existsSync(daemon_pid_file(target.home))) {
        unlinkSync(daemon_pid_file(target.home));
    }
    return 0;
}

async function status(target: Target, io: CliIo): Promise<number> {
    const found = presence(target.home);
    if (found.state === "absent") {
        io.out(`spinner daemon: not running (home ${target.home.root})`);
        return 1;
    }
    if (found.state === "stale") {
        io.out(`spinner daemon: not running (stale pid file for ${found.pid} removed)`);
        return 1;
    }
    const health = await fetch_health(target.url);
    if (health === null) {
        io.out(`spinner daemon: pid ${found.pid} is alive but ${target.url} does not answer`);
        io.out(`spinner daemon: is the port in config.yaml or SPINNER_PORT the one it uses?`);
        return 1;
    }
    io.out(`spinner daemon: running (pid ${found.pid}) at ${target.url}`);
    const ui = health.ui_commit ?? "none";
    io.out(`spinner daemon: build ${describe_build(health.build)}, ui ${ui}`);
    io.out(`spinner daemon: started ${health.started}, home ${health.home}`);
    return 0;
}

async function logs(target: Target, args: string[], io: CliIo): Promise<number> {
    const log_file = daemon_log_file(target.home);
    if (!existsSync(log_file)) {
        io.err(`spinner daemon: no log at ${log_file}; the daemon has not started here yet`);
        return 1;
    }
    if (args.includes("--no-follow")) {
        io.out(tail(log_file, 100));
        return 0;
    }
    return run_attached("tail", ["-n", "100", "-f", log_file]);
}

async function install(target: Target, io: CliIo): Promise<number> {
    if (process.platform !== "darwin") {
        io.err(`spinner daemon install: launch agents are macOS only, not ${process.platform}`);
        return 1;
    }
    const main = daemon_main_path();
    if (!existsSync(main)) {
        io.err(`spinner daemon: ${main} does not exist; run \`pnpm -r build\` first`);
        return 1;
    }
    const env_file = join(target.home.root, "env");
    if (existsSync(env_file)) {
        const mode = statSync(env_file).mode & 0o777;
        if (mode !== 0o600) {
            const octal = mode.toString(8);
            io.err(`spinner daemon install: ${env_file} has mode ${octal}; run chmod 600 on it`);
            return 1;
        }
    }
    const label = launchd_label(io.env);
    const plist_path = launch_agent_path(label);
    mkdirSync(dirname(plist_path), { recursive: true });
    mkdirSync(target.home.root, { recursive: true });
    writeFileSync(plist_path, render_plist(label, target, main, io.env));
    // `bootout` first so a re-install picks up the new file; a missing job is not an error.
    await run("launchctl", ["bootout", `${launchd_domain()}/${label}`]);
    const result = await run("launchctl", ["bootstrap", launchd_domain(), plist_path]);
    if (result.code !== 0) {
        const detail = result.stderr.trim();
        io.err(`spinner daemon install: launchctl bootstrap failed (${result.code}): ${detail}`);
        return 1;
    }
    io.out(`spinner daemon: installed ${plist_path} (label ${label})`);
    io.out(`spinner daemon: secrets go in ${env_file} (mode 600); the agent sources it at login`);
    return 0;
}

async function uninstall(io: CliIo): Promise<number> {
    if (process.platform !== "darwin") {
        io.err(`spinner daemon uninstall: launch agents are macOS only`);
        return 1;
    }
    const label = launchd_label(io.env);
    const plist_path = launch_agent_path(label);
    await run("launchctl", ["bootout", `${launchd_domain()}/${label}`]);
    if (existsSync(plist_path)) {
        unlinkSync(plist_path);
        io.out(`spinner daemon: removed ${plist_path}`);
    } else {
        io.out(`spinner daemon: ${plist_path} was not installed`);
    }
    // `bootout` sends SIGTERM; the daemon removes its own pid file on the way out.
    return 0;
}

/**
 * The launch agent. `/bin/sh` sources `<home>/env` (secrets, user-written) with `set -a` so
 * plain `NAME=value` lines export, then execs node on the checkout's build. PATH is the
 * installing shell's, because launchd's own PATH has no Homebrew, fnm or Docker.
 */
function render_plist(label: string, target: Target, main: string, env: NodeJS.ProcessEnv): string {
    const script = [
        "set -a",
        '[ -f "$SPINNER_HOME/env" ] && . "$SPINNER_HOME/env"',
        "set +a",
        'exec "$0" "$1"',
    ].join("; ");
    const log_file = daemon_log_file(target.home);
    // The installing shell may reach node through a per-shell path (fnm's multishell links
    // vanish with the shell), so the real node directory goes first and node is absolute.
    const node = realpathSync(process.execPath);
    const path = [dirname(node), env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"].join(":");
    const home_dir = env["HOME"] ?? homedir();
    const variables: Record<string, string> = {
        HOME: home_dir,
        PATH: path,
        SPINNER_HOME: target.home.root,
    };
    const extras = ["SPINNER_PORT", "SPINNER_PI", "SPINNER_PROXY_DIR"] as const;
    for (const name of extras) {
        const value = env[name];
        if (value !== undefined && value !== "") {
            variables[name] = value;
        }
    }
    const dict = Object.entries(variables)
        .map(([key, value]) => {
            return `        <key>${xml(key)}</key>\n        <string>${xml(value)}</string>`;
        })
        .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xml(label)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>${xml(script)}</string>
        <string>${xml(node)}</string>
        <string>${xml(main)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(repo_root())}</string>
    <key>EnvironmentVariables</key>
    <dict>
${dict}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${xml(log_file)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(log_file)}</string>
</dict>
</plist>
`;
}

/** `SPINNER_LAUNCHD_LABEL` lets a test install a scratch agent next to the real one. */
function launchd_label(env: NodeJS.ProcessEnv): string {
    const override = env["SPINNER_LAUNCHD_LABEL"];
    return override !== undefined && override !== "" ? override : LAUNCHD_LABEL_DEFAULT;
}

/** The per-user launchd domain, `gui/<uid>`, where login items live. */
function launchd_domain(): string {
    const uid = process.getuid?.() ?? 0;
    return `gui/${uid}`;
}

function launch_agent_path(label: string): string {
    return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function xml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** `packages/daemon/dist/main.js`, from `packages/cli/{src,dist}/commands/daemon.{ts,js}`. */
function daemon_main_path(): string {
    return join(repo_root(), "packages", "daemon", "dist", "main.js");
}

function repo_root(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

async function fetch_health(url: string): Promise<HealthResponse | null> {
    try {
        const response = await fetch(`${url}/health`, {
            signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        if (!response.ok) {
            return null;
        }
        const body = (await response.json()) as HealthResponse;
        return body.ok === true ? body : null;
    } catch {
        return null;
    }
}

function tail(file: string, lines: number): string {
    assert.ok(lines > 0);
    if (!existsSync(file)) {
        return "";
    }
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
