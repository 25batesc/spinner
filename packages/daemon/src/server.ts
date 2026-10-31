// The HTTP and WebSocket surface of spinnerd. Routes are the ones listed in
// `@spinner/protocol` `ROUTES`; the WebSocket at `EVENTS_PATH` forwards every bus event as one
// JSON message. Reads return `SessionView`s; writes start a job and answer 202. The server
// binds to loopback only and has no authentication (v1, single user). Route handlers parse,
// look up and answer; the work is in `actions.ts`, which the CLI calls too.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { WebSocketServer, type WebSocket } from "ws";
import type {
    AgentCommandResponse,
    AgentEventsResponse,
    AgentNotRunningResponse,
    AgentResponse,
    BuildInfo,
    ErrorResponse,
    HealthResponse,
    JobAction,
    JobResponse,
    JobsResponse,
    ModelsResponse,
    ModelView,
    ProjectsResponse,
    SessionResponse,
    SessionsResponse,
    SessionSummary,
    SettingsResponse,
    StackLogsResponse,
    StackSpec,
    UsageResponse,
    SessionView,
} from "@spinner/protocol";
import {
    DAEMON_HOST,
    DAEMON_PORT,
    EVENTS_PATH,
    STACK_LOGS_LINES_DEFAULT,
    STACK_LOGS_LINES_MAX,
    USAGE_INTERVAL_MS,
} from "@spinner/protocol";
import * as actions from "./actions.js";
import type { ActionContext } from "./actions.js";
import { Deliverer } from "./agents/delivery.js";
import { fixer_driver } from "./agents/fixer.js";
import { PiRpcHarness, type AgentHandle } from "./agents/harness.js";
import { PiTtyHarness } from "./agents/tty-harness.js";
import { mount_tty_routes, tty_upgrader } from "./agents/routes-tty.js";
import { agent_history } from "./agents/history.js";
import { AgentManager } from "./agents/manager.js";
import { mount_agent_routes } from "./agents/routes.js";
import { models_source } from "./agents/models.js";
import { resolve_pi_binary } from "./agents/pi-rpc.js";
import { EventBus } from "./event-bus.js";
import type { SpinnerHome } from "./home.js";
import { JobRunner, type JobWork } from "./jobs/jobs.js";
import { gh_runner, type GhRunner } from "./pipeline/github.js";
import type { GithubWriter } from "./pipeline/github-write.js";
import { macos_notifier, type Notifier } from "./pipeline/notify.js";
import { start_poller, type Poller } from "./pipeline/poller.js";
import { mount_pipeline_routes } from "./pipeline/routes.js";
import { watch_stack_jobs } from "./stack/job-record.js";
import { service_log_lines, StackLogsError } from "./stack/logs.js";
import { start_usage_sampler, type UsageSampler } from "./stack/usage.js";
import { list_themes, read_settings, write_settings } from "./settings.js";
import { list_projects } from "./projects.js";
import {
    parse_add_agent,
    parse_adopt,
    parse_agent_message,
    parse_new_session,
    parse_up,
    parse_verify,
} from "./requests.js";
import { MissionWriter } from "./store/mission-writer.js";
import { find_session, list_sessions, read_session } from "./store/session-store.js";
import {
    build_session_view,
    session_spec_or_null,
    type ViewContext,
} from "./views/session-view.js";
import {
    OBSERVE_INTERVAL_MS,
    start_stack_observer,
    type StackObserver,
} from "./views/stack-observer.js";
import { watch_session_files } from "./watch/session-files.js";
import { watch_sessions, type SessionWatcher, type ViewBuilder } from "./watcher.js";

