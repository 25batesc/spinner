// The daemon's settings file, `<home>/config.yaml`, and the daemon's runtime files under the
// same home (`daemon.pid`, `daemon.log`). The file holds the non-secret settings only:
// `pi_bin`, `port`, `default_model`, `agents.harness`, `slack.channel`. The environment
// overrides each key (`SPINNER_PI`, `SPINNER_PORT`, `SPINNER_DEFAULT_MODEL`,
// `SPINNER_AGENTS_HARNESS`, `SPINNER_SLACK_CHANNEL`), so a
// shell or a launch agent can change one setting without editing the file. A missing file is
// fine. Secrets never enter the file: a key that looks like one is an error at start, so a
// token pasted in by mistake stops the daemon instead of sitting in a world-readable file.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { SpinnerHome } from "./home.js";

export interface DaemonConfig {
    /** The pi executable. `pi` on PATH when absent. */
    pi_bin?: string;
    /** TCP port of the daemon. `DAEMON_PORT` from the protocol when absent. */
    port?: number;
    /** `provider/model` for an agent tab that names no model. pi's own default when absent. */
    default_model?: string;
    agents: {
        /** How an agent tab's pi runs: `tty` (pi's own UI in a pty) or `rpc`. `tty` when absent. */
        harness?: "tty" | "rpc";
    };
    slack: {
        /** The channel `spinner post` uses when the project's spec names none. */
        channel?: string;
    };
}

export interface LoadedConfig {
    config: DaemonConfig;
    /** `<home>/config.yaml`, whether or not it exists. */
    path: string;
    /** True when the file was read. */
    found: boolean;
}

/** The environment variable that overrides each file key. */
export const CONFIG_ENV = {
    pi_bin: "SPINNER_PI",
    port: "SPINNER_PORT",
    default_model: "SPINNER_DEFAULT_MODEL",
    agents_harness: "SPINNER_AGENTS_HARNESS",
    slack_channel: "SPINNER_SLACK_CHANNEL",
} as const;

/** Keys the file may hold. Anything else is an error, so a typo does not silently do nothing. */
const CONFIG_KEYS = ["pi_bin", "port", "default_model", "agents", "slack"];
const AGENTS_KEYS = ["harness"];
const SLACK_KEYS = ["channel"];
const HARNESSES = ["tty", "rpc"];

/** A key that contains one of these names a secret, which belongs in `~/.spinner/env`. */
const SECRET_KEY_PATTERN = /token|secret|password|api_key|apikey/i;

/**
 * Reads `<home>/config.yaml` once and applies the environment on top. Throws with the path
 * and the key when the file does not parse, holds an unknown or secret-looking key, or holds
 * a value of the wrong type.
 */
export function load_config(home: SpinnerHome, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
    const path = join(home.root, "config.yaml");
    const found = existsSync(path);
    const config: DaemonConfig = found
        ? parse_config(readFileSync(path, "utf8"), path)
        : { agents: {}, slack: {} };
    apply_environment(config, env);
    assert.ok(config.port === undefined || Number.isInteger(config.port));
    return { config, path, found };
}

/** Pure: the file text to a `DaemonConfig`. Exported for tests; `load_config` is the entry. */
export function parse_config(text: string, path: string): DaemonConfig {
    const raw: unknown = parse(text);
    if (raw === null || raw === undefined) {
        return { agents: {}, slack: {} };
    }
    const root = record_or_throw(raw, path, "the file");
    check_keys(root, CONFIG_KEYS, path, "");
    const config: DaemonConfig = { agents: {}, slack: {} };
    const pi_bin = root["pi_bin"];
    if (pi_bin !== undefined) {
        config.pi_bin = string_or_throw(pi_bin, path, "pi_bin");
    }
    const port = root["port"];
    if (port !== undefined) {
        config.port = port_or_throw(port, path, "port");
    }
    const default_model = root["default_model"];
    if (default_model !== undefined) {
        config.default_model = string_or_throw(default_model, path, "default_model");
    }
    const agents = root["agents"];
    if (agents !== undefined) {
        const block = record_or_throw(agents, path, "agents");
        check_keys(block, AGENTS_KEYS, path, "agents.");
        const harness = block["harness"];
        if (harness !== undefined) {
            config.agents.harness = harness_or_throw(harness, path, "agents.harness");
        }
    }
    const slack = root["slack"];
    if (slack !== undefined) {
        const block = record_or_throw(slack, path, "slack");
        check_keys(block, SLACK_KEYS, path, "slack.");
        const channel = block["channel"];
        if (channel !== undefined) {
            config.slack.channel = string_or_throw(channel, path, "slack.channel");
        }
    }
    return config;
}

