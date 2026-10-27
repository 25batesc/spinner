// Docker operations the runner needs: the shared containers (`spinner-proxy`,
// `spinner-postgres`), session networks, image builds and `docker compose` on a session's
// project. Everything here is idempotent, so `up` twice and `close` after a failed `up` work.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { run, run_attached, run_ok } from "./shell.js";

export const PROXY_CONTAINER = "spinner-proxy";
export const POSTGRES_CONTAINER = "spinner-postgres";
/** Host port of the managed Postgres, bound to loopback only. */
export const POSTGRES_HOST_PORT = 55432;
export const POSTGRES_PASSWORD = "postgres";
/** The alias every session network gives the managed Postgres, as `DATABASE_URL` uses it. */
export const POSTGRES_ALIAS = "postgres";
// Traefik before 3.6 speaks a Docker API version that Docker 29 no longer accepts.
const TRAEFIK_IMAGE = "traefik:v3.6";

export type ContainerState = "missing" | "running" | "stopped";

export interface ContainerInfo {
    state: ContainerState;
    /** The image the container was created from; empty when missing. */
    image: string;
}

export async function container_info(name: string): Promise<ContainerInfo> {
    const format = "{{.State.Running}} {{.Config.Image}}";
    const result = await run("docker", ["inspect", "--format", format, name]);
    if (result.code !== 0) {
        return { state: "missing", image: "" };
    }
    const [running, image] = result.stdout.trim().split(" ");
    return { state: running === "true" ? "running" : "stopped", image: image ?? "" };
}

/**
 * Starts a long-lived container if it is not running, and recreates it when it was created
 * from another image (an upgrade of Traefik or Postgres). Returns true when it started one.
 */
async function ensure_container(
    name: string,
    image: string,
    options: string[],
    command: string[] = [],
): Promise<boolean> {
    const info = await container_info(name);
    if (info.state !== "missing" && info.image !== image) {
        await run_ok("docker", ["rm", "--force", name]);
        info.state = "missing";
    }
    if (info.state === "running") {
        return false;
    }
    if (info.state === "stopped") {
        await run_ok("docker", ["start", name]);
        return true;
    }
    const base = ["run", "-d", "--name", name, "--restart", "unless-stopped"];
    await run_ok("docker", [...base, ...options, image, ...command]);
    return true;
}

/** One Traefik for every session, routing by the labels the renderer puts on services. */
export function ensure_proxy(http_port: number): Promise<boolean> {
    assert.ok(http_port > 0 && http_port < 65536, `bad proxy port ${http_port}`);
    return ensure_container(
        PROXY_CONTAINER,
        TRAEFIK_IMAGE,
        ["-p", `${http_port}:80`, "-v", "/var/run/docker.sock:/var/run/docker.sock:ro"],
        [
            "--providers.docker=true",
            "--providers.docker.exposedbydefault=false",
            "--entrypoints.web.address=:80",
            "--log.level=WARN",
        ],
    );
}

