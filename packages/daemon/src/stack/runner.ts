// The stack runner: `new` attaches a project to a session (spec copy, worktrees), `up` brings
// the stack to healthy, `down` stops it, `close` removes everything the session created. Every
// step is idempotent so a retry after a failure continues where the last run stopped.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { request as http_request } from "node:http";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import type {
    DatabaseSeed,
    Session,
    SessionSummary,
    StackService,
    StackSpec,
} from "@spinner/protocol";
import { add_worktree, remove_worktree } from "../git/worktree.js";
import type { SpinnerHome } from "../home.js";
import { list_sessions, write_session } from "../store/session-store.js";
import {
    compose_network,
    compose_project,
    hostname,
    render_compose,
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
    compose_status,
    connect_network,
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
    type ComposeTarget,
} from "./docker.js";
import { DatabaseServer, server_address } from "./postgres.js";
import { run_attached, run_ok } from "./shell.js";
import { load_spec, type LoadedSpec } from "./spec.js";

export type Log = (line: string) => void;

/** The copy of the project's spec that a session keeps, with absolute paths. */
export const SESSION_SPEC = join("stack", "spinner.yaml");
const COMPOSE_FILE = join("stack", "compose.yaml");
const ENV_FILE = join("stack", ".env");
const PROXY_PORT_DEFAULT = 80;
const POSTGRES_VERSION_DEFAULT = "16";

/** Bound on the wait for healthchecks: 480 polls of 250 ms is 2 minutes. */
const HEALTH_POLLS_MAX = 480;
const HEALTH_INTERVAL_MS = 250;

export function session_db(session_id: string): string {
    return `spinner_${session_id}`;
}

export function template_name(spec: StackSpec): string {
    return spec.database?.template ?? `${spec.name}_seed`;
}

/** Reads the session's own spec copy. Throws when the session has no project. */
export function read_session_spec(summary: SessionSummary): LoadedSpec {
    const path = join(summary.path, SESSION_SPEC);
    if (!existsSync(path)) {
        throw new Error(`${summary.dir} has no stack; create it with spinner new --project`);
    }
    return load_spec(path);
}

/**
 * Copies the spec into the session, records the repos and makes one worktree per repo on
 * the session branch. Runs at `spinner new --project` and is safe to run again.
 */
