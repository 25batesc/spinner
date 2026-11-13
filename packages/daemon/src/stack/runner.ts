// The stack runner: `new` attaches a project to a session (spec copy, worktrees), `up` brings
// the stack to healthy, `down` stops it, `close` removes everything the session created. Every
// step is idempotent so a retry after a failure continues where the last run stopped.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    copyFileSync,
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { request as http_request } from "node:http";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { stringify } from "yaml";
import type {
    DatabaseSeed,
    HostProcess,
    Session,
    SessionSummary,
    StackService,
    StackSpec,
} from "@spinner/protocol";
import { add_worktree, fetch_base, remove_worktree } from "../git/worktree.js";
import type { SpinnerHome } from "../home.js";
import { write_session, write_session_field } from "../store/session-store.js";
import {
    compose_network,
    compose_project,
    hostname,
    port_variables,
    render_compose,
    session_variables,
    substitute_env,
    type DepsInfo,
    type Rendered,
} from "./compose.js";
import {
    POSTGRES_ALIAS,
    POSTGRES_CONTAINER,
    PROXY_CONTAINER,
    build_image,
    compose,
    compose_attached,
    compose_down,
    connect_network,
    project_status,
    disconnect_network,
    ensure_postgres_container,
    ensure_proxy,
    ensure_volume,
    find_dev_dockerfile,
    image_exists,
    network_exists,
    project_has_containers,
    remove_container,
    remove_project_containers,
    shared_use_lines,
    spinner_projects,
    container_info,
    proxy_mount_of,
    type ComposeTarget,
} from "./docker.js";
import {
    diagnose_host_exit,
    host_answers,
    import_error_line,
    kill_pids,
    log_shows_traceback,
    pid_file,
    processes_with_cwd_under,
    read_pid_files,
    process_alive,
    is_spinner_leader,
    homes_in_route_files,
    proxy_routes_path,
    route_files_in,
    run_preflight,
    start_host_service,
    stop_host_process,
    write_proxy_routes,
    type UpstreamRoute,
} from "./host-service.js";
import { DatabaseServer, server_address } from "./postgres.js";
import { run_attached, run_ok } from "./shell.js";
import { load_spec, type LoadedSpec } from "./spec.js";

export type Log = (line: string) => void;

/** The copy of the project's spec that a session keeps, with absolute paths. */
export const SESSION_SPEC = join("stack", "spinner.yaml");
export const COMPOSE_FILE = join("stack", "compose.yaml");
const ENV_FILE = join("stack", ".env");
const PROXY_PORT_DEFAULT = 80;
const POSTGRES_VERSION_DEFAULT = "16";

/**
 * A host service whose log shows a traceback and whose port does not answer counts as failed
 * after this long, even with a live pid (a reloader parent survives the crash).
 */
const HOST_TRACEBACK_GRACE_MS = 15_000;

/**
 * Bound on the wait for healthchecks: 600 polls of 1 s is 10 minutes, for a first install.
 * Docker probes the container every 250 ms itself; this wait only reads the result, and
 * `docker compose ps` costs about half a second, so polling faster than 1 s spends the wait
 * on process startup.
 */
const HEALTH_POLLS_MAX = 600;
const HEALTH_INTERVAL_MS = 1_000;

export function session_db(session_id: string): string {
    return `spinner_${session_id}`;
}

export function template_name(spec: StackSpec): string {
    return spec.database?.template ?? `${spec.name}_seed`;
}

/**
 * True when the stack has a database: the spec has a `database` block. Without one, `up` runs
 * no Postgres container, clones no template and joins no database to the network, and
 * `close` and `reset` drop nothing. A project whose checks are its tests (Spinner itself) needs
 * no seed to exist.
 */
export function stack_has_database(spec: StackSpec): boolean {
    return spec.database !== undefined;
}

/** Reads the session's own spec copy. Throws when the session has no project. */
export function read_session_spec(summary: SessionSummary): LoadedSpec {
    const path = join(summary.path, SESSION_SPEC);
    if (!existsSync(path)) {
        throw new Error(`${summary.dir} has no stack; create it with spinner new --project`);
    }
    return load_spec(path);
}

export interface AttachOptions {
    /**
     * Repo name to branch for a repo whose worktree is not on the session branch: an adopted
     * PR's head branch, fetched by the caller. Other repos use the session branch.
     */
    branches?: Record<string, string>;
    /** The branch the adopted PRs target, kept instead of the spec's base. */
    base?: string;
}

/**
 * Copies the spec into the session, records the repos and makes one worktree per repo on
 * the session branch. Runs at `spinner new --project` and is safe to run again.
 */
