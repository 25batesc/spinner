// Types for `spinner.yaml`, the stack spec of a project. The shape follows docs/STACK_SPEC.md.
// The JSON schema in `schema/stack-spec.json` is generated from this file; run
// `pnpm --filter @spinner/protocol schema` after an edit. The stack runner in the daemon
// renders one of these, plus a session, into `stack/compose.yaml` and `stack/.env`.

/**
 * Where the service runs. `node` and `python` run in a container and pick the healthcheck
 * probe and the kind of dependency volume. `host` runs the command on the host, in the
 * worktree, for a service whose dependencies have no wheel for the container platform;
 * Spinner assigns it a port and routes its hostname to it.
 */
export type ServiceRuntime = "node" | "python" | "host";

/**
 * The kind of dependency volume a service mounts. The volume name is keyed by the hash of the
 * repo's lockfile, so sessions with the same lockfile share one install.
 */
export type DepsVolume = "pnpm-store" | "npm-cache" | "yarn-cache" | "venv";

export interface StackRepo {
    /** Path of the repo on this machine. May start with `~`, or be relative to the spec file. */
    path: string;
    /** Branch the worktree starts from and the PR targets. Overrides the top-level `base`. */
    base?: string;
    /**
     * Untracked files (`.npmrc`, `.env.local`) that `spinner new` copies from the primary
     * checkout into the worktree when they are absent there. Paths relative to the repo.
     */
    seed_files?: string[];
    /**
     * Local directories (`.venv`, `node_modules`) that the worktree symlinks to the primary
     * checkout's copy instead of installing again, as the Knit team's `wt` tool does. Paths
     * relative to the repo. The link is excluded from git through `info/exclude`.
     */
    seed_links?: string[];
}

export interface StackService {
    /** Name under `repos`. When set, the session's worktree is bind-mounted at `/app`. */
    repo?: string;
    /**
     * Image name. Built from `dockerfile` when set, else from the repo's `Dockerfile.dev`
     * (next to `workdir`, then at the repo root) when one exists, else pulled. Required
     * unless `runtime` is `host`.
     */
    image?: string;
    /**
     * A dev Dockerfile outside the repo, relative to the spec file; its directory is the
     * build context. For private multi-repo setups whose repos must stay untouched.
     */
    dockerfile?: string;
    runtime?: ServiceRuntime;
    /** Command prefix run before `command`, for a secrets injector. Relative to the worktree. */
    wrapper?: string;
    /** Directory inside the worktree where `command` runs. */
    workdir?: string;
    command?: string;
    /**
     * For `runtime: host`: a command run in `workdir`, through `wrapper` and with the same
     * environment, before the service starts. A non-zero exit fails `up` at once with the
     * command's last lines, for an import error a dev server would only log.
     */
    preflight?: string;
    /** The port the process listens on inside the container. A host service gets one assigned. */
    port?: number;
    /** Hostname label: `<host>.<session>.localhost`. Services without one are internal only. */
    host?: string;
    /** Environment for the process. Values may use `${SESSION_ID}` and the other variables. */
    env?: Record<string, string>;
    /**
     * Path inside the worktree where the runner writes `env` before start, for frontends that
     * read their environment at build time from a dotenv file.
     */
    env_file?: string;
    /** `GET /path`: polled through the service port until it answers 2xx. */
    healthcheck?: string;
    depends_on?: string[];
    deps_volume?: DepsVolume;
    /**
     * The install command for the dependency volume, run once in the lockfile's directory,
     * instead of the one the lockfile implies (`npm ci`, `pnpm install --frozen-lockfile`).
     * For a repo that needs `npm install --legacy-peer-deps`.
     */
    install?: string;
    /** Extra compose volumes, `name:/path` or `/host:/path`. */
    volumes?: string[];
    /**
     * Container ports a `runtime: host` service must reach, published on loopback at a
     * per-session port. `env` may refer to it as `${<SERVICE>_<PORT>_HOST_PORT}`, for
     * example `${TEMPORAL_7233_HOST_PORT}`.
     */
    publish?: number[];
}

export type DatabaseMode = "template" | "per-session";

/** `spinner-postgres` is a container Spinner starts; `external` is a server it never manages. */
export type DatabaseServer = "spinner-postgres" | "external";

export interface ExternalDatabase {
    host: string;
    port: number;
    user: string;
    /** Password, when the server needs one. Defaults to the user name, as local stacks do. */
    password?: string;
}

export interface DatabaseSeed {
    /** A SQL file or a gzip-compressed SQL file, relative to the spec file. */
    dump?: string;
    /**
     * Host command that applies migrations. Runs in the primary checkout of `repo` with
     * `DATABASE_URL` set to a fresh, empty template database, unless `source` is set.
     */
    migrate?: string;
    /** Host command that loads fixtures, after `migrate`, in the same environment. */
    fixtures?: string;
    /** Repo whose primary checkout the commands run in. Defaults to the first repo. */
    repo?: string;
    /**
     * Name of the database the commands fill when they ignore `DATABASE_URL`, for example
     * `postgres` for a Supabase stack. It is copied into the template afterwards.
     */
    source?: string;
}

export interface StackDatabase {
    mode: DatabaseMode;
    server?: DatabaseServer;
    external?: ExternalDatabase;
    /** Postgres major version for the `spinner-postgres` container. */
    version?: string;
    /** Name of the template database. Defaults to `<name>_seed`. */
    template?: string;
    seed?: DatabaseSeed;
}

export interface StackProxy {
    /** Host port Traefik listens on. */
    http_port?: number;
    /** Services whose responses lose `X-Frame-Options` and `frame-ancestors`, to embed them. */
    strip_frame_headers?: string[];
}

export interface HarnessConfig {
    default?: "pi";
    pi?: { trust_projects?: boolean };
}

/** The whole of `spinner.yaml`. `pipeline` is typed by the board's `pipeline.ts`. */
export interface StackSpec {
    name: string;
    /** The branch PRs land in, unless a repo overrides it. */
    base: string;
    repos: Record<string, StackRepo>;
    services: Record<string, StackService>;
    database?: StackDatabase;
    proxy?: StackProxy;
    /** Host environment variables copied into every service. */
    pass_env?: string[];
    harness?: HarnessConfig;
    pipeline?: Record<string, unknown>;
}
