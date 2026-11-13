// `GET /projects`: every `spinner.yaml` the daemon can offer the new-session form, from the
// same places `find_spec` looks (`<home>/projects/<name>`, `local/<name>` in this checkout)
// plus `examples/<name>` for the sample stack. A spec that does not load is reported on the
// log and skipped, so one broken file does not hide the others.
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmdirSync,
    statSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type {
    ProjectDetailResponse,
    ProjectHelpResponse,
    ProjectSummary,
    ProjectView,
    SessionSummary,
    StackSpec,
} from "@spinner/protocol";
import type { SpinnerHome } from "./home.js";
import { pipeline_config_from_spec } from "./pipeline/config.js";
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
    // A link is how the operator registers a spec kept elsewhere (`POST /projects/link`).
    const entries = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
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

/**
 * Why a project cannot be made or changed; the route answers `status` (400 a bad spec, 404 an
 * unknown project, 409 a name taken or a project the daemon may not change).
 */
export class ProjectRefusal extends Error {
    constructor(
        message: string,
        readonly status: 400 | 404 | 409,
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
    const record = check_spec_text(text);
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
    write_spec_text(path, text);
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

/**
 * The checks every spec text the daemon writes passes: YAML, the spec's shape, and each repo
 * path absolute (or `~`) and a git checkout, since a worktree needs a repository to come from.
 */
function check_spec_text(text: string): { name: string } {
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
    return record;
}

function write_spec_text(path: string, text: string): void {
    writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
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

/** The project `GET /projects` lists under `name`: the first one, in the list's order. */
function find_project(home: SpinnerHome, name: string, log: (line: string) => void): ProjectView {
    const project = list_projects(home, log).find((entry) => entry.name === name);
    if (project === undefined) {
        throw new ProjectRefusal(`no project "${name}"`, 404);
    }
    return project;
}

/** `GET /projects/:name`: the file, what it sets, and the live sessions that use it. */
export function project_detail(
    home: SpinnerHome,
    name: string,
    sessions: readonly SessionSummary[],
    log: (line: string) => void,
): ProjectDetailResponse {
    const project = find_project(home, name, log);
    const { spec } = load_spec(project.path);
    const text = readFileSync(project.path, "utf8");
    // `load_spec` checked the shape; the parse keeps the repo paths as the file writes them.
    const written = parse(text) as Pick<StackSpec, "repos">;
    const linked =
        project.source === "local" ||
        (project.source === "home" && lstatSync(dirname(project.path)).isSymbolicLink());
    return {
        project,
        spec: text,
        writable: project.source !== "examples",
        linked,
        summary: summarize(spec, written),
        sessions: sessions
            .filter((summary) => summary.session.project === project.name)
            .map((summary) => ({
                dir: summary.dir,
                id: summary.session.id,
                title: summary.session.title,
                stack: summary.session.stack.state,
            })),
    };
}

/** `spec` is the loaded spec (absolute paths); `written` is the file as parsed. */
function summarize(spec: StackSpec, written: Pick<StackSpec, "repos">): ProjectSummary {
    const pipeline = pipeline_config_from_spec(spec);
    const database = spec.database;
    return {
        base: spec.base,
        repos: Object.entries(spec.repos).map(([key, repo]) => ({
            key,
            path: written.repos[key]?.path ?? repo.path,
            absolute: repo.path,
            base: repo.base ?? spec.base,
            git: existsSync(join(repo.path, ".git")),
        })),
        services: Object.entries(spec.services).map(([name, service]) => ({
            name,
            runtime: service.runtime === "host" ? "host" : "container",
            repo: service.repo ?? null,
            command: service.command ?? null,
            image: service.image ?? null,
            host: service.host ?? null,
            port: service.port ?? null,
            healthcheck: service.healthcheck ?? null,
            preview: service.preview ?? "frame",
            depends_on: service.depends_on ?? [],
        })),
        database:
            database === undefined
                ? null
                : {
                      mode: database.mode,
                      server: database.server ?? "spinner-postgres",
                      template: database.template ?? `${spec.name}_seed`,
                  },
        pipeline: {
            write_repos: pipeline.github.write_repos,
            bot_logins: pipeline.github.bot_logins,
            merge_queue: pipeline.github.merge_queue,
            approval_check: pipeline.github.approval_check ?? null,
            slack_channel: pipeline.slack.channel ?? null,
            slack_post: pipeline.slack.post,
            threads_autofix: pipeline.threads.autofix,
        },
    };
}

/**
 * `PUT /projects/:name/spec`: the operator's edit, checked as `create_project` checks a spec.
 * It is written through a link: the file is the operator's own.
 */
export function save_project_spec(
    home: SpinnerHome,
    name: string,
    text: string,
    sessions: readonly SessionSummary[],
    log: (line: string) => void,
): ProjectDetailResponse {
    const project = find_project(home, name, log);
    if (project.source === "examples") {
        throw new ProjectRefusal(`${project.path} is tracked by the repository; copy it`, 409);
    }
    const record = check_spec_text(text);
    if (record.name !== name) {
        throw new ProjectRefusal(`the spec's name is "${record.name}"; it must be "${name}"`, 400);
    }
    write_spec_text(project.path, text);
    log(`projects: saved ${name} at ${project.path}`);
    return project_detail(home, name, sessions, log);
}

/**
 * `DELETE /projects/:name`: only what the daemon holds under `<home>/projects`. A link goes
 * and its target stays; a directory goes when it holds nothing but the spec. Nothing is
 * removed through a link.
 */
export function delete_project(
    home: SpinnerHome,
    name: string,
    sessions: readonly SessionSummary[],
    log: (line: string) => void,
): void {
    const project = find_project(home, name, log);
    const users = sessions.filter((summary) => summary.session.project === name);
    if (users.length > 0) {
        const dirs = users.map((summary) => summary.dir).join(", ");
        throw new ProjectRefusal(`the sessions ${dirs} use ${name}; close them first`, 409);
    }
    if (project.source !== "home") {
        throw new ProjectRefusal(`${project.path} is under ${project.source}/, not the home`, 409);
    }
    const dir = dirname(project.path);
    if (lstatSync(dir).isSymbolicLink()) {
        unlinkSync(dir);
        log(`projects: unlinked ${name} (${dir})`);
        return;
    }
    const others = readdirSync(dir).filter((entry) => entry !== SPEC_FILE);
    if (others.length > 0) {
        throw new ProjectRefusal(`${dir} holds other files: ${others.join(", ")}`, 409);
    }
    unlinkSync(project.path);
    rmdirSync(dir);
    log(`projects: deleted ${name} (${dir})`);
}

/**
 * `POST /projects/link`: registers a `spinner.yaml` kept elsewhere as the link
 * `<home>/projects/<spec name>` to its directory.
 */
export function link_project(
    home: SpinnerHome,
    path: string,
    sessions: readonly SessionSummary[],
    log: (line: string) => void,
): ProjectDetailResponse {
    const given = expand_home(path);
    if (!isAbsolute(given)) {
        throw new ProjectRefusal("`path` must be absolute or start with ~", 400);
    }
    const is_dir = existsSync(given) && statSync(given).isDirectory();
    const file = is_dir ? join(given, SPEC_FILE) : given;
    if (basename(file) !== SPEC_FILE) {
        throw new ProjectRefusal(`${file} is not a ${SPEC_FILE}`, 400);
    }
    let name: string;
    try {
        name = load_spec(file).spec.name;
    } catch (error) {
        throw new ProjectRefusal(`the spec does not load: ${describe(error)}`, 400);
    }
    const taken = list_projects(home, () => {}).find((project) => project.name === name);
    if (taken !== undefined) {
        throw new ProjectRefusal(`a project "${name}" exists at ${taken.path}`, 409);
    }
    const link = join(home.root, "projects", name);
    mkdirSync(dirname(link), { recursive: true });
    try {
        symlinkSync(dirname(file), link);
    } catch (error) {
        // A dangling link or a stray file of that name: never replaced.
        throw new ProjectRefusal(`${link} exists: ${describe(error)}`, 409);
    }
    log(`projects: linked ${name} to ${dirname(file)}`);
    return project_detail(home, name, sessions, log);
}