export async function attach_project(
    summary: SessionSummary,
    loaded: LoadedSpec,
    log: Log,
    options: AttachOptions = {},
): Promise<SessionSummary> {
    const { spec } = loaded;
    const session = summary.session;
    mkdirSync(join(summary.path, "stack"), { recursive: true });
    const copy = join(summary.path, SESSION_SPEC);
    if (loaded.path !== copy) {
        write_spec_copy(copy, spec);
    }
    session.project = spec.name;
    session.base = options.base ?? spec.base;
    // One fetch per checkout, together: two services in one repo must not fetch at once,
    // and two checkouts need not wait for each other. The copy and install stay in order.
    const repos = Object.entries(spec.repos);
    const fetches = new Map<string, { path: string; base: string }>();
    for (const [, repo] of repos) {
        const base = repo.base ?? spec.base;
        fetches.set(`${repo.path}\0${base}`, { path: repo.path, base });
    }
    await Promise.all([...fetches.values()].map((item) => fetch_base(item.path, item.base)));
    const outcomes = await Promise.all(repos.map(async ([name, repo]) => {
        const worktree = join("worktrees", name);
        const branch = options.branches?.[name] ?? session.branch;
        const outcome = await add_worktree({
            repo_path: repo.path,
            worktree_path: join(summary.path, worktree),
            branch,
            base: repo.base ?? spec.base,
            session_dir: summary.path,
        });
        return { name, repo, worktree, branch, outcome };
    }));
    for (const { name, repo, worktree, branch, outcome } of outcomes) {
        log(`worktree ${worktree} ${outcome} (${repo.path} on ${branch})`);
        // Links and installs come before the file copies: a copy into `node_modules/...`
        // would create that directory and block the link.
        const links = repo.seed_links ?? [];
        const links_done = link_seed_dirs(repo.path, join(summary.path, worktree), links);
        if (links_done.linked.length > 0) {
            log(`  linked to the primary checkout: ${links_done.linked.join(", ")}`);
        }
        if (links_done.present.length > 0) {
            log(`  already in the worktree, not linked: ${links_done.present.join(", ")}`);
        }
        for (const skipped of links_done.skipped) {
            log(`  not linked: ${skipped.dir}; ${skipped.lockfile} differs from the primary`);
            const install = install_command_for(spec, name, skipped.dir);
            if (install === null) {
                log(`    no install: command for it; install by hand in the worktree`);
                continue;
            }
            log(`    running ${install} in ${skipped.cwd}`);
            const code = await run_attached("sh", ["-c", install], skipped.cwd);
            if (code !== 0) {
                // Not fatal: the session and its lead start without the dependencies, and
                // the lead is told (`INSTALL_FAILED`), so the operator's request is not
                // lost to a broken lockfile. `up` fails on its own when it needs them.
                log(`    ${INSTALL_FAILED} for ${name}/${skipped.dir} (exit code ${code})`);
            }
        }
        const files = repo.seed_files ?? [];
        const copied = copy_seed_files(repo.path, join(summary.path, worktree), files);
        if (copied.length > 0) {
            log(`  copied from the primary checkout: ${copied.join(", ")}`);
        }
        // An adopted session already tracks the repo's PR; the worktree joins that entry.
        const current = session.repos[name];
        session.repos[name] = {
            path: repo.path,
            worktree,
            changed: current?.changed ?? false,
            pr: current?.pr ?? null,
        };
    }
    session.stack = {
        project: compose_project(session.id),
        state: "down",
        hosts: spec_hosts(spec, session.id),
        db: session_db(session.id),
    };
    write_session(summary);
    return summary;
}

/**
 * Copies local files (`.npmrc`, `.env.local`) from the primary checkout into the worktree:
 * untracked files the worktree lacks, and tracked files whose primary copy carries local
 * edits (tokens filled in). Returns the paths it copied. A file the primary checkout does
 * not have is skipped, not an error, so a fresh clone still works.
 */
export function copy_seed_files(repo_path: string, worktree: string, files: string[]): string[] {
    const copied: string[] = [];
    for (const file of files) {
        assert.ok(!file.startsWith("/") && !file.includes(".."), `seed_files entry: ${file}`);
        const source = join(repo_path, file);
        const target = join(worktree, file);
        if (!existsSync(source)) {
            continue;
        }
        if (existsSync(target) && realpathSync(target) === realpathSync(source)) {
            // The target lives inside a linked directory: it is the source itself.
            continue;
        }
        mkdirSync(dirname(target), { recursive: true });
        if (statSync(source).isDirectory()) {
            // A directory entry (a vendored binary's folder) is copied whole, every time.
            cpSync(source, target, { recursive: true });
            copied.push(file);
            continue;
        }
        if (existsSync(target) && readFileSync(target).equals(readFileSync(source))) {
            continue;
        }
        copyFileSync(source, target);
        copied.push(file);
    }
    return copied;
}

interface SkippedLink {
    dir: string;
    lockfile: string;
    /** The worktree directory the install must run in. */
    cwd: string;
}

interface LinkOutcome {
    linked: string[];
    skipped: SkippedLink[];
    /** Entries the worktree already had at that path; nothing was done to them. */
    present: string[];
}

/** Lockfiles that pin what a linked directory holds, next to it, in lookup order. */
const LINK_LOCKFILES = [
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "requirements-ci.txt",
    "uv.lock",
    "requirements.txt",
];

/**
 * Symlinks heavy local directories (`.venv`, `node_modules`) to the primary checkout's copy
 * when the worktree has nothing at that path and the lockfile next to the directory is the
 * same in both; a branch that changed the lockfile gets its own install instead. A
 * directory the primary checkout lacks is skipped.
 */
export function link_seed_dirs(repo_path: string, worktree: string, dirs: string[]): LinkOutcome {
    const outcome: LinkOutcome = { linked: [], skipped: [], present: [] };
    for (const dir of dirs) {
        assert.ok(!dir.startsWith("/") && !dir.includes(".."), `seed_links entry: ${dir}`);
        const source = join(repo_path, dir);
        const target = join(worktree, dir);
        if (!existsSync(source)) {
            continue;
        }
        if (existsSync(target) || lstat_exists(target)) {
            outcome.present.push(dir);
            continue;
        }
        const parent = dirname(dir);
        const lockfile = LINK_LOCKFILES.find((name) => existsSync(join(repo_path, parent, name)));
        const same =
            lockfile === undefined ||
            same_file(join(repo_path, parent, lockfile), join(worktree, parent, lockfile));
        if (!same && lockfile !== undefined) {
            outcome.skipped.push({ dir, lockfile, cwd: join(worktree, parent) });
            continue;
        }
        mkdirSync(dirname(target), { recursive: true });
        symlinkSync(source, target);
        exclude_from_git(worktree, dir);
        outcome.linked.push(dir);
    }
    return outcome;
}

