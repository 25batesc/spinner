// `spinner doctor`: one line per check, `ok` or `FAIL`, each with what was found and what to
// do. The checks are the things the README's newcomer path trips over: the home inside a
// git repo, Docker down, `gh` logged out, no `pi`, an old Node, a stopped proxy or Postgres,
// a `config.yaml` that does not parse, the diff viewer and EGM fetched or not, pi-subagents
// in the pi settings or not. Exit 1 when any check fails. The Slack token is reported as
// present or absent only; both are fine, its value is never printed.
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import {
    DIFF_PINS,
    EGM_PIN,
    daemon_pid_file,
    describe_build,
    diff_fetched,
    diff_viewer_bin,
    egm_fetched,
    pi_settings_path,
    read_egm_marker,
    read_fetch_marker,
    subagents_installed,
    is_inside_git_repo,
    load_config,
    pid_alive,
    read_daemon_pid,
    resolve_pi_binary,
    run,
    type SpinnerHome,
} from "@spinner/daemon";
import { DAEMON_HOST, DAEMON_PORT, type HealthResponse } from "@spinner/protocol";
import { describe_error, type CliIo, type Command } from "./command.js";

export const doctor_command: Command = {
    name: "doctor",
    usage: "",
    summary: "check the machine: home, Node, Docker, gh, pi, proxy, Postgres, token, config",
    run: run_doctor,
};

interface Check {
    name: string;
    ok: boolean;
    /** What was found, then the hint when it failed or when the state is worth a note. */
    detail: string;
}

/** The Node major the daemon needs (`engines` in the root package.json). */
const NODE_MAJOR_MIN = 24;
const SLACK_TOKEN_ENV = "SLACK_USER_TOKEN";
/** One external command's upper bound; `docker info` on a sleeping Docker Desktop is slow. */
const COMMAND_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 2_000;

async function run_doctor(args: string[], home: SpinnerHome, io: CliIo): Promise<number> {
    if (args.length > 0) {
        io.err(`spinner doctor: takes no arguments`);
        return 1;
    }
    const checks: Check[] = [
        check_home(home),
        check_node(),
        await check_docker(io.env),
        await check_gh(io.env),
        check_config_and_pi(home, io.env),
        await check_container("proxy", "spinner-proxy", io.env),
        await check_container("postgres", "spinner-postgres", io.env),
        check_env_file(home),
        check_token(io.env),
        await check_daemon(home, io.env),
        check_diffview(home),
        check_egm(home),
        check_subagents(io.env),
    ];
    assert.ok(checks.length === 13, "every check reports exactly one line");
    const width = Math.max(...checks.map((check) => check.name.length));
    for (const check of checks) {
        const mark = check.ok ? "ok  " : "FAIL";
        io.out(`${mark}  ${check.name.padEnd(width)}  ${check.detail}`);
    }
    const failed = checks.filter((check) => !check.ok);
    if (failed.length === 0) {
        return 0;
    }
    io.out(`${failed.length} check(s) failed: ${failed.map((check) => check.name).join(", ")}`);
    return 1;
}

function check_home(home: SpinnerHome): Check {
    const name = "home";
    if (!existsSync(home.root)) {
        return pass(name, `${home.root} (not created yet; the daemon creates it)`);
    }
    if (is_inside_git_repo(home.root)) {
        const hint = "set SPINNER_HOME to a directory outside any repository";
        return fail(name, `${home.root} is inside a git repository; ${hint}`);
    }
    return pass(name, home.root);
}

function check_node(): Check {
    const name = "node";
    const version = process.versions.node;
    const major = Number.parseInt(version.split(".")[0] ?? "0", 10);
    if (major < NODE_MAJOR_MIN) {
        return fail(name, `v${version}; Spinner needs Node ${NODE_MAJOR_MIN} or newer`);
    }
    return pass(name, `v${version}`);
}

async function check_docker(env: NodeJS.ProcessEnv): Promise<Check> {
    const name = "docker";
    const result = await run(
        "docker",
        ["info", "--format", "{{.ServerVersion}} {{.OperatingSystem}}"],
        { env, timeout_ms: COMMAND_TIMEOUT_MS },
    );
    if (result.code === 127) {
        return fail(name, "docker is not on PATH; install Docker Desktop or OrbStack");
    }
    if (result.code !== 0) {
        return fail(name, `docker info failed; start Docker (${first_line(result.stderr)})`);
    }
    return pass(name, `Docker ${String(result.stdout).trim()}`);
}

async function check_gh(env: NodeJS.ProcessEnv): Promise<Check> {
    const name = "gh";
    const result = await run("gh", ["auth", "status"], { env, timeout_ms: COMMAND_TIMEOUT_MS });
    if (result.code === 127) {
        return fail(name, "gh is not on PATH; install GitHub CLI, then gh auth login");
    }
    if (result.code !== 0) {
        return fail(name, `not logged in; run gh auth login (${first_line(result.stderr)})`);
    }
    // `gh auth status` prints to stdout in new versions and to stderr in old ones.
    const text = `${String(result.stdout)}\n${result.stderr}`;
    const account = /Logged in to (\S+) account (\S+)/.exec(text);
    const who = account === null ? "logged in" : `${account[2]} on ${account[1]}`;
    return pass(name, who);
}

