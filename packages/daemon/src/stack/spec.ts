// Finds, reads and checks `spinner.yaml` (docs/STACK_SPEC.md). `spinner new --project`
// resolves a name or a path to a file here; the loaded spec has every path made absolute, so
// a copy of it inside the session directory stays valid after the session moves.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { StackSpec } from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";

export const SPEC_FILE = "spinner.yaml";

export interface LoadedSpec {
    /** Absolute path of the file the spec was read from. */
    path: string;
    spec: StackSpec;
}

/** The Spinner checkout this code runs from, for `local/<name>/spinner.yaml`. */
function spinner_checkout_root(): string {
    // This file lives at packages/daemon/{src,dist}/stack/spec.{ts,js}; four levels up is the
    // checkout root, whether the code runs from the sources or from the build.
    return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

/**
 * Resolves `--project`: a path to a spec file or to a directory holding one, else a project
 * name looked up under `local/<name>/` in the Spinner checkout and `<home>/projects/<name>/`.
 * Without a project, the current directory must hold a `spinner.yaml`.
 */
export function find_spec(project: string | undefined, home: SpinnerHome, cwd: string): string {
    if (project === undefined) {
        const here = join(cwd, SPEC_FILE);
        if (existsSync(here)) {
            return here;
        }
        throw new Error(`no ${SPEC_FILE} in ${cwd}; pass --project <name|path>`);
    }
    assert.ok(project.length > 0, "project must not be empty");
    const as_path = resolve(cwd, expand_home(project));
    if (existsSync(as_path)) {
        const path = statSync(as_path).isDirectory() ? join(as_path, SPEC_FILE) : as_path;
        if (existsSync(path)) {
            return path;
        }
        throw new Error(`${as_path} has no ${SPEC_FILE}`);
    }
    const candidates = [
        join(spinner_checkout_root(), "local", project, SPEC_FILE),
        join(home.root, "projects", project, SPEC_FILE),
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found === undefined) {
        throw new Error(`project "${project}" not found; looked in ${candidates.join(", ")}`);
    }
    return found;
}

/** Reads and checks a spec file. Repo paths and the seed dump become absolute. */
export function load_spec(path: string): LoadedSpec {
    assert.ok(isAbsolute(path), `spec path must be absolute: ${path}`);
    const parsed: unknown = parse(readFileSync(path, "utf8"));
    const problem = check_spec_shape(parsed);
    if (problem !== null) {
        throw new Error(`${path}: ${problem}`);
    }
    const spec = structuredClone(parsed as StackSpec);
    const dir = dirname(path);
    for (const repo of Object.values(spec.repos)) {
        repo.path = resolve(dir, expand_home(repo.path));
    }
    const dump = spec.database?.seed?.dump;
    if (dump !== undefined && spec.database?.seed !== undefined) {
        spec.database.seed.dump = resolve(dir, expand_home(dump));
    }
    for (const service of Object.values(spec.services)) {
        if (service.dockerfile !== undefined) {
            service.dockerfile = resolve(dir, expand_home(service.dockerfile));
        }
    }
    return { path, spec };
}

/**
 * A structural check that is cheap and dependency-free, plus the references the renderer
 * relies on. The JSON schema in the protocol package is the full definition.
 */
export function check_spec_shape(value: unknown): string | null {
    if (typeof value !== "object" || value === null) {
        return "not a YAML mapping";
    }
    const record = value as Record<string, unknown>;
    for (const key of ["name", "base"]) {
        if (typeof record[key] !== "string" || (record[key] as string).length === 0) {
            return `missing string \`${key}\``;
        }
    }
    if (!/^[a-z0-9-]+$/.test(record["name"] as string)) {
        return "`name` must be lower-case letters, digits and dashes";
    }
    for (const key of ["repos", "services"]) {
        if (typeof record[key] !== "object" || record[key] === null) {
            return `missing mapping \`${key}\``;
        }
    }
    const repos = record["repos"] as Record<string, unknown>;
    const services = record["services"] as Record<string, Record<string, unknown>>;
    for (const [name, repo] of Object.entries(repos)) {
        if (typeof (repo as Record<string, unknown>)["path"] !== "string") {
            return `repos.${name} needs a \`path\``;
        }
    }
    for (const [name, service] of Object.entries(services)) {
        const problem = check_service_shape(name, service, repos, services);
        if (problem !== null) {
            return problem;
        }
    }
    const database = record["database"] as Record<string, unknown> | undefined;
    if (database !== undefined && database["server"] === "external" && !database["external"]) {
        return "database.server is external but `database.external` is missing";
    }
    return check_designs_shape(record["designs"], repos);
}

/** The `designs:` block (docs/designs/egm-adoption.md, D3, 2.5): optional, both keys optional. */
function check_designs_shape(designs: unknown, repos: Record<string, unknown>): string | null {
    if (designs === undefined) {
        return null;
    }
    if (typeof designs !== "object" || designs === null || Array.isArray(designs)) {
        return "designs must be a mapping";
    }
    const record = designs as Record<string, unknown>;
    for (const key of ["repo", "dir"]) {
        const value = record[key];
        if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
            return `designs.${key} must be a non-empty string`;
        }
    }
    const repo = record["repo"];
    if (typeof repo === "string" && !(repo in repos)) {
        return `designs.repo "${repo}" is not a repo of this project`;
    }
    return null;
}

function check_service_shape(
    name: string,
    service: Record<string, unknown>,
    repos: Record<string, unknown>,
    services: Record<string, unknown>,
): string | null {
    if (!/^[a-z0-9-]+$/.test(name)) {
        return `services.${name}: names are lower-case letters, digits and dashes`;
    }
    const on_host = service["runtime"] === "host";
    if (!on_host && typeof service["image"] !== "string") {
        return `services.${name} needs an \`image\``;
    }
    const repo = service["repo"];
    if (repo !== undefined && !(typeof repo === "string" && repo in repos)) {
        return `services.${name}.repo "${String(repo)}" is not under repos`;
    }
    if (on_host && (repo === undefined || typeof service["command"] !== "string")) {
        return `services.${name}: runtime host needs a repo and a command`;
    }
    if (!on_host && service["host"] !== undefined && typeof service["port"] !== "number") {
        return `services.${name} has a host but no port`;
    }
    const depends_on = service["depends_on"];
    if (depends_on !== undefined) {
        if (!Array.isArray(depends_on)) {
            return `services.${name}.depends_on must be a list`;
        }
        const missing = depends_on.find((other) => !(other in services));
        if (missing !== undefined) {
            return `services.${name}.depends_on "${String(missing)}" is not a service`;
        }
    }
    return null;
}

/** `~/x` becomes `<home>/x`. Other paths are returned unchanged. */
export function expand_home(path: string): string {
    if (path === "~") {
        return homedir();
    }
    if (path.startsWith("~/")) {
        return join(homedir(), path.slice(2));
    }
    return path;
}