/**
 * Lists the link in the repository's `info/exclude`. A `.gitignore` entry with a trailing
 * slash (`node_modules/`) matches directories only, and git reports a symlink as a file, so
 * without this the link shows as untracked and the reset's clean-tree check refuses. Git reads
 * `info/exclude` from the common dir, which a linked worktree names in its `commondir` file
 * (`git rev-parse --git-path info/exclude`); the worktree's own `.git/worktrees/<name>/info`
 * is never read.
 */
function exclude_from_git(worktree: string, dir: string): void {
    const dot_git = join(worktree, ".git");
    if (!existsSync(dot_git)) {
        return;
    }
    const git_dir = statSync(dot_git).isDirectory()
        ? dot_git
        : readFileSync(dot_git, "utf8").replace(/^gitdir:\s*/u, "").trim();
    if (git_dir.length === 0) {
        return;
    }
    const commondir = join(git_dir, "commondir");
    const common = existsSync(commondir)
        ? resolve(git_dir, readFileSync(commondir, "utf8").trim())
        : git_dir;
    mkdirSync(join(common, "info"), { recursive: true });
    appendFileSync(join(common, "info", "exclude"), `/${dir}\n`);
}

function same_file(a: string, b: string): boolean {
    if (!existsSync(a) || !existsSync(b)) {
        return false;
    }
    const hash = (path: string): string =>
        createHash("sha256").update(readFileSync(path)).digest("hex");
    return hash(a) === hash(b);
}

/** The `install:` of the service of `repo` whose workdir holds `dir`, or null. */
function install_command_for(spec: StackSpec, repo: string, dir: string): string | null {
    const parent = normalize(dirname(dir));
    for (const service of Object.values(spec.services)) {
        if (service.repo === repo && normalize(service.workdir ?? ".") === parent) {
            return service.install ?? null;
        }
    }
    return null;
}