export interface DaemonOptions {
    home: SpinnerHome;
    /** TCP port. 0 asks the OS for a free port, which tests use. */
    port?: number;
    host?: string;
    /** Logger for one-line notices. Defaults to console.error so stdout stays clean. */
    log?: (line: string) => void;
    /** Directory `find_spec` searches when a session names no project. Defaults to cwd. */
    cwd?: string;
    /** The `gh` runner and the notifier of the poller; tests pass fakes. */
    gh?: GhRunner;
    /** `gh` and `git` for GitHub writes, behind the allow-list; tests pass fakes. */
    writer?: GithubWriter;
    /** `land`'s wait between looks at the merge queue; tests shorten it. */
    land_poll_ms?: number;
    notify?: Notifier;
    /** GitHub poll interval. 0 disables the poller. */
    poll_seconds?: number;
    /** The built UI. Null means none; `GET /` then says how to build it. */
    ui_dir?: string | null;
    observe_interval_ms?: number;
    /** The usage sampler's interval; tests shorten it. */
    usage_interval_ms?: number;
    /** The pi executable; `SPINNER_PI` or `pi` on PATH when absent. Tests pass a fake. */
    pi?: string;
    /** The Spinner pi extension entry; the checkout's `packages/pi-extension` when absent. */
    extension?: string | null;
    /** `provider/model` for an agent that names none; pi's own default when absent. */
    default_model?: string;
    /** `config.yaml` `agents.harness`: `tty` (the default) or `rpc`. */
    agents_harness?: "tty" | "rpc";
    /** What `GET /health` reports as the build; `main.ts` reads it from the checkout. */
    build?: BuildInfo;
}

export interface Daemon {
    /** The bound port, which differs from the requested one when 0 was asked for. */
    port: number;
    home: SpinnerHome;
    bus: EventBus;
    jobs: JobRunner;
    agents: AgentManager;
    /** The tty harness, so a test can look at an agent's pty. */
    tty: PiTtyHarness;
    watcher: SessionWatcher;
    close(): Promise<void>;
}

/** What the routes need. `start_daemon` builds one; a route test builds its own. */
export interface AppDeps {
    home: SpinnerHome;
    started: string;
    build: BuildInfo;
    log: (line: string) => void;
    ctx: ActionContext;
    jobs: JobRunner;
    view: ViewBuilder;
    /** Called after a job on `dir` finished, so the view carries fresh stack facts. */
    refresh: (dir: string) => Promise<void>;
    ui_dir: string | null;
    agents: AgentManager;
    /** The tty harness, for the pty WebSocket and the extension's routes; null without one. */
    tty?: PiTtyHarness | null;
    /** `GET /usage`; a route test passes a stub. */
    usage?: () => UsageResponse;
    models: () => Promise<ModelView[]>;
    bus: EventBus;
    /** ext: the mission writer and the deliverer; the agent routes mount when both are set. */
    writer?: MissionWriter;
    deliverer?: Deliverer;
}

const POLL_SECONDS_DEFAULT = 60;

/** `packages/ui/dist`, from `packages/daemon/{src,dist}/server.{ts,js}`. */
export function default_ui_dir(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "dist");
}