export async function attach_project(
    summary: SessionSummary,
    loaded: LoadedSpec,
    log: Log,
): Promise<SessionSummary> {
    const { spec } = loaded;
    const session = summary.session;
    mkdirSync(join(summary.path, "stack"), { recursive: true });
    const copy = join(summary.path, SESSION_SPEC);
    if (loaded.path !== copy) {
        write_spec_copy(copy, spec);
    }
    session.project = spec.name;
    session.base = spec.base;
    for (const [name, repo] of Object.entries(spec.repos)) {
        const worktree = join("worktrees", name);
        const outcome = await add_worktree({
            repo_path: repo.path,
            worktree_path: join(summary.path, worktree),
            branch: session.branch,
            base: repo.base ?? spec.base,
            session_dir: summary.path,
        });
        log(`worktree ${worktree} ${outcome} (${repo.path} on ${session.branch})`);
        session.repos[name] = { path: repo.path, worktree, changed: false, pr: null };
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

/** Brings the session's stack up and waits until every healthcheck passes. */
export async function stack_up(
    summary: SessionSummary,
    options: UpOptions,
    log: Log,
): Promise<UpResult> {
    const started = Date.now();
    set_stack_state(summary, "starting");
    try {
        const hosts = await start_stack(summary, options, log);
        const db = session_db(summary.session.id);
        const project = compose_project(summary.session.id);
        summary.session.stack = { project, state: "up", hosts, db };
        write_session(summary);
        return { hosts, db, elapsed_ms: Date.now() - started };
    } catch (error) {
        // `failed` tells the board and the UI that a retry or a `close` is due; the containers
        // stay for `spinner logs` to show what went wrong.
        set_stack_state(summary, "failed");
        throw error;
    }
}

async function start_stack(
    summary: SessionSummary,
    options: UpOptions,
    log: Log,
): Promise<Record<string, string>> {
    const { spec } = read_session_spec(summary);
    const session = summary.session;
    const target = compose_target(summary);
    const network = compose_network(session.id);
    const db = session_db(session.id);

    await ensure_shared_containers(spec, log);
    const server = new DatabaseServer(server_address(spec.database));
    await server.wait_ready(spec.database?.server !== "external");
    log(`database ${db}: ${await server.clone_from_template(db, template_name(spec))}`);

    await ensure_images(spec, options.build === true, log);
    if (!(await network_exists(network))) {
        await run_ok("docker", ["network", "create", network]);
    }
    await connect_network(network, PROXY_CONTAINER);
    if (spec.database?.server !== "external") {
        await connect_network(network, POSTGRES_CONTAINER, POSTGRES_ALIAS);
    }

    const rendered = render_stack(summary, spec, db);
    for (const volume of rendered.deps_volumes) {
        await ensure_volume(volume);
    }
    for (const file of rendered.env_files) {
        mkdirSync(dirname(file.path), { recursive: true });
        writeFileSync(file.path, file.content);
    }
    await compose(target, ["up", "--detach", "--remove-orphans", "--quiet-pull"]);
    await wait_healthy(target, spec, log);
    const http_port = spec.proxy?.http_port ?? PROXY_PORT_DEFAULT;
    await wait_routes(route_probes(spec, rendered.hosts), http_port);
    return rendered.hosts;
}

/** Bound on the wait for Traefik to publish the routes: 120 polls of 250 ms is 30 s. */
const ROUTE_POLLS_MAX = 120;

interface RouteProbe {
    host: string;
    /** The healthcheck path when the service has one, else `/`. */
    path: string;
}

function route_probes(spec: StackSpec, hosts: Record<string, string>): RouteProbe[] {
    const probes: RouteProbe[] = [];
    for (const [name, host] of Object.entries(hosts)) {
        const check = spec.services[name]?.healthcheck;
        const path = check === undefined ? "/" : check.replace(/^GET\s+/, "");
        probes.push({ host, path });
    }
    return probes;
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
            await sleep(HEALTH_INTERVAL_MS);
        }
    }
    if (pending.size > 0) {
        const hosts = [...pending].map((probe) => probe.host);
        throw new Error(`the proxy does not route ${hosts.join(", ")} yet`);
    }
}

function route_answers(probe: RouteProbe, http_port: number): Promise<boolean> {
    // `fetch` drops a `Host` header (the spec forbids it), so this uses `node:http`.
    return new Promise((resolve) => {
        const request = http_request(
            { host: "127.0.0.1", port: http_port, path: probe.path, headers: { Host: probe.host } },
            (response) => {
                response.resume();
                // Traefik answers 404 itself when no router matches. The probe path is the
                // service's healthcheck path when it has one, so its own 404 does not occur.
                resolve(response.statusCode !== 404);
            },
        );
        request.setTimeout(3_000, () => request.destroy());
        request.on("error", () => resolve(false));
        request.end();
    });
}

async function ensure_shared_containers(spec: StackSpec, log: Log): Promise<void> {
    if (await ensure_proxy(spec.proxy?.http_port ?? PROXY_PORT_DEFAULT)) {
        log(`started ${PROXY_CONTAINER}`);
    }
    if (spec.database?.server !== "external") {
        const version = spec.database?.version ?? POSTGRES_VERSION_DEFAULT;
        if (await ensure_postgres_container(version)) {
            log(`started ${POSTGRES_CONTAINER} (postgres:${version})`);
        }
    }
}