function lstat_exists(path: string): boolean {
    try {
        lstatSync(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * The copy keeps the absolute paths `load_spec` resolved, so the session stays valid from any
 * directory. Comments of the project spec do not survive; the header says where to edit.
 */
function write_spec_copy(copy: string, spec: StackSpec): void {
    const header =
        "# Copied by spinner new from the project spec; paths are absolute.\n" +
        "# Edit the project spec and run spinner new again; do not edit this copy.\n";
    writeFileSync(copy, `${header}${stringify(spec, { lineWidth: 0 })}`);
}

export function spec_hosts(spec: StackSpec, session_id: string): Record<string, string> {
    const hosts: Record<string, string> = {};
    for (const [name, service] of Object.entries(spec.services)) {
        if (service.host !== undefined) {
            hosts[name] = hostname(service.host, session_id);
        }
    }
    return hosts;
}

export interface UpOptions {
    /** Rebuild dev images even when they exist. */
    build?: boolean;
}

export interface UpResult {
    hosts: Record<string, string>;
    db: string;
    elapsed_ms: number;
}

/** The start of the log line of a dependency install that failed at `attach`. */
export const INSTALL_FAILED = "install failed";

/** Brings the session's stack up and waits until every healthcheck passes. */
export async function stack_up(
    home: SpinnerHome,
    summary: SessionSummary,
    options: UpOptions,
    log: Log,
): Promise<UpResult> {
    const started = Date.now();
    set_stack_state(summary, "starting");
    try {
        const { hosts, processes } = await start_stack(home, summary, options, log);
        const db = session_db(summary.session.id);
        const project = compose_project(summary.session.id);
        summary.session.stack = { project, state: "up", hosts, db, processes };
        // Only the stack: the start took minutes, and the rest of the file moved on.
        write_session_field(summary, "stack");
        return { hosts, db, elapsed_ms: Date.now() - started };
    } catch (error) {
        // `failed` tells the board and the UI that a retry or a `close` is due; the containers
        // stay for `spinner logs` to show what went wrong.
        set_stack_state(summary, "failed");
        throw error;
    }
}

interface Started {
    hosts: Record<string, string>;
    processes: Record<string, HostProcess>;
}

/** Drops the session database at `close`; a stack without a database has none to drop. */
async function drop_session_database(spec: StackSpec, session: Session, log: Log): Promise<void> {
    if (!stack_has_database(spec)) {
        return;
    }
    if (spec.database?.server !== "external") {
        // After `down --shared` the managed server is gone but its data volume, and the
        // session database in it, remain; start it again to drop the database.
        await ensure_postgres_container(spec.database?.version ?? POSTGRES_VERSION_DEFAULT);
    }
    const server = new DatabaseServer(server_address(spec.database));
    await server.wait_ready(spec.database?.server !== "external");
    const db = session_db(session.id);
    log(`database ${db}: ${await server.drop_database(db)}`);
}

/** Clones the session database from the template; a stack without a database has none. */
async function clone_session_database(
    spec: StackSpec,
    session: Session,
    db: string,
    log: Log,
): Promise<string> {
    if (!stack_has_database(spec)) {
        return "none (the spec has no database block)";
    }
    const server = new DatabaseServer(server_address(spec.database));
    await server.wait_ready(spec.database?.server !== "external");
    if (session.stack.db_stale === true) {
        // A reset ran while the stack was down; the clone holds the previous round.
        log(`database ${db}: ${await server.drop_database(db)} (stale after reset)`);
    }
    return server.clone_from_template(db, template_name(spec));
}

async function start_stack(
    home: SpinnerHome,
    summary: SessionSummary,
    options: UpOptions,
    log: Log,
): Promise<Started> {
    const { spec } = read_session_spec(summary);
    const session = summary.session;
    const target = compose_target(summary);
    const network = compose_network(session.id);
    const db = session_db(session.id);

    const proxy_dir = await ensure_shared_containers(home, spec, log);
    // The clone, the image builds and the network do not depend on each other. The connects
    // do: the proxy and Postgres must be on the network before compose starts the services.
    const [cloned] = await Promise.all([
        clone_session_database(spec, session, db, log),
        ensure_images(spec, options.build === true, log),
        (async () => {
            if (!(await network_exists(network))) {
                await run_ok("docker", ["network", "create", network]);
            }
        })(),
    ]);
    log(`database ${db}: ${cloned}`);
    await connect_network(network, PROXY_CONTAINER);
    if (stack_has_database(spec) && spec.database?.server !== "external") {
        await connect_network(network, POSTGRES_CONTAINER, POSTGRES_ALIAS);
    }

    const rendered = render_stack(summary, spec, db);
    const services = Object.fromEntries(
        Object.entries(spec.services).filter(([, service]) => service.runtime !== "host"),
    );
    for (const volume of rendered.deps_volumes) {
        await ensure_volume(volume);
    }
    for (const file of rendered.env_files) {
        mkdirSync(dirname(file.path), { recursive: true });
        writeFileSync(file.path, file.content);
    }
    if (Object.keys(services).length > 0) {
        await compose(target, ["up", "--detach", "--remove-orphans", "--quiet-pull"]);
    }
    const processes = await start_host_services(proxy_dir, summary, spec, rendered, log);
    await wait_healthy(summary, target, spec, processes, log);
    const http_port = spec.proxy?.http_port ?? PROXY_PORT_DEFAULT;
    await wait_routes(route_probes(spec, rendered.hosts), http_port);
    return { hosts: rendered.hosts, processes };
}

/**
 * Starts each `runtime: host` service that is not already running, on its deterministic
 * port, and writes the proxy routes for them. Returns the records for `session.yaml`.
 */
async function start_host_services(
    proxy_dir: string,
    summary: SessionSummary,
    spec: StackSpec,
    rendered: Rendered,
    log: Log,
): Promise<Record<string, HostProcess>> {
    const session = summary.session;
    const current = session.stack.processes ?? {};
    const processes: Record<string, HostProcess> = {};
    const routes: { name: string; host: string; port: number }[] = [];
    const db = session_db(session.id);
    const variables = {
        ...session_variables({ id: session.id, branch: session.branch, dir: summary.path, db }),
        ...port_variables(rendered.published),
    };
    for (const [name, service] of Object.entries(spec.services)) {
        if (service.runtime !== "host") {
            continue;
        }
        const port = rendered.host_ports[name];
        assert.ok(port !== undefined, `no port for host service ${name}`);
        const existing = current[name];
        if (existing !== undefined && existing.port === port && process_alive(existing.pid)) {
            processes[name] = existing;
        } else {
            assert.ok(service.repo !== undefined, `services.${name}: host runtime needs a repo`);
            const repo = session.repos[service.repo];
            assert.ok(repo?.worktree !== undefined, `repo ${service.repo} has no worktree`);
            // `${PORT}` is this service's own port. The renderer substitutes it too, for the
            // env file; this pass covers a host service that has no env file.
            const own = { ...variables, PORT: String(port) };
            const env = substitute_env(service.env ?? {}, own, []);
            const input = {
                name,
                service,
                worktree: join(summary.path, repo.worktree),
                session_dir: summary.path,
                port,
                env,
            };
            if (service.preflight !== undefined) {
                log(`preflight ${name}: ${service.preflight}`);
                const result = await run_preflight(input);
                if (!result.ok) {
                    throw new Error(`preflight of ${name} failed:\n${result.tail}`);
                }
            }
            processes[name] = start_host_service(input);
            log(`started ${name} on the host (pid ${processes[name].pid}, port ${port})`);
        }
        if (service.host !== undefined) {
            routes.push({ name, host: service.host, port });
        }
    }
    // Upstreams of every service, container or host, go through the same file: the route
    // only needs the hostname and the outside URL.
    const upstreams: UpstreamRoute[] = [];
    for (const [name, service] of Object.entries(spec.services)) {
        if (service.host === undefined) {
            continue;
        }
        for (const [prefix, url] of Object.entries(service.upstreams ?? {})) {
            upstreams.push({ name, host: service.host, prefix, url });
        }
    }
    if (routes.length > 0 || upstreams.length > 0) {
        write_proxy_routes(proxy_dir, session.id, routes, upstreams, summary.path);
    }
    return processes;
}

async function stop_host_services(
    home: SpinnerHome,
    summary: SessionSummary,
    log: Log,
): Promise<void> {
    // The pid files are the record; session.yaml's `processes` is the same set unless a
    // failed `up` never wrote it. Each pid is the leader of its own process group.
    const groups = { ...read_pid_files(summary.path) };
    for (const [name, process_info] of Object.entries(summary.session.stack.processes ?? {})) {
        groups[name] = {
            pid: process_info.pid,
            session_dir: summary.path,
            ...(process_info.started === undefined ? {} : { started: process_info.started }),
        };
    }
    for (const [name, identity] of Object.entries(groups)) {
        const outcome = await stop_host_process(identity);
        log(`${name} on the host (process group ${identity.pid}): ${outcome}`);
        const file = pid_file(summary.path, name);
        if (existsSync(file)) {
            rmSync(file);
        }
    }
    // Whatever left the group (a resource tracker, a reloader child, a daemonised injector
    // child) still runs in the worktree: match by working directory, not argv.
    const stray = await processes_with_cwd_under(summary.path);
    if (stray.length > 0) {
        await kill_pids(stray);
        log(`stopped ${stray.length} stray processes in the session: ${stray.join(", ")}`);
    }
    // The running proxy may watch a different directory than the one this home writes to
    // (a proxy started before the machine directory existed). Remove the session's file
    // from both, or the routes keep answering after close.
    const watched = await current_proxy_dir(home);
    for (const dir of new Set([watched, home.proxy])) {
        const routes = proxy_routes_path(dir, summary.session.id);
        if (existsSync(routes)) {
            rmSync(routes);
        }
    }
}

/** Bound on the wait for Traefik to publish the routes: 60 polls of 500 ms is 30 s. */
const ROUTE_POLLS_MAX = 60;
const ROUTE_INTERVAL_MS = 500;

interface RouteProbe {
    host: string;
    /** The healthcheck path when the service has one, else `/`. */
    path: string;
    /**
     * Without a healthcheck, any status from the hostname means routed, 404 included: the
     * service's own 404 on `/` is as good as a 200. With one, 404 can only be Traefik's.
     */
    any_status: boolean;
}

function route_probes(spec: StackSpec, hosts: Record<string, string>): RouteProbe[] {
    const probes: RouteProbe[] = [];
    for (const [name, host] of Object.entries(hosts)) {
        const check = spec.services[name]?.healthcheck;
        const path = check === undefined ? "/" : health_path(check);
        probes.push({ host, path, any_status: check === undefined });
    }
    return probes;
}

function health_path(check: string): string {
    return check.replace(/^GET\s+/, "");
}

/**
 * Traefik reads labels with a short delay after a container starts, so right after `up`
 * a hostname answers 404 from the proxy itself. This waits until every host reaches its
 * service. The request goes to the loopback port with a `Host` header, because macOS does
 * not resolve `*.localhost` for curl or Node, only browsers do.
 */
async function wait_routes(probes: RouteProbe[], http_port: number): Promise<void> {
    const pending = new Set(probes);
    for (let poll = 0; poll < ROUTE_POLLS_MAX && pending.size > 0; poll += 1) {
        for (const probe of pending) {
            if (await route_answers(probe, http_port)) {
                pending.delete(probe);
            }
        }
        if (pending.size > 0) {
            await sleep(ROUTE_INTERVAL_MS);
        }
    }
    if (pending.size > 0) {
        const hosts = [...pending].map((probe) => probe.host);
        throw new Error(`the proxy does not route ${hosts.join(", ")} yet`);
    }
}

/** The body Traefik sends when no router matches; a service's own 404 reads differently. */
const TRAEFIK_NOT_FOUND = "404 page not found";

function route_answers(probe: RouteProbe, http_port: number): Promise<boolean> {
    // `fetch` drops a `Host` header (the spec forbids it), so this uses `node:http`.
    return new Promise((resolve) => {
        const request = http_request(
            { host: "127.0.0.1", port: http_port, path: probe.path, headers: { Host: probe.host } },
            (response) => {
                if (response.statusCode !== 404) {
                    response.resume();
                    resolve(true);
                    return;
                }
                if (!probe.any_status) {
                    // The probe path is the healthcheck path, so a 404 is Traefik's.
                    response.resume();
                    resolve(false);
                    return;
                }
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("end", () => {
                    const body = Buffer.concat(chunks).toString("utf8").trim();
                    resolve(body !== TRAEFIK_NOT_FOUND);
                });
            },
        );
        request.setTimeout(3_000, () => request.destroy());
        request.on("error", () => resolve(false));
        request.end();
    });
}

/** Starts the shared containers as needed. Returns the directory the proxy watches. */
async function ensure_shared_containers(
    home: SpinnerHome,
    spec: StackSpec,
    log: Log,
): Promise<string> {
    const http_port = spec.proxy?.http_port ?? PROXY_PORT_DEFAULT;
    const proxy = await ensure_proxy(http_port, home.proxy);
    if (proxy.started) {
        log(`started ${PROXY_CONTAINER}`);
    }
    if (proxy.note !== null) {
        log(proxy.note);
    }
    if (stack_has_database(spec) && spec.database?.server !== "external") {
        const version = spec.database?.version ?? POSTGRES_VERSION_DEFAULT;
        if (await ensure_postgres_container(version)) {
            log(`started ${POSTGRES_CONTAINER} (postgres:${version})`);
        }
    }
    return proxy.dir;
}

/** The directory the running proxy watches, else the configured one. */
async function current_proxy_dir(home: SpinnerHome): Promise<string> {
    const info = await container_info(PROXY_CONTAINER);
    if (info.state === "running") {
        return proxy_mount_of(info.config) ?? home.proxy;
    }
    return home.proxy;
}

/** Builds each distinct image that has a dev Dockerfile and is missing, or all with `force`. */
async function ensure_images(spec: StackSpec, force: boolean, log: Log): Promise<void> {
    const built = new Set<string>();
    for (const service of Object.values(spec.services)) {
        if (service.image === undefined || built.has(service.image)) {
            continue;
        }
        const dockerfile = service_dockerfile(spec, service);
        if (dockerfile === null) {
            continue;
        }
        if (force || !(await image_exists(service.image))) {
            await build_image(service.image, dockerfile, log);
        }
        built.add(service.image);
    }
}

/** The spec's `dockerfile`, else the repo's `Dockerfile.dev`, else null (a pulled image). */
function service_dockerfile(spec: StackSpec, service: StackService): string | null {
    if (service.dockerfile !== undefined) {
        if (!existsSync(service.dockerfile)) {
            throw new Error(`dockerfile ${service.dockerfile} does not exist`);
        }
        return service.dockerfile;
    }
    if (service.repo === undefined) {
        return null;
    }
    const repo = spec.repos[service.repo];
    assert.ok(repo !== undefined, `repo ${service.repo} missing`);
    return find_dev_dockerfile(repo.path, service.workdir);
}

function render_stack(summary: SessionSummary, spec: StackSpec, db: string): Rendered {
    const session = summary.session;
    const worktrees: Record<string, string> = {};
    for (const [name, repo] of Object.entries(session.repos)) {
        assert.ok(repo.worktree !== undefined, `repo ${name} has no worktree; run spinner new`);
        worktrees[name] = join(summary.path, repo.worktree);
    }
    const deps: Record<string, DepsInfo> = {};
    for (const [name, service] of Object.entries(spec.services)) {
        if (service.deps_volume !== undefined && service.repo !== undefined) {
            const worktree = worktrees[service.repo];
            assert.ok(worktree !== undefined);
            deps[name] = lockfile_info(service, worktree, service.workdir ?? ".");
        }
    }
    const env_file_current: Record<string, string> = {};
    for (const [name, service] of Object.entries(spec.services)) {
        if (service.env_file !== undefined && service.repo !== undefined) {
            const worktree = worktrees[service.repo];
            assert.ok(worktree !== undefined);
            const path = join(worktree, service.env_file);
            env_file_current[name] = existsSync(path) ? readFileSync(path, "utf8") : "";
        }
    }
    const rendered = render_compose({
        spec,
        session: { id: session.id, branch: session.branch, dir: summary.path, db },
        worktrees,
        deps,
        env_file_current,
    });
    writeFileSync(join(summary.path, COMPOSE_FILE), rendered.compose);
    writeFileSync(join(summary.path, ENV_FILE), rendered.env);
    return rendered;
}

/** Lockfiles per dependency-volume kind, in the order they are looked for. */
const LOCKFILES = {
    "pnpm-store": ["pnpm-lock.yaml"],
    "npm-cache": ["package-lock.json"],
    "yarn-cache": ["yarn.lock"],
    venv: ["uv.lock", "poetry.lock", "requirements.txt", "requirements-dev.txt"],
} as const;

/** Upper bound on directories between a workdir and the worktree root. */
const WORKDIR_LEVELS_MAX = 16;

/**
 * Finds the lockfile in the workdir or, for a workspace package, in a directory above it
 * up to the worktree root. The volume mounts next to the lockfile, where the installer puts
 * the dependencies.
 */
function lockfile_info(service: StackService, worktree: string, workdir: string): DepsInfo {
    assert.ok(service.deps_volume !== undefined);
    const names = LOCKFILES[service.deps_volume];
    let dir = normalize(workdir);
    for (let level = 0; level < WORKDIR_LEVELS_MAX; level += 1) {
        const lockfile = names.find((name) => existsSync(join(worktree, dir, name)));
        if (lockfile !== undefined) {
            const bytes = readFileSync(join(worktree, dir, lockfile));
            const hash = createHash("sha256").update(bytes).digest("hex");
            return { hash, lockfile, dir };
        }
        if (dir === "." || dir === "") {
            break;
        }
        dir = dirname(dir);
    }
    throw new Error(`no lockfile (${names.join(", ")}) in ${join(worktree, workdir)} or above`);
}

/** The error for a host service that died: log tail, unresolved hostname and the hint. */
async function describe_host_exit(
    summary: SessionSummary,
    spec: StackSpec,
    name: string,
    process_info: HostProcess,
): Promise<string> {
    const log_text = readFileSync(join(summary.path, process_info.log), "utf8");
    const service = spec.services[name];
    const repo = service?.repo === undefined ? undefined : summary.session.repos[service.repo];
    const dotenv = join(summary.path, repo?.worktree ?? ".", service?.workdir ?? ".", ".env");
    const dotenv_text = existsSync(dotenv) ? readFileSync(dotenv, "utf8") : "";
    const diagnosis = await diagnose_host_exit(log_text, dotenv_text);
    const state = process_alive(process_info.pid) ? "failed to start" : "exited";
    const lines = [`${name} ${state} on the host; last lines of ${process_info.log}:`];
    lines.push(diagnosis.tail);
    if (diagnosis.unresolved !== null) {
        const holder =
            diagnosis.variable === null
                ? "a value from the wrapper's injector or a dotenv file"
                : `${diagnosis.variable} in ${relative(summary.path, dotenv)}`;
        lines.push(
            `hostname ${diagnosis.unresolved} does not resolve on the host (${holder}). ` +
                `A host service needs host-side addresses: set that variable under ` +
                `services.${name}.env in spinner.yaml; Spinner's env wins over the injector.`,
        );
    }
    return lines.join("\n");
}

/**
 * Polls until every service with a healthcheck is healthy: `compose ps` for containers, an
 * HTTP probe on the port for host services. Bounded.
 */
async function wait_healthy(
    summary: SessionSummary,
    target: ComposeTarget,
    spec: StackSpec,
    processes: Record<string, HostProcess>,
    log: Log,
): Promise<void> {
    const checked = Object.entries(spec.services)
        .filter(([name, service]) => service.healthcheck !== undefined && !(name in processes))
        .map(([name]) => name);
    const on_host = Object.entries(spec.services)
        .filter(([name, service]) => service.healthcheck !== undefined && name in processes)
        .map(([name, service]) => ({ name, path: health_path(service.healthcheck ?? "GET /") }));
    const noted = new Set<string>();
    let import_notes_done = false;
    const started = Date.now();
    for (let poll = 0; poll < HEALTH_POLLS_MAX; poll += 1) {
        const grace_over = Date.now() - started >= HOST_TRACEBACK_GRACE_MS;
        if (grace_over && !import_notes_done) {
            import_notes_done = true;
            // A preflight can pass while the service itself cannot import a module (venv or
            // node_modules drift): one note per service, with the line, healthcheck or not.
            for (const [name, process_info] of Object.entries(processes)) {
                const text = readFileSync(join(summary.path, process_info.log), "utf8");
                const line = import_error_line(text);
                if (line !== null && !noted.has(name)) {
                    noted.add(name);
                    log(`${name}: import error in ${process_info.log} (drift?): ${line}`);
                }
            }
        }
        for (const entry of on_host) {
            const process_info = processes[entry.name];
            assert.ok(process_info !== undefined);
            if (!process_alive(process_info.pid)) {
                throw new Error(await describe_host_exit(summary, spec, entry.name, process_info));
            }
            const crashed =
                grace_over &&
                log_shows_traceback(readFileSync(join(summary.path, process_info.log), "utf8"));
            if (crashed && !(await host_answers(process_info.port, entry.path))) {
                await stop_host_process({ ...process_info, session_dir: summary.path });
                throw new Error(await describe_host_exit(summary, spec, entry.name, process_info));
            }
        }
        const has_containers = Object.values(spec.services).some((s) => s.runtime !== "host");
        // `docker ps` by label, not `compose ps`: the same facts, without loading the file.
        const statuses = has_containers ? await project_status(target.project) : [];
        const dead = statuses.find(
            (status) => status.state === "exited" || status.health === "unhealthy",
        );
        if (dead !== undefined) {
            const tail = await compose(target, ["logs", "--tail", "30", dead.name]);
            throw new Error(`service ${dead.name} is ${dead.health || dead.state}:\n${tail}`);
        }
        const healthy = statuses
            .filter((status) => status.health === "healthy")
            .map((status) => status.name);
        for (const entry of on_host) {
            const process_info = processes[entry.name];
            assert.ok(process_info !== undefined);
            if (await host_answers(process_info.port, entry.path)) {
                healthy.push(entry.name);
            }
        }
        const wanted = [...checked, ...on_host.map((entry) => entry.name)];
        if (wanted.every((name) => healthy.includes(name))) {
            return;
        }
        await sleep(HEALTH_INTERVAL_MS);
    }
    log("healthcheck wait timed out");
    const seconds = (HEALTH_POLLS_MAX * HEALTH_INTERVAL_MS) / 1000;
    throw new Error(`services did not become healthy within ${seconds} s`);
}

/** `compose stop`: containers and volumes stay, so `up` is fast afterwards. */
export async function stack_down(
    home: SpinnerHome,
    summary: SessionSummary,
    log: Log,
): Promise<void> {
    const target = compose_target(summary);
    if (existsSync(target.file)) {
        await compose(target, ["stop", "--timeout", "5"]);
        log(`stopped ${target.project}`);
    }
    await stop_host_services(home, summary, log);
    summary.session.stack = { ...summary.session.stack, state: "down" };
    delete summary.session.stack.processes;
    write_session_field(summary, "stack");
}

export interface CloseResult {
    archived_path: string;
}

/**
 * Removes containers, the project's volumes, the network, the session database and the
 * worktrees, then moves the session to the archive. Each step tolerates an earlier failure.
 */
export async function stack_close(
    home: SpinnerHome,
    summary: SessionSummary,
    log: Log,
): Promise<CloseResult> {
    const session = summary.session;
    const target = compose_target(summary);
    const network = compose_network(session.id);
    if (existsSync(target.file)) {
        await compose_down(target);
    } else if (await project_has_containers(target.project)) {
        await remove_project_containers(target.project);
    }
    log(`removed containers of ${target.project}`);
    await stop_host_services(home, summary, log);
    await disconnect_network(network, PROXY_CONTAINER);
    await disconnect_network(network, POSTGRES_CONTAINER);
    if (await network_exists(network)) {
        await run_ok("docker", ["network", "rm", network]);
    }
    if (existsSync(join(summary.path, SESSION_SPEC))) {
        await drop_session_database(read_session_spec(summary).spec, session, log);
    }
    for (const [name, repo] of Object.entries(session.repos)) {
        if (repo.worktree !== undefined) {
            await remove_worktree(repo.path, join(summary.path, repo.worktree));
            log(`removed worktree ${name} (branch ${session.branch} kept)`);
        }
    }
    session.stack = { state: "none" };
    session.stage = "closed";
    write_session(summary);
    mkdirSync(home.archive, { recursive: true });
    const archived_path = free_archive_path(home, summary.dir);
    renameSync(summary.path, archived_path);
    return { archived_path };
}

/** Upper bound on same-named archive entries; ids are unique, so this is a safety net. */
const ARCHIVE_SUFFIX_MAX = 100;

/** `<archive>/<dir>`, or `<dir>-2`, `<dir>-3`, ... when that name was archived before. */
function free_archive_path(home: SpinnerHome, dir: string): string {
    const first = join(home.archive, dir);
    if (!existsSync(first)) {
        return first;
    }
    for (let suffix = 2; suffix <= ARCHIVE_SUFFIX_MAX; suffix += 1) {
        const candidate = `${first}-${suffix}`;
        if (!existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error(`more than ${ARCHIVE_SUFFIX_MAX} archived sessions named ${dir}`);
}

/**
 * Stops and removes the shared containers, `spinner-proxy` and `spinner-postgres`, once no
 * session stack is up. The Postgres data volume stays, so the template databases survive.
 */
export interface SharedDownOptions {
    /** Remove the containers even while sessions use them, after listing what breaks. */
    force?: boolean;
}

export async function shared_down(
    home: SpinnerHome,
    options: SharedDownOptions,
    log: Log,
): Promise<void> {
    // The containers are machine-global: stacks of any home, route files of any home in the
    // proxy directory and the host services those homes started all count, not only this
    // home's session.yaml.
    const proxy_dir = await current_proxy_dir(home);
    const homes = [home.root, ...homes_in_route_files(proxy_dir)];
    const lines = shared_use_lines({
        projects: await spinner_projects(),
        route_files: route_files_in(proxy_dir),
        live_pids: await live_pid_files(homes),
    });
    if (lines.length > 0 && options.force !== true) {
        throw new Error(
            `${lines.join("\n")}\nrun spinner down or close in their home first, or --force`,
        );
    }
    for (const line of lines) {
        log(`breaking: ${line}`);
    }
    for (const name of [PROXY_CONTAINER, POSTGRES_CONTAINER]) {
        const removed = await remove_container(name);
        log(`${name}: ${removed ? "removed" : "absent"}`);
    }
    // `--force` named these homes in the lines above, so their host processes stop too.
    // Without it the function has already thrown.
    const roots = options.force === true ? homes : [home.root];
    const stray: number[] = [];
    for (const root of new Set(roots)) {
        stray.push(...(await processes_with_cwd_under(join(root, "sessions"))));
    }
    await kill_pids(stray);
    log(`host processes: ${stray.length === 0 ? "none" : stray.join(", ")}`);
}

export interface SeedOptions {
    /** Copy `seed.source` into the template as it is, without running the seed commands. */
    copy_only?: boolean;
}

/** Host-service pid files, of every session of the given homes, whose group is alive. */
async function live_pid_files(home_roots: string[]): Promise<string[]> {
    const live: string[] = [];
    for (const root of new Set(home_roots)) {
        const sessions = join(root, "sessions");
        if (!existsSync(sessions)) {
            continue;
        }
        for (const dir of readdirSync(sessions)) {
            const pids = read_pid_files(join(sessions, dir));
            for (const [service, identity] of Object.entries(pids)) {
                // A reused pid is not a live service; only Spinner's own leader counts.
                if (await is_spinner_leader(identity)) {
                    live.push(`${dir}/${service}`);
                }
            }
        }
    }
    return live.sort();
}

/** Rebuilds the template database from the spec's seed: a dump, or host commands. */
export async function seed_rebuild(
    home: SpinnerHome,
    loaded: LoadedSpec,
    options: SeedOptions,
    log: Log,
): Promise<void> {
    const { spec } = loaded;
    const seed = spec.database?.seed;
    if (seed === undefined) {
        throw new Error("the spec has no database.seed");
    }
    await ensure_shared_containers(home, spec, log);
    const server = new DatabaseServer(server_address(spec.database));
    await server.wait_ready(spec.database?.server !== "external");
    const template = template_name(spec);
    if (seed.dump !== undefined) {
        await server.rebuild_template_from_dump(template, seed.dump);
        log(`template ${template} rebuilt from ${seed.dump} on ${server.describe()}`);
        return;
    }
    if (options.copy_only === true) {
        if (seed.source === undefined) {
            throw new Error("--copy-only needs database.seed.source");
        }
        const how = await server.copy_to_template(seed.source, template);
        log(`template ${template} from ${seed.source} on ${server.describe()}: ${how}`);
        await run_seed_after(server, template, seed, log);
        return;
    }
    if (seed.migrate === undefined && seed.fixtures === undefined) {
        throw new Error("database.seed needs a dump, or migrate and fixtures commands");
    }
    const cwd = seed_cwd(spec, seed);
    // Without `source` the commands fill the future template itself, through DATABASE_URL.
    const filled = seed.source ?? template;
    if (seed.source === undefined) {
        await server.drop_database(template);
        await server.create_database(template);
    }
    const env = { ...process.env, DATABASE_URL: server.url(filled), SEED_DB: filled };
    for (const [step, command] of [["migrate", seed.migrate], ["fixtures", seed.fixtures]]) {
        if (command === undefined) {
            continue;
        }
        log(`seed ${step}: ${command} (in ${cwd})`);
        const code = await run_attached("sh", ["-c", command], cwd, env);
        if (code !== 0) {
            throw new Error(`seed ${step} failed with exit code ${code}`);
        }
    }
    if (seed.source === undefined) {
        await server.mark_template(template);
        log(`template ${template} rebuilt on ${server.describe()}`);
    } else {
        const how = await server.copy_to_template(seed.source, template);
        log(`template ${template} from ${seed.source} on ${server.describe()}: ${how}`);
    }
    await run_seed_after(server, template, seed, log);
}

/** `seed.after`: statements such as grants that the snapshot lacks, run on the template. */
async function run_seed_after(
    server: DatabaseServer,
    template: string,
    seed: DatabaseSeed,
    log: Log,
): Promise<void> {
    const statements = seed.after ?? [];
    if (statements.length === 0) {
        return;
    }
    await server.run_statements(template, statements);
    await server.mark_template(template);
    log(`seed.after: ${statements.length} statements run on ${template}`);
}

function seed_cwd(spec: StackSpec, seed: DatabaseSeed): string {
    const name = seed.repo ?? Object.keys(spec.repos)[0];
    if (name === undefined) {
        throw new Error("database.seed commands need a repo to run in");
    }
    const repo = spec.repos[name];
    if (repo === undefined) {
        throw new Error(`database.seed.repo "${name}" is not under repos`);
    }
    return repo.path;
}

export function compose_target(summary: SessionSummary): ComposeTarget {
    return { project: compose_project(summary.session.id), file: join(summary.path, COMPOSE_FILE) };
}

function set_stack_state(summary: SessionSummary, state: Session["stack"]["state"]): void {
    summary.session.stack = { ...summary.session.stack, state };
    write_session_field(summary, "stack");
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs a compose subcommand on the session's project with the terminal attached. */
export function compose_attached_for(summary: SessionSummary, args: string[]): Promise<number> {
    return compose_attached(compose_target(summary), args);
}

/** The log file of a host service, for `spinner logs`, or null when it is a container. */
export function host_service_log(summary: SessionSummary, service: string): string | null {
    const process_info = summary.session.stack.processes?.[service];
    return process_info === undefined ? null : join(summary.path, process_info.log);
}