/** The managed Postgres server. Its data volume survives `close` of every session. */
export function ensure_postgres_container(version: string): Promise<boolean> {
    assert.ok(/^\d+$/.test(version), `postgres version must be a major number: ${version}`);
    return ensure_container(POSTGRES_CONTAINER, `postgres:${version}`, [
        "-p",
        `127.0.0.1:${POSTGRES_HOST_PORT}:5432`,
        "-e",
        `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
        "-v",
        "spinner-postgres-data:/var/lib/postgresql/data",
    ]);
}

/** Removes a container, running or not. Returns false when there was none. */
export async function remove_container(name: string): Promise<boolean> {
    const info = await container_info(name);
    if (info.state === "missing") {
        return false;
    }
    await run_ok("docker", ["rm", "--force", name]);
    return true;
}

export async function network_exists(network: string): Promise<boolean> {
    const result = await run("docker", ["network", "inspect", network, "--format", "{{.Name}}"]);
    return result.code === 0;
}

async function network_members(network: string): Promise<string[]> {
    const out = await run_ok("docker", [
        "network",
        "inspect",
        network,
        "--format",
        "{{range .Containers}}{{.Name}}\n{{end}}",
    ]);
    return out.split("\n").filter((line) => line.length > 0);
}

/** Attaches a shared container to a session network, with an alias when given. */
export async function connect_network(
    network: string,
    container: string,
    alias?: string,
): Promise<void> {
    const members = await network_members(network);
    if (members.includes(container)) {
        return;
    }
    const alias_args = alias === undefined ? [] : ["--alias", alias];
    await run_ok("docker", ["network", "connect", ...alias_args, network, container]);
}

/** Detaches a shared container from a session network. A missing network or member is fine. */
export async function disconnect_network(network: string, container: string): Promise<void> {
    if (!(await network_exists(network))) {
        return;
    }
    const members = await network_members(network);
    if (!members.includes(container)) {
        return;
    }
    await run_ok("docker", ["network", "disconnect", "--force", network, container]);
}

export async function image_exists(image: string): Promise<boolean> {
    const result = await run("docker", ["image", "inspect", image, "--format", "{{.Id}}"]);
    return result.code === 0;
}

export async function volume_exists(volume: string): Promise<boolean> {
    const result = await run("docker", ["volume", "inspect", volume, "--format", "{{.Name}}"]);
    return result.code === 0;
}

export async function ensure_volume(volume: string): Promise<void> {
    if (!(await volume_exists(volume))) {
        await run_ok("docker", ["volume", "create", volume]);
    }
}

/** `Dockerfile.dev` next to the service's workdir, else at the repo root, else none. */
export function find_dev_dockerfile(repo_path: string, workdir: string | undefined): string | null {
    const candidates = [
        join(repo_path, workdir ?? ".", "Dockerfile.dev"),
        join(repo_path, "Dockerfile.dev"),
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Builds an image from a dev Dockerfile, with the file's directory as the context. */
export async function build_image(
    image: string,
    dockerfile: string,
    log: (line: string) => void,
): Promise<void> {
    log(`building ${image} from ${dockerfile}`);
    const context = join(dockerfile, "..");
    await run_ok("docker", ["build", "--quiet", "--tag", image, "--file", dockerfile, context]);
}

export interface ComposeTarget {
    /** Compose project name, `spinner-<id>`. */
    project: string;
    /** Absolute path of the compose file. */
    file: string;
}

function compose_args(target: ComposeTarget, args: string[]): string[] {
    return ["compose", "--project-name", target.project, "--file", target.file, ...args];
}

export async function compose(target: ComposeTarget, args: string[]): Promise<string> {
    return run_ok("docker", compose_args(target, args));
}

export function compose_attached(target: ComposeTarget, args: string[]): Promise<number> {
    return run_attached("docker", compose_args(target, args));
}

export interface ServiceStatus {
    name: string;
    state: string;
    /** `healthy`, `unhealthy`, `starting`, or empty for services without a healthcheck. */
    health: string;
}

/** The services of a project as `docker compose ps` reports them. Empty when there is none. */
export async function compose_status(target: ComposeTarget): Promise<ServiceStatus[]> {
    const out = await compose(target, ["ps", "--all", "--format", "json"]);
    const statuses: ServiceStatus[] = [];
    for (const line of out.split("\n")) {
        if (line.trim().length === 0) {
            continue;
        }
        const row = JSON.parse(line) as { Service: string; State: string; Health: string };
        statuses.push({ name: row.Service, state: row.State, health: row.Health });
    }
    return statuses;
}

/** Removes containers and the project's own volumes. Shared (external) volumes stay. */
export async function compose_down(target: ComposeTarget): Promise<void> {
    await compose(target, ["down", "--volumes", "--remove-orphans", "--timeout", "5"]);
}

/** Whether a compose project with this name has any container, even if its file is gone. */
export async function project_has_containers(project: string): Promise<boolean> {
    const out = await run_ok("docker", [
        "ps",
        "--all",
        "--quiet",
        "--filter",
        `label=com.docker.compose.project=${project}`,
    ]);
    return out.trim().length > 0;
}

/** Removes every container of a project by label, for a `close` whose compose file is gone. */
export async function remove_project_containers(project: string): Promise<void> {
    const out = await run_ok("docker", [
        "ps",
        "--all",
        "--quiet",
        "--filter",
        `label=com.docker.compose.project=${project}`,
    ]);
    const ids = out.split("\n").filter((line) => line.length > 0);
    if (ids.length > 0) {
        await run_ok("docker", ["rm", "--force", ...ids]);
    }
}
