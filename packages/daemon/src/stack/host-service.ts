// Services with `runtime: host`: Spinner starts their command on the host, in the worktree,
// with a per-session port, and routes their hostname through the proxy to
// `host.docker.internal`. For a backend whose dependencies have no wheel for the container
// platform. The process outlives the CLI; `down` and `close` stop it by pid.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { request as http_request } from "node:http";
import { dirname, join } from "node:path";
import type { HostProcess, StackService } from "@spinner/protocol";
import { stringify } from "yaml";
import { compose_project, hostname } from "./compose.js";
import { run } from "./shell.js";

export interface HostServiceInput {
    name: string;
    service: StackService;
    /** Absolute worktree path of the service's repo. */
    worktree: string;
    /** Absolute session directory. */
    session_dir: string;
    port: number;
    /** The service's `env` after substitution. */
    env: Record<string, string>;
}

/**
 * Starts the service detached, stdout and stderr appended to `log/<name>.log`, and returns
 * the record for `session.yaml`. The wrapper, when set, is a path relative to the worktree.
 */
export function start_host_service(input: HostServiceInput): HostProcess {
    const { service } = input;
    assert.ok(service.command !== undefined, `services.${input.name}: host needs a command`);
    const cwd = join(input.worktree, service.workdir ?? ".");
    const wrapper =
        service.wrapper === undefined ? "" : `${host_wrapper(service.wrapper, input.worktree)} `;
    const log = join("log", `${input.name}.log`);
    const log_path = join(input.session_dir, log);
    mkdirSync(dirname(log_path), { recursive: true });
    const fd = openSync(log_path, "a");
    // No `exec`: a command may be a compound one, and the process group (see `stop_host_process`)
    // reaches the shell and whatever it runs.
    const child = spawn("sh", ["-c", host_command_line(wrapper, input.env, input.port, service)], {
        cwd,
        env: { ...process.env, ...input.env, PORT: String(input.port) },
        stdio: ["ignore", fd, fd],
        detached: true,
    });
    child.unref();
    // The child holds its own copies of the descriptor; the parent closes its one so that
    // `spinner up` keeps no handle on the log and exits as soon as its work is done.
    closeSync(fd);
    assert.ok(child.pid !== undefined, `could not start ${input.name}`);
    return { pid: child.pid, port: input.port, log };
}

/**
 * `<wrapper> env K=V ... sh -c '<command>'`: Spinner's values are applied by `env` inside
 * the wrapper, after a secrets injector such as Doppler has set its own, so the session's
 * `DATABASE_URL`, `PORT` and the like win. The inner shell lets `command` be a compound
 * command. Values are single-quoted for the shell.
 */
export function host_command_line(
    wrapper: string,
    env: Record<string, string>,
    port: number,
    service: Pick<StackService, "command">,
): string {
    assert.ok(service.command !== undefined);
    const pairs = Object.entries({ ...env, PORT: String(port) }).map(
        ([key, value]) => `${key}=${shell_quote(value)}`,
    );
    return `${wrapper}env ${pairs.join(" ")} sh -c ${shell_quote(service.command.trim())}`;
}

function shell_quote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

function host_wrapper(wrapper: string, worktree: string): string {
    const [first, ...rest] = wrapper.trim().split(/\s+/);
    assert.ok(first !== undefined && first.length > 0, "wrapper must not be empty");
    const on_path = first.startsWith("/") || !first.includes("/");
    return [on_path ? first : join(worktree, first), ...rest].join(" ");
}

/** Bound on one preflight command. */
const PREFLIGHT_TIMEOUT_MS = 5 * 60_000;
/** Lines of output kept from a failed preflight or a dead service. */
export const TAIL_LINES = 20;

export interface PreflightResult {
    ok: boolean;
    /** The last lines of the combined output, for the error message. */
    tail: string;
}

/**
 * Runs `preflight` the way the service will run: in `workdir`, through the wrapper, with
 * Spinner's env applied last. Resolves with the outcome; never throws for a failing command.
 */