/** `config.yaml` and `pi` are one check: the file names `pi_bin`, so a bad file hides pi. */
function check_config_and_pi(home: SpinnerHome, env: NodeJS.ProcessEnv): Check {
    const name = "pi";
    let pi_bin: string | undefined;
    let config_note = "";
    try {
        const loaded = load_config(home, env);
        pi_bin = loaded.config.pi_bin;
        config_note = loaded.found ? `from ${loaded.path}` : "no config.yaml, defaults";
    } catch (error) {
        return fail(name, describe_error(error));
    }
    let path: string;
    try {
        path = resolve_pi_binary(pi_bin === undefined ? env : { ...env, SPINNER_PI: pi_bin });
    } catch (error) {
        return fail(name, `${describe_error(error)} (${config_note})`);
    }
    return pass(name, `${path} (${config_note})`);
}

async function check_container(
    name: string,
    container: string,
    env: NodeJS.ProcessEnv,
): Promise<Check> {
    const result = await run(
        "docker",
        ["inspect", "--format", "{{.State.Status}}", container],
        { env, timeout_ms: COMMAND_TIMEOUT_MS },
    );
    if (result.code === 127) {
        // The docker check above carries the failure; this line only says what is unknown.
        return pass(name, `${container} state unknown; docker is not on PATH`);
    }
    if (result.code !== 0) {
        return pass(name, `${container} absent; the first spinner up creates it`);
    }
    const state = String(result.stdout).trim();
    if (state === "running") {
        return pass(name, `${container} running`);
    }
    const hint = `run docker start ${container}, or spinner up a session`;
    return fail(name, `${container} is ${state}; ${hint}`);
}

/** `<home>/env` is optional; when it exists the launch agent sources it, so it must be 600. */
function check_env_file(home: SpinnerHome): Check {
    const name = "env";
    const file = `${home.root}/env`;
    if (!existsSync(file)) {
        return pass(name, `${file} absent (optional; secrets for the launch agent)`);
    }
    const mode = statSync(file).mode & 0o777;
    if (mode !== 0o600) {
        return fail(name, `${file} has mode ${mode.toString(8)}; run chmod 600 on it`);
    }
    return pass(name, `${file} (mode 600)`);
}

/** The diff viewer is fetched on first use; absent is fine and is reported as a note. */
function check_diffview(home: SpinnerHome): Check {
    const name = "diffview";
    const marker = read_fetch_marker(home);
    if (diff_fetched(home) && marker !== null) {
        return pass(name, `${diff_viewer_bin(home)} (fetched ${marker.fetched.slice(0, 10)})`);
    }
    if (marker !== null) {
        const pin = DIFF_PINS.viewer.sha.slice(0, 12);
        const detail = `fetched ${marker.viewer.slice(0, 12)}, pin is ${pin}`;
        return pass(name, `${detail}; the next diff tab click fetches again`);
    }
    return pass(name, `not fetched (optional; the first diff tab click fetches it)`);
}

/** EGM is optional: a lead starts without it. The pin is `EGM_PIN` in the daemon. */
function check_egm(home: SpinnerHome): Check {
    const name = "egm";
    const marker = read_egm_marker(home);
    if (egm_fetched(home) && marker !== null) {
        const sha = EGM_PIN.sha.slice(0, 12);
        const date = marker.fetched.slice(0, 10);
        return pass(name, `${sha} fetched ${date} (adapter v${marker.adapter_version})`);
    }
    return pass(name, "not fetched (Spinner fetches it when a lead starts, or: POST /egm/fetch)");
}

/** pi-subagents gives the lead the `subagent` tool; without it EGM stays off. */
function check_subagents(env: NodeJS.ProcessEnv): Check {
    const name = "pi-subagents";
    if (subagents_installed(env)) {
        return pass(name, "installed");
    }
    return pass(name, `not in ${pi_settings_path(env)}; EGM stays off`);
}

function check_token(env: NodeJS.ProcessEnv): Check {
    const name = "slack";
    const token = env[SLACK_TOKEN_ENV];
    if (token === undefined || token === "") {
        const note = "spinner post records to the fixture instead of Slack";
        return pass(name, `${SLACK_TOKEN_ENV} absent; ${note}`);
    }
    return pass(name, `${SLACK_TOKEN_ENV} present`);
}

async function check_daemon(home: SpinnerHome, env: NodeJS.ProcessEnv): Promise<Check> {
    const name = "daemon";
    const pid = read_daemon_pid(home);
    if (pid === null || !pid_alive(pid)) {
        const stale = pid === null ? "" : ` (stale ${daemon_pid_file(home)})`;
        return pass(name, `not running${stale}; run spinner daemon start`);
    }
    let port = DAEMON_PORT;
    try {
        port = load_config(home, env).config.port ?? DAEMON_PORT;
    } catch {
        // The pi check reported the broken file already; the default port is the best guess.
    }
    const url = `http://${DAEMON_HOST}:${port}`;
    try {
        const response = await fetch(`${url}/health`, {
            signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        const body = (await response.json()) as HealthResponse;
        const build = describe_build(body.build);
        return pass(name, `running (pid ${pid}) at ${url}, build ${build}`);
    } catch {
        return fail(name, `pid ${pid} is alive but ${url}/health does not answer`);
    }
}

function pass(name: string, detail: string): Check {
    return { name, ok: true, detail };
}

function fail(name: string, detail: string): Check {
    return { name, ok: false, detail };
}

function first_line(text: string): string {
    return text.trim().split("\n")[0] ?? "";
}
