// `GET /projects`: every `spinner.yaml` the daemon can offer the new-session form, from the
// same places `find_spec` looks (`<home>/projects/<name>`, `local/<name>` in this checkout)
// plus `examples/<name>` for the sample stack. A spec that does not load is reported on the
// log and skipped, so one broken file does not hide the others.
import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { ProjectHelpResponse, ProjectView } from "@spinner/protocol";
import type { SpinnerHome } from "./home.js";
import { SPEC_FILE, check_spec_shape, expand_home, load_spec } from "./stack/spec.js";

/** Upper bound on project directories scanned per source. */
const PROJECT_DIRS_MAX = 200;

/** This file is `packages/daemon/{src,dist}/projects.{ts,js}`; three levels up is the checkout. */
function checkout_root(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function list_projects(home: SpinnerHome, log: (line: string) => void): ProjectView[] {
    const root = checkout_root();
    const sources: { source: ProjectView["source"]; dir: string }[] = [
        { source: "home", dir: join(home.root, "projects") },
        { source: "local", dir: join(root, "local") },
        { source: "examples", dir: join(root, "examples") },
    ];
    const projects: ProjectView[] = [];
    for (const { source, dir } of sources) {
        for (const path of spec_files_in(dir)) {
            try {
                const { spec } = load_spec(path);
                projects.push({
                    name: spec.name,
                    path,
                    source,
                    repos: Object.keys(spec.repos),
                    services: Object.keys(spec.services),
                });
            } catch (error) {
                log(`projects: skipped ${path}: ${describe(error)}`);
            }
        }
    }
    return projects;
}

function spec_files_in(dir: string): string[] {
    if (!existsSync(dir)) {
        return [];
    }
    const entries = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .slice(0, PROJECT_DIRS_MAX);
    return entries
        .map((name) => join(dir, name, SPEC_FILE))
        .filter((path) => existsSync(path));
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Why a project cannot be made; the route answers `status` (400 a bad spec, 409 a name taken). */
export class ProjectRefusal extends Error {
    constructor(
        message: string,
        readonly status: 400 | 409,
    ) {
        super(message);
    }
}

/** A spec is a small file; a larger body is not one. */
export const PROJECT_SPEC_BYTES_MAX = 256 * 1024;

/**
 * Makes a project from inside a session (the lead's `project` tool): checks the
 * `spinner.yaml` text and saves it as `<home>/projects/<name>/spinner.yaml`, where
 * `find_spec` and `GET /projects` look. A repo path must be absolute (or start with `~`) and
 * be a git checkout: a worktree needs a repository to come from. A project of that name in
 * another place, or a linked directory under `<home>/projects`, is never written over.
 */
export function create_project(
    home: SpinnerHome,
    text: string,
    replace: boolean,
    log: (line: string) => void,
): ProjectView {
    if (text.length > PROJECT_SPEC_BYTES_MAX) {
        throw new ProjectRefusal(`the spec is larger than ${PROJECT_SPEC_BYTES_MAX} bytes`, 400);
    }
    let parsed: unknown;
    try {
        parsed = parse(text);
    } catch (error) {
        throw new ProjectRefusal(`the spec is not YAML: ${describe(error)}`, 400);
    }
    const problem = check_spec_shape(parsed);
    if (problem !== null) {
        throw new ProjectRefusal(`the spec does not load: ${problem}`, 400);
    }
    const record = parsed as { name: string; repos: Record<string, { path: string }> };
    for (const [key, repo] of Object.entries(record.repos)) {
        const path = expand_home(repo.path);
        if (!isAbsolute(path)) {
            throw new ProjectRefusal(`repos.${key}.path must be absolute or start with ~`, 400);
        }
        if (!existsSync(join(path, ".git"))) {
            throw new ProjectRefusal(
                `repos.${key}.path ${repo.path} is not a git checkout; run git init and ` +
                    "make a first commit there before the project is made",
                400,
            );
        }
    }
    const dir = join(home.root, "projects", record.name);
    const taken = list_projects(home, () => {}).find((project) => project.name === record.name);
    const own = existsSync(dir) && !lstatSync(dir).isSymbolicLink();
    if (taken !== undefined && !(replace && own)) {
        const how = own ? "pass replace: true to write over it" : "pick another name";
        throw new ProjectRefusal(`a project "${record.name}" exists at ${taken.path}; ${how}`, 409);
    }
    if (existsSync(dir) && !own) {
        throw new ProjectRefusal(`${dir} is a link; pick another name`, 409);
    }
    mkdirSync(dir, { recursive: true });
    const path = join(dir, SPEC_FILE);
    writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
    const { spec } = load_spec(path);
    const verb = replace && taken !== undefined ? "replaced" : "made";
    log(`projects: ${verb} ${spec.name} at ${path}`);
    return {
        name: spec.name,
        path,
        source: "home",
        repos: Object.keys(spec.repos),
        services: Object.keys(spec.services),
    };
}

/** A small spec an agent can start from: one repo, one host service with a preview. */
export const PROJECT_EXAMPLE = [
    "name: my-game                 # lower-case letters, digits and dashes",
    "base: main                    # the branch pull requests go to",
    "",
    "repos:",
    "  game:",
    "    path: ~/code/my-game      # an existing git checkout with at least one commit",
    "    base: main",
    "",
    "# One entry per thing `run local` starts. `runtime: host` runs the command in the",
    "# session's worktree of `repo`; ${PORT} is the port Spinner gives the service, and the",
    "# preview pane shows http://<host>.<session id>.localhost once the healthcheck answers.",
    "services:",
    "  web:",
    "    repo: game",
    "    runtime: host",
    "    command: python3 -m http.server ${PORT}",
    "    host: web",
    "    healthcheck: GET /",
    "",
    "# A project without a database has no `database:` block. A project with nothing to",
    "# run has `services: {}`: the session still gets its worktrees and the pull request flow.",
    "",
].join("\n");

/** `GET /projects/help`: the reference's path in this checkout, and the example. */
export function project_help(): ProjectHelpResponse {
    return { doc: join(checkout_root(), "docs", "STACK_SPEC.md"), example: PROJECT_EXAMPLE };
}