export async function run_preflight(input: HostServiceInput): Promise<PreflightResult> {
    const { service } = input;
    assert.ok(service.preflight !== undefined, `services.${input.name}: no preflight`);
    const cwd = join(input.worktree, service.workdir ?? ".");
    const wrapper =
        service.wrapper === undefined ? "" : `${host_wrapper(service.wrapper, input.worktree)} `;
    const line = host_command_line(wrapper, input.env, input.port, { command: service.preflight });
    const result = await run("sh", ["-c", line], {
        cwd,
        env: { ...process.env, ...input.env, PORT: String(input.port) },
        timeout_ms: PREFLIGHT_TIMEOUT_MS,
    });
    return { ok: result.code === 0, tail: tail_lines(`${result.stdout}${result.stderr}`) };
}

/** The last `TAIL_LINES` non-empty lines of a text. */
export function tail_lines(text: string): string {
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    return lines.slice(-TAIL_LINES).join("\n");
}

/** Lines that mean a hostname did not resolve, across Python, Node and libc. */
const RESOLVE_FAILURE = /gaierror|Name or service not known|nodename nor servname|ENOTFOUND/;

/** Upper bound on hostnames looked up from one log. */
const HOSTNAMES_MAX = 50;

export interface ExitDiagnosis {
    /** The last lines of the log. */
    tail: string;
    /** The first hostname in the log that does not resolve, or null. */
    unresolved: string | null;
    /** The variable that holds that hostname in the service's dotenv file, or null. */
    variable: string | null;
}

/**
 * Why a host service died: the log tail, and when the log says a name did not resolve, the
 * first hostname mentioned anywhere in the log that DNS cannot find. The name usually comes
 * from the injector or a dotenv file, not from the spec, so the variable that carries it in
 * `<workdir>/.env` is named when found.
 */
export async function diagnose_host_exit(
    log_text: string,
    dotenv_text: string,
): Promise<ExitDiagnosis> {
    const tail = tail_lines(log_text);
    if (!RESOLVE_FAILURE.test(log_text)) {
        return { tail, unresolved: null, variable: null };
    }
    const unresolved = await first_unresolved(hostnames_in(log_text));
    const variable = unresolved === null ? null : variable_holding(dotenv_text, unresolved);
    return { tail, unresolved, variable };
}

/** Hostnames in URLs (`://user:pw@host:port`) and `host=`/`host:` fields, in order, unique. */
function hostnames_in(text: string): string[] {
    const found: string[] = [];
    const url_host = `\\/\\/(?:[^\\s/@'"]*@)?`;
    const field_host = `\\bhost(?:name)?\\s*[=:]\\s*['"]?`;
    const name = "([a-zA-Z][a-zA-Z0-9.-]*[a-zA-Z0-9])";
    const pattern = new RegExp(`(?:${url_host}|${field_host})${name}`, "g");
    for (const match of text.matchAll(pattern)) {
        const name = match[1];
        if (name !== undefined && name.includes(".") && !found.includes(name)) {
            found.push(name);
        }
        if (found.length >= HOSTNAMES_MAX) {
            break;
        }
    }
    return found;
}

async function first_unresolved(names: string[]): Promise<string | null> {
    for (const name of names) {
        try {
            await lookup(name);
        } catch {
            return name;
        }
    }
    return null;
}

function variable_holding(dotenv_text: string, hostname: string): string | null {
    for (const line of dotenv_text.split("\n")) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        if (match?.[1] !== undefined && line.includes(hostname)) {
            return match[1];
        }
    }
    return null;
}

/** A line that says the application gave up, from uvicorn and the like. */
const STARTUP_FAILED = /Application startup failed/;

/**
 * True when the log holds a Python traceback whose last line names an error, or a line that
 * says the application startup failed. A dev server under `uvicorn --reload` keeps its
 * reloader parent alive after the application failed, so a live pid does not mean a working
 * service. JSON log lines carry the traceback in an `exc_info` string with escaped newlines,
 * so those are unescaped before the scan.
 */