/** Builds the Hono app alone, without sockets, so route tests can call `app.request()`. */
export function create_app(deps: AppDeps): Hono {
    const app = new Hono();
    // The Vite dev server proxies REST calls, but a built UI served from another origin or a
    // curl from a browser extension still benefits from permissive CORS on a loopback daemon.
    app.use("*", cors());

    app.get("/health", (c) => {
        const body: HealthResponse = {
            ok: true,
            home: deps.home.root,
            started: deps.started,
            build: deps.build,
        };
        return c.json(body);
    });

    app.get("/projects", (c) => {
        const body: ProjectsResponse = { projects: list_projects(deps.home, deps.log) };
        return c.json(body);
    });

    app.get("/sessions", (c) => {
        const result = list_sessions(deps.home);
        const body: SessionsResponse = { sessions: result.sessions.map(deps.view) };
        return c.json(body);
    });

    app.post("/sessions", async (c) => {
        const input = await json_body(c);
        const request = parse_new_session(input);
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        let summary;
        try {
            summary = actions.new_session(deps.ctx, request);
        } catch (error) {
            return c.json(error_body(describe_error(error)), 409);
        }
        const dir = summary.dir;
        return start_job(c, deps, "new", dir, (log) =>
            actions.attach_new_session(deps.ctx, summary, request.project, log).then(() => {}),
        );
    });

    app.post("/sessions/adopt", async (c) => {
        const request = parse_adopt(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        return start_job(c, deps, "adopt", null, async (log, set_session) => {
            const summary = await actions.adopt(deps.ctx, request, log);
            set_session(summary.dir);
        });
    });

    app.get("/sessions/:dir", (c) => {
        const read = read_session(deps.home, c.req.param("dir"));
        if (!read.ok) {
            return c.json(error_body(read.error), 404);
        }
        const body: SessionResponse = { session: deps.view(read.summary) };
        return c.json(body);
    });

    app.get("/sessions/:dir/mission", (c) => {
        const file = join(deps.home.sessions, c.req.param("dir"), "MISSION.md");
        if (!existsSync(file)) {
            return c.json(error_body(`${file} does not exist`), 404);
        }
        return c.body(readFileSync(file, "utf8"), 200, { "content-type": "text/markdown" });
    });

    app.post("/sessions/:dir/up", async (c) => {
        const request = parse_up(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        return start_job(c, deps, "up", summary.dir, (log) =>
            actions.up(deps.ctx, summary, request, log).then(() => {}),
        );
    });

    app.post("/sessions/:dir/down", (c) => {
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        return start_job(c, deps, "down", summary.dir, (log) =>
            actions.down(deps.ctx, summary, log),
        );
    });

    app.post("/sessions/:dir/close", (c) => {
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        return start_job(c, deps, "close", summary.dir, (log) =>
            actions.close(deps.ctx, summary, log).then(() => {}),
        );
    });

    app.post("/sessions/:dir/verify", async (c) => {
        const request = parse_verify(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        return start_job(c, deps, "verify", summary.dir, async (log) => {
            actions.verify(deps.ctx, summary, request, log);
        });
    });

    app.post("/sessions/:dir/agents", async (c) => {
        const request = parse_add_agent(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        try {
            const handle = await deps.agents.add(summary, request);
            const body: AgentResponse = { name: request.name, pi_session_id: handle.pi_session_id };
            return c.json(body, 201);
        } catch (error) {
            // An agent that runs already, or a repo without a worktree, is the caller's
            // conflict; a pi that fails to start is the daemon's fault.
            const message = describe_error(error);
            const conflict = message.includes("already running") || message.includes("no worktree");
            const status = conflict ? 409 : 500;
            return c.json(error_body(message), status);
        }
    });

    for (const command of ["prompt", "steer"] as const) {
        app.post(`/sessions/:dir/agents/:name/${command}`, async (c) => {
            const request = parse_agent_message(await json_body(c));
            if (typeof request === "string") {
                return c.json(error_body(request), 400);
            }
            const name = c.req.param("name");
            const summary = find_session(deps.home, c.req.param("dir"));
            if (summary === null) {
                return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
            }
            const handle = deps.agents.get(summary.dir, name);
            if (handle === null) {
                // A listed but stopped agent is a 409 with its state, so the tab offers resume;
                // an agent the session never had is a 404.
                const listed = summary.session.agents?.[name];
                if (listed === undefined) {
                    return c.json(error_body(`agent ${name} is not in ${summary.dir}`), 404);
                }
                const body: AgentNotRunningResponse = {
                    error: `agent ${name} is not running (${listed.process})`,
                    process: listed.process,
                };
                return c.json(body, 409);
            }
            try {
                const disposition = await handle[command](request.text);
                const body: AgentCommandResponse = { ok: true, disposition };
                return c.json(body);
            } catch (error) {
                return c.json(error_body(describe_error(error)), 500);
            }
        });
    }

    app.post("/sessions/:dir/agents/:name/abort", async (c) => {
        const handle = running_agent(deps, c.req.param("dir"), c.req.param("name"));
        if (handle === null) {
            return c.json(error_body(`agent ${c.req.param("name")} is not running`), 404);
        }
        await handle.abort();
        const body: AgentCommandResponse = { ok: true };
        return c.json(body);
    });

    app.post("/sessions/:dir/agents/:name/stop", async (c) => {
        try {
            const summary = find_session(deps.home, c.req.param("dir"));
            await deps.agents.stop(summary?.dir ?? c.req.param("dir"), c.req.param("name"));
        } catch (error) {
            return c.json(error_body(describe_error(error)), 404);
        }
        const body: AgentCommandResponse = { ok: true };
        return c.json(body);
    });

    app.get("/sessions/:dir/agents/:name/events", (c) => {
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const body: AgentEventsResponse = {
            events: agent_history(summary.path, c.req.param("name")),
        };
        return c.json(body);
    });

    app.get("/sessions/:dir/stack/logs/:service", async (c) => {
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const lines = parse_lines(c.req.query("lines"));
        if (typeof lines === "string") {
            return c.json(error_body(lines), 400);
        }
        const service = c.req.param("service");
        if (!/^[a-z0-9][a-z0-9_-]*$/i.test(service)) {
            return c.json(error_body(`service name "${service}" is not valid`), 400);
        }
        try {
            const body: StackLogsResponse = await service_log_lines(summary, service, lines);
            return c.json(body);
        } catch (error) {
            const status = error instanceof StackLogsError ? error.status : 500;
            return c.json(error_body(describe_error(error)), status);
        }
    });

    app.get("/settings", (c) => {
        try {
            const body: SettingsResponse = read_settings(deps.home);
            return c.json(body);
        } catch (error) {
            return c.json(error_body(describe_error(error)), 500);
        }
    });

    app.put("/settings", async (c) => {
        const input = await json_body(c);
        if (input === undefined || input === null) {
            return c.json(error_body("request body must be the settings document"), 400);
        }
        const written = write_settings(deps.home, input);
        if (typeof written === "string") {
            return c.json(error_body(written), 400);
        }
        deps.bus.publish({
            type: "settings",
            ts: new Date().toISOString(),
            session: null,
            settings: written.settings,
        });
        return c.json(written);
    });

    app.get("/themes", (c) => {
        return c.json(list_themes(deps.home));
    });

    app.get("/usage", (c) => {
        if (deps.usage === undefined) {
            return c.json(error_body("usage sampling is not available"), 503);
        }
        const body: UsageResponse = deps.usage();
        return c.json(body);
    });

    app.get("/models", async (c) => {
        try {
            const body: ModelsResponse = { models: await deps.models() };
            return c.json(body);
        } catch (error) {
            return c.json(error_body(describe_error(error)), 503);
        }
    });

    app.get("/jobs", (c) => {
        const body: JobsResponse = { jobs: deps.jobs.recent() };
        return c.json(body);
    });

    app.get("/jobs/:id", (c) => {
        const job = deps.jobs.get(c.req.param("id"));
        if (job === null) {
            return c.json(error_body(`no job ${c.req.param("id")}`), 404);
        }
        const body: JobResponse = { job };
        return c.json(body);
    });

    mount_pipeline_routes(app, deps); // engine: pr, fix, threads, post, approve, land, reset
    if (deps.writer !== undefined && deps.deliverer !== undefined) {
        // ext: mission section, inbox, context
        mount_agent_routes(app, { ...deps, writer: deps.writer, deliverer: deps.deliverer });
    }
    if (deps.tty !== undefined && deps.tty !== null) {
        mount_tty_routes(app, { home: deps.home, agents: deps.agents, tty: deps.tty });
    }
    mount_ui(app, deps.ui_dir);
    return app;
}

/** The agent of `:dir/:name`; `:dir` is a directory name or a session id. */
function running_agent(deps: AppDeps, dir: string, name: string): AgentHandle | null {
    const summary = find_session(deps.home, dir);
    if (summary === null) {
        return null;
    }
    return deps.agents.get(summary.dir, name);
}

/** Starts the job and answers 202, or 409 when the session is busy. */
function start_job(
    c: Context,
    deps: AppDeps,
    action: JobAction,
    session: string | null,
    work: JobWork,
): Response {
    const refreshed: JobWork = async (log, set_session) => {
        let dir = session;
        try {
            await work(log, (created) => {
                dir = created;
                set_session(created);
            });
        } finally {
            if (dir !== null) {
                await deps.refresh(dir);
            }
        }
    };
    try {
        const job = deps.jobs.start(action, session, refreshed);
        const body: JobResponse = { job };
        return c.json(body, 202);
    } catch (error) {
        return c.json(error_body(describe_error(error)), 409);
    }
}

/** The built UI at `/`. Without a build, `/` says what to run; the API stays up. */
function mount_ui(app: Hono, ui_dir: string | null): void {
    const index = ui_dir === null ? null : join(ui_dir, "index.html");
    if (index !== null && existsSync(index)) {
        app.use("/*", serveStatic({ root: ui_dir ?? "" }));
        app.get("/", (c) => c.html(readFileSync(index, "utf8")));
        return;
    }
    app.get("/", (c) =>
        c.text(
            [
                "spinnerd is running, but the UI is not built.",
                "Run `pnpm --filter @spinner/ui build` in the Spinner checkout, then reload.",
                ui_dir === null ? "" : `Looked for ${index ?? ""}.`,
                "Set SPINNER_UI_DIR to serve a build from another directory.",
            ].join("\n"),
            503,
        ),
    );
}

/** Starts the HTTP server, the WebSocket endpoint, the watcher, the observer and the poller. */
export async function start_daemon(options: DaemonOptions): Promise<Daemon> {
    const port = options.port ?? DAEMON_PORT;
    const host = options.host ?? DAEMON_HOST;
    const log = options.log ?? ((line) => console.error(line));
    assert.ok(port >= 0 && port <= 65535, `port ${port} out of range`);
    const home = options.home;
    const cwd = options.cwd ?? process.cwd();
    const started = new Date().toISOString();
    const bus = new EventBus();
    const jobs = new JobRunner(bus);
    const ctx: ActionContext = {
        home,
        cwd,
        gh: options.gh ?? gh_runner,
        ...(options.writer === undefined ? {} : { writer: options.writer }),
        ...(options.notify === undefined ? {} : { notify: options.notify }),
        ...(options.land_poll_ms === undefined ? {} : { land_poll_ms: options.land_poll_ms }),
    };

    const pi = (): string => options.pi ?? resolve_pi_binary();
    let bound_port = port;
    const harness_options = {
        pi,
        on_stderr: (agent: string, line: string) => log(`pi ${agent}: ${line}`),
        daemon_url: () => `http://${host}:${bound_port}`,
        ...(options.extension === undefined ? {} : { extension: options.extension }),
        ...(options.default_model === undefined ? {} : { default_model: options.default_model }),
    };
    const tty = new PiTtyHarness(harness_options);
    const agents = new AgentManager(
        home,
        { default: options.agents_harness ?? "tty", tty, rpc: new PiRpcHarness(harness_options) },
        bus,
        { log },
    );
    const writer = new MissionWriter(home, bus);
    const deliverer = new Deliverer(home, agents, writer, bus, { log });
    ctx.fixer = fixer_driver({ home, agents, cwd });

    let observer: StackObserver | null = null;
    let usage: UsageSampler | null = null;
    const view_ctx: ViewContext = {
        home,
        cwd,
        observation: (dir) => observer?.get(dir) ?? null,
        usage: (dir) => usage?.get(dir) ?? null,
        agents_running: (dir) => agents.running(dir),
        now: () => new Date(),
        log,
    };
    const view: ViewBuilder = (summary) => build_session_view(view_ctx, summary);
    const publish_view = (dir: string): void => {
        const read = read_session(home, dir);
        if (read.ok) {
            const ts = new Date().toISOString();
            bus.publish({ type: "session.updated", ts, session: dir, data: view(read.summary) });
        }
    };
    const sessions_with_specs = (): { summary: SessionSummary; spec: StackSpec | null }[] =>
        list_sessions(home).sessions.map((summary) => ({
            summary,
            spec: session_spec_or_null(summary),
        }));
    observer = start_stack_observer(
        {
            sessions: sessions_with_specs,
            on_change: (dir) => {
                usage?.wake();
                publish_view(dir);
            },
        },
        options.observe_interval_ms ?? OBSERVE_INTERVAL_MS,
    );
    usage = start_usage_sampler(
        { sessions: sessions_with_specs, bus, log },
        options.usage_interval_ms ?? USAGE_INTERVAL_MS,
    );
    const sampler = usage;
    const refresh = async (dir: string): Promise<void> => {
        await observer?.round();
        sampler.wake();
        publish_view(dir);
    };

    const app = create_app({
        home,
        started,
        build: options.build ?? { version: "0.0.0", commit: null, built: null },
        log,
        ctx,
        jobs,
        view,
        refresh,
        ui_dir: options.ui_dir === undefined ? default_ui_dir() : options.ui_dir,
        agents,
        tty,
        usage: () => sampler.response(),
        models: models_source(pi, home.root),
        bus,
        writer,
        deliverer,
    });
    const server = await listen(app, host, port);
    const address = server.address();
    assert.ok(address !== null && typeof address === "object", "server must have a TCP address");
    bound_port = address.port;

    const unwatch_stack_jobs = watch_stack_jobs({ home, bus, agents, log });
    const ttys = tty_upgrader({ home, agents, tty, log });
    const sockets = attach_events_socket(server, bus, log, ttys.handle);
    const watcher = watch_sessions(home, bus, view, { on_error: log });
    await watcher.ready;
    deliverer.prime(list_sessions(home).sessions.map((summary) => summary.dir));
    const files = watch_session_files(home, {
        on_mission: (dir) => deliverer.on_mission_change(dir),
        on_notes: (dir, agent) => deliverer.on_notes_change(dir, agent),
        on_inbox: (dir, file) => void deliverer.deliver_inbox(dir, file),
        on_error: log,
    });
    await files.ready;
    const poller = start_github_poller(options, ctx, log);
    log(`spinnerd listening on http://${host}:${bound_port}, home ${home.root}`);
    for (const resumed of await agents.adopt_all()) {
        log(`adopt: resumed tty agent ${resumed} on its transcript`);
    }

    return {
        port: bound_port,
        home,
        bus,
        jobs,
        agents,
        tty,
        watcher,
        close: async () => {
            unwatch_stack_jobs();
            await agents.stop_all();
            poller?.stop();
            observer?.stop();
            sampler.stop();
            deliverer.close();
            await files.close();
            await watcher.close();
            for (const socket of sockets.clients) {
                socket.terminate();
            }
            sockets.close();
            ttys.close();
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
                // Keep-alive connections from fetch would hold `close` for their idle timeout.
                server.closeAllConnections();
            });
        },
    };
}

/**
 * The GitHub poller as a daemon loop. A transition writes `session.yaml`, which the watcher
 * turns into `session.updated`; the notifier shows the macOS banner. `poll_seconds: 0` is
 * off, for tests and for a machine without `gh`.
 */
function start_github_poller(
    options: DaemonOptions,
    ctx: ActionContext,
    log: (line: string) => void,
): Poller | null {
    const seconds = options.poll_seconds ?? POLL_SECONDS_DEFAULT;
    if (seconds === 0) {
        return null;
    }
    return start_poller(
        options.home,
        {
            gh: ctx.gh,
            notify: options.notify ?? macos_notifier,
            cwd: ctx.cwd,
            log,
            slack: (summary) => actions.slack_of(ctx, summary),
        },
        seconds * 1000,
        (report) => {
            for (const failure of report.errors) {
                log(`poll ${failure.dir}: ${failure.error}`);
            }
            for (const { dir, transition } of report.transitions) {
                log(`poll ${dir}: ${transition.from} → ${transition.to}`);
            }
        },
    );
}

function listen(app: Hono, hostname: string, port: number): Promise<Server> {
    return new Promise((resolve) => {
        const server = serve({ fetch: app.fetch, hostname, port }, () => {
            resolve(server as Server);
        });
    });
}

/** The daemon's second WebSocket path: a tty agent's pty. True when `other` took the upgrade. */
type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;

/**
 * Upgrades requests for `EVENTS_PATH` to WebSockets and forwards bus events to each client.
 * Any `Origin` is accepted: the UI dev server and the built UI run on different origins and
 * the daemon only listens on loopback. Every other path is offered to `other` (the tty route)
 * and is a 404 when it declines.
 */
function attach_events_socket(
    server: Server,
    bus: EventBus,
    log: (line: string) => void,
    other: UpgradeHandler,
): WebSocketServer {
    const sockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
        const path = new URL(request.url ?? "/", "http://localhost").pathname;
        if (path !== EVENTS_PATH) {
            if (!other(request, socket, head)) {
                socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
                socket.destroy();
            }
            return;
        }
        sockets.handleUpgrade(request, socket, head, (client) => {
            sockets.emit("connection", client, request);
        });
    });
    sockets.on("connection", (client: WebSocket) => {
        const unsubscribe = bus.subscribe((event) => {
            if (client.readyState === client.OPEN) {
                client.send(JSON.stringify(event));
            }
        });
        client.on("close", unsubscribe);
        client.on("error", (error) => log(`ws client error: ${error.message}`));
    });
    return sockets;
}

/** `?lines=` of the stack logs route: 1 to `STACK_LOGS_LINES_MAX`, default 100. */
function parse_lines(text: string | undefined): number | string {
    if (text === undefined || text === "") {
        return STACK_LOGS_LINES_DEFAULT;
    }
    const value = Number(text);
    if (!Number.isInteger(value) || value < 1 || value > STACK_LOGS_LINES_MAX) {
        return `\`lines\` must be an integer from 1 to ${STACK_LOGS_LINES_MAX}`;
    }
    return value;
}

/** The parsed JSON body, `undefined` for an empty body, or `null` for unparsable text. */
async function json_body(c: Context): Promise<unknown> {
    const text = await c.req.text();
    if (text.trim().length === 0) {
        return undefined;
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return null;
    }
}

function error_body(error: string): ErrorResponse {
    return { error };
}

function describe_error(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export type { SessionView };