/** Builds each distinct image that has a dev Dockerfile and is missing, or all with `force`. */
async function ensure_images(spec: StackSpec, force: boolean, log: Log): Promise<void> {
    const built = new Set<string>();
    for (const service of Object.values(spec.services)) {
        if (built.has(service.image)) {
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
            deps[name] = lockfile_info(service, join(worktree, service.workdir ?? "."));
        }
    }
    const rendered = render_compose({
        spec,
        session: { id: session.id, branch: session.branch, dir: summary.path, db },
        worktrees,
        deps,
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

function lockfile_info(service: StackService, dir: string): DepsInfo {
    assert.ok(service.deps_volume !== undefined);
    const names = LOCKFILES[service.deps_volume];
    const lockfile = names.find((name) => existsSync(join(dir, name)));
    if (lockfile === undefined) {
        throw new Error(`no lockfile (${names.join(", ")}) in ${dir} for deps_volume`);
    }
    const hash = createHash("sha256").update(readFileSync(join(dir, lockfile))).digest("hex");
    return { hash, lockfile };
}

/** Polls `compose ps` until every service with a healthcheck is healthy. Bounded. */
async function wait_healthy(target: ComposeTarget, spec: StackSpec, log: Log): Promise<void> {
    const checked = Object.entries(spec.services)
        .filter(([, service]) => service.healthcheck !== undefined)
        .map(([name]) => name);
    for (let poll = 0; poll < HEALTH_POLLS_MAX; poll += 1) {
        const statuses = await compose_status(target);
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
        if (checked.every((name) => healthy.includes(name))) {
            return;
        }
        await sleep(HEALTH_INTERVAL_MS);
    }
    log("healthcheck wait timed out");
    const seconds = (HEALTH_POLLS_MAX * HEALTH_INTERVAL_MS) / 1000;
    throw new Error(`services did not become healthy within ${seconds} s`);
}

/** `compose stop`: containers and volumes stay, so `up` is fast afterwards. */
export async function stack_down(summary: SessionSummary, log: Log): Promise<void> {
    const target = compose_target(summary);
    if (existsSync(target.file)) {
        await compose(target, ["stop", "--timeout", "5"]);
        log(`stopped ${target.project}`);
    }
    set_stack_state(summary, "down");
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
    await disconnect_network(network, PROXY_CONTAINER);
    await disconnect_network(network, POSTGRES_CONTAINER);
    if (await network_exists(network)) {
        await run_ok("docker", ["network", "rm", network]);
    }
    if (existsSync(join(summary.path, SESSION_SPEC))) {
        const { spec } = read_session_spec(summary);
        const server = new DatabaseServer(server_address(spec.database));
        const db = session_db(session.id);
        log(`database ${db}: ${await server.drop_database(db)}`);
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
export async function shared_down(home: SpinnerHome, log: Log): Promise<void> {
    const up = list_sessions(home).sessions.filter((entry) => entry.session.stack.state === "up");
    if (up.length > 0) {
        const names = up.map((entry) => entry.dir).join(", ");
        throw new Error(`stacks are still up: ${names}; run spinner down or close first`);
    }
    for (const name of [PROXY_CONTAINER, POSTGRES_CONTAINER]) {
        const removed = await remove_container(name);
        log(`${name}: ${removed ? "removed" : "absent"}`);
    }
}

export interface SeedOptions {
    /** Copy `seed.source` into the template as it is, without running the seed commands. */
    copy_only?: boolean;
}

/** Rebuilds the template database from the spec's seed: a dump, or host commands. */
export async function seed_rebuild(
    loaded: LoadedSpec,
    options: SeedOptions,
    log: Log,
): Promise<void> {
    const { spec } = loaded;
    const seed = spec.database?.seed;
    if (seed === undefined) {
        throw new Error("the spec has no database.seed");
    }
    await ensure_shared_containers(spec, log);
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

function compose_target(summary: SessionSummary): ComposeTarget {
    return { project: compose_project(summary.session.id), file: join(summary.path, COMPOSE_FILE) };
}

function set_stack_state(summary: SessionSummary, state: Session["stack"]["state"]): void {
    summary.session.stack = { ...summary.session.stack, state };
    write_session(summary);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs a compose subcommand on the session's project with the terminal attached. */
export function compose_attached_for(summary: SessionSummary, args: string[]): Promise<number> {
    return compose_attached(compose_target(summary), args);
}