export function log_shows_traceback(log_text: string): boolean {
    if (STARTUP_FAILED.test(log_text)) {
        return true;
    }
    const unescaped = log_text.replace(/\\n/g, "\n");
    const lines = unescaped.split("\n").filter((line) => line.trim().length > 0);
    let in_traceback = false;
    for (const line of lines) {
        if (line.includes("Traceback (most recent call last):")) {
            in_traceback = true;
            continue;
        }
        if (in_traceback && /^[A-Za-z_][\w.]*(Error|Exception)\b/.test(line.trimStart())) {
            return true;
        }
    }
    return false;
}

export function process_alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** Polls of 100 ms after SIGTERM before SIGKILL: 5 s. */
const STOP_POLLS_MAX = 50;

/** Stops a process group: SIGTERM, then SIGKILL after the bound. A dead pid is fine. */
export async function stop_host_process(pid: number): Promise<"stopped" | "absent"> {
    if (!process_alive(pid)) {
        return "absent";
    }
    // The process was started as its own group leader (`detached`), so the negative pid
    // reaches the wrapper and the command it exec'd into, and any children.
    signal_group(pid, "SIGTERM");
    for (let poll = 0; poll < STOP_POLLS_MAX; poll += 1) {
        if (!process_alive(pid)) {
            return "stopped";
        }
        await sleep(100);
    }
    signal_group(pid, "SIGKILL");
    return "stopped";
}

/**
 * Ends every process whose command line names `path`: children a service spawned outside
 * its process group (Python's multiprocessing resource trackers and spawned workers under a
 * reloader). Returns the pids it signalled. `pgrep` is bounded by the process table.
 */
export async function kill_processes_under(path: string): Promise<number[]> {
    assert.ok(path.length > 1, "path must not be empty");
    const result = await run("pgrep", ["-f", path]);
    const pids = String(result.stdout)
        .split("\n")
        .map((line) => Number.parseInt(line, 10))
        .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid);
    for (const pid of pids) {
        try {
            process.kill(pid, "SIGTERM");
        } catch {
            // Gone already.
        }
    }
    for (let poll = 0; poll < STOP_POLLS_MAX && pids.some(process_alive); poll += 1) {
        await sleep(100);
    }
    for (const pid of pids.filter(process_alive)) {
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // Gone already.
        }
    }
    return pids;
}

function signal_group(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            // Already gone between the check and the signal.
        }
    }
}

/** True when `http://127.0.0.1:<port><path>` answers with a status below 500. */
export function host_answers(port: number, path: string): Promise<boolean> {
    return new Promise((resolve) => {
        const request = http_request({ host: "127.0.0.1", port, path }, (response) => {
            response.resume();
            resolve((response.statusCode ?? 500) < 500);
        });
        request.setTimeout(3_000, () => request.destroy());
        request.on("error", () => resolve(false));
        request.end();
    });
}

/** The service directory the proxy watches; `<home>/proxy`, mounted into `spinner-proxy`. */
export function proxy_dir(home_root: string): string {
    return join(home_root, "proxy");
}

/**
 * Writes the Traefik dynamic-configuration file for a session's host services, which the
 * proxy picks up through its file provider. Routes go to `host.docker.internal`, which
 * Docker Desktop resolves to the host.
 */
export function write_proxy_routes(
    home_root: string,
    session_id: string,
    routes: { name: string; host: string; port: number }[],
): string {
    const project = compose_project(session_id);
    const routers: Record<string, unknown> = {};
    const services: Record<string, unknown> = {};
    for (const route of routes) {
        const key = `${project}-${route.name}`;
        routers[key] = {
            rule: `Host(\`${hostname(route.host, session_id)}\`)`,
            entryPoints: ["web"],
            service: key,
        };
        services[key] = {
            loadBalancer: { servers: [{ url: `http://host.docker.internal:${route.port}` }] },
        };
    }
    const path = join(proxy_dir(home_root), `${project}.yaml`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, stringify({ http: { routers, services } }));
    return path;
}

export function proxy_routes_path(home_root: string, session_id: string): string {
    return join(proxy_dir(home_root), `${compose_project(session_id)}.yaml`);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