/** The environment wins over the file, key by key. An empty variable counts as unset. */
function apply_environment(config: DaemonConfig, env: NodeJS.ProcessEnv): void {
    const pi_bin = env[CONFIG_ENV.pi_bin];
    if (pi_bin !== undefined && pi_bin !== "") {
        config.pi_bin = pi_bin;
    }
    const port = env[CONFIG_ENV.port];
    if (port !== undefined && port !== "") {
        config.port = port_or_throw(Number(port), `$${CONFIG_ENV.port}`, port);
    }
    const default_model = env[CONFIG_ENV.default_model];
    if (default_model !== undefined && default_model !== "") {
        config.default_model = default_model;
    }
    const harness = env[CONFIG_ENV.agents_harness];
    if (harness !== undefined && harness !== "") {
        config.agents.harness = harness_or_throw(harness, `$${CONFIG_ENV.agents_harness}`, harness);
    }
    const channel = env[CONFIG_ENV.slack_channel];
    if (channel !== undefined && channel !== "") {
        config.slack.channel = channel;
    }
}

function harness_or_throw(value: unknown, path: string, key: string): "tty" | "rpc" {
    if (value === "tty" || value === "rpc") {
        return value;
    }
    throw new Error(`${path}: ${key} must be one of ${HARNESSES.join(", ")}`);
}

function check_keys(
    block: Record<string, unknown>,
    allowed: string[],
    path: string,
    prefix: string,
): void {
    for (const key of Object.keys(block)) {
        const name = `${prefix}${key}`;
        if (SECRET_KEY_PATTERN.test(key)) {
            throw new Error(
                `${path}: "${name}" looks like a secret; secrets go in ~/.spinner/env, not here`,
            );
        }
        if (!allowed.includes(key)) {
            throw new Error(`${path}: unknown key "${name}" (known: ${allowed.join(", ")})`);
        }
    }
}

function record_or_throw(value: unknown, path: string, what: string): Record<string, unknown> {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    throw new Error(`${path}: ${what} must be a mapping`);
}

function string_or_throw(value: unknown, path: string, key: string): string {
    if (typeof value === "string" && value.length > 0) {
        return value;
    }
    throw new Error(`${path}: ${key} must be a non-empty string`);
}

function port_or_throw(value: unknown, path: string, key: string): number {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65535) {
        return value;
    }
    throw new Error(`${path}: ${key} must be an integer from 0 to 65535`);
}

// ---------------------------------------------------------------------------------------
// Runtime files. The daemon writes `daemon.pid` once it listens and removes it on a clean
// shutdown; `spinner daemon` reads it. The log is where a background daemon's stderr goes.

export function daemon_pid_file(home: SpinnerHome): string {
    return join(home.root, "daemon.pid");
}

export function daemon_log_file(home: SpinnerHome): string {
    return join(home.root, "daemon.log");
}

/** The pid in the file, or null when there is no file or it holds no integer. */
export function read_daemon_pid(home: SpinnerHome): number | null {
    const file = daemon_pid_file(home);
    if (!existsSync(file)) {
        return null;
    }
    const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function write_daemon_pid(home: SpinnerHome, pid: number): void {
    assert.ok(pid > 0);
    writeFileSync(daemon_pid_file(home), `${pid}\n`);
}

/** Removes the pid file when it names `pid`, so a newer daemon's file is left alone. */
export function remove_daemon_pid(home: SpinnerHome, pid: number): void {
    if (read_daemon_pid(home) === pid) {
        unlinkSync(daemon_pid_file(home));
    }
}

/** True when a process with that pid exists. `EPERM` means it exists and is not ours. */
export function pid_alive(pid: number): boolean {
    assert.ok(pid > 0);
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

// ---------------------------------------------------------------------------------------
// Build identity, for `GET /health` and `spinner daemon status`. The daemon runs from the
// checkout's `packages/daemon/dist` in M3, so the identity is the checkout's commit plus the
// time `dist/main.js` was built, which tells a stale build from a fresh one.

export interface BuildIdentity {
    /** `@spinner/daemon`'s package version. */
    version: string;
    /** Short commit of the checkout the daemon runs from, or null outside a git checkout. */
    commit: string | null;
    /** Modification time of `dist/main.js`, ISO 8601, or null when it does not exist. */
    built: string | null;
}

/** Read once at start: `git rev-parse` is cheap but not free, and the answer does not change. */
export function build_identity(): BuildIdentity {
    const package_dir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const package_json = JSON.parse(readFileSync(join(package_dir, "package.json"), "utf8")) as {
        version?: string;
    };
    const version = package_json.version ?? "0.0.0";
    const main = join(package_dir, "dist", "main.js");
    const built = existsSync(main) ? statSync(main).mtime.toISOString() : null;
    let commit: string | null = null;
    try {
        commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
            cwd: package_dir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 5_000,
        }).trim();
    } catch {
        commit = null;
    }
    return { version, commit, built };
}

/** `0.0.0 (abc1234, built 2026-10-29T09:41:00Z)`, the one-line form for status and logs. */
export function describe_build(build: BuildIdentity): string {
    const commit = build.commit ?? "no git";
    const built = build.built === null ? "not built" : `built ${build.built}`;
    const parts = [commit, built];
    return `${build.version} (${parts.join(", ")})`;
}
