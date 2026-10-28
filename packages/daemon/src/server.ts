// The HTTP and WebSocket surface of spinnerd. Routes are the ones listed in
// `@spinner/protocol` `ROUTES`; the WebSocket at `EVENTS_PATH` forwards every bus event as one
// JSON message. Reads return `SessionView`s; writes start a job and answer 202. The server
// binds to loopback only and has no authentication (v1, single user). Route handlers parse,
// look up and answer; the work is in `actions.ts`, which the CLI calls too.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { WebSocketServer, type WebSocket } from "ws";
import type {
    ErrorResponse,
    HealthResponse,
    JobAction,
    JobResponse,
    ProjectsResponse,
    SessionResponse,
    SessionsResponse,
    SessionView,
} from "@spinner/protocol";
import { DAEMON_HOST, DAEMON_PORT, EVENTS_PATH } from "@spinner/protocol";
import * as actions from "./actions.js";
import type { ActionContext } from "./actions.js";
import { EventBus } from "./event-bus.js";
import type { SpinnerHome } from "./home.js";
import { JobRunner, type JobWork } from "./jobs/jobs.js";
import { gh_runner, type GhRunner } from "./pipeline/github.js";
import { macos_notifier, type Notifier } from "./pipeline/notify.js";
import { start_poller, type Poller } from "./pipeline/poller.js";
import { list_projects } from "./projects.js";
import { parse_adopt, parse_new_session, parse_up, parse_verify } from "./requests.js";
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
    notify?: Notifier;
    /** GitHub poll interval. 0 disables the poller. */
    poll_seconds?: number;
    /** The built UI. Null means none; `GET /` then says how to build it. */
    ui_dir?: string | null;
    observe_interval_ms?: number;
}

export interface Daemon {
    /** The bound port, which differs from the requested one when 0 was asked for. */
    port: number;
    home: SpinnerHome;
    bus: EventBus;
    jobs: JobRunner;
    watcher: SessionWatcher;
    close(): Promise<void>;
}

/** What the routes need. `start_daemon` builds one; a route test builds its own. */
export interface AppDeps {
    home: SpinnerHome;
    started: string;
    log: (line: string) => void;
    ctx: ActionContext;
    jobs: JobRunner;
    view: ViewBuilder;
    /** Called after a job on `dir` finished, so the view carries fresh stack facts. */
    refresh: (dir: string) => Promise<void>;
    ui_dir: string | null;
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
        const body: HealthResponse = { ok: true, home: deps.home.root, started: deps.started };
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

    app.get("/jobs/:id", (c) => {
        const job = deps.jobs.get(c.req.param("id"));
        if (job === null) {
            return c.json(error_body(`no job ${c.req.param("id")}`), 404);
        }
        const body: JobResponse = { job };
        return c.json(body);
    });

    mount_ui(app, deps.ui_dir);
    return app;
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
    const ctx: ActionContext = { home, cwd, gh: options.gh ?? gh_runner };

    let observer: StackObserver | null = null;
    const view_ctx: ViewContext = {
        home,
        cwd,
        observation: (dir) => observer?.get(dir) ?? null,
        agents_running: () => [],
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
    observer = start_stack_observer(
        {
            sessions: () =>
                list_sessions(home).sessions.map((summary) => ({
                    summary,
                    spec: session_spec_or_null(summary),
                })),
            on_change: (dir) => publish_view(dir),
        },
        options.observe_interval_ms ?? OBSERVE_INTERVAL_MS,
    );
    const refresh = async (dir: string): Promise<void> => {
        await observer?.round();
        publish_view(dir);
    };

    const app = create_app({
        home,
        started,
        log,
        ctx,
        jobs,
        view,
        refresh,
        ui_dir: options.ui_dir === undefined ? default_ui_dir() : options.ui_dir,
    });
    const server = await listen(app, host, port);
    const address = server.address();
    assert.ok(address !== null && typeof address === "object", "server must have a TCP address");
    const bound_port = address.port;

    const sockets = attach_events_socket(server, bus, log);
    const watcher = watch_sessions(home, bus, view, { on_error: log });
    await watcher.ready;
    const poller = start_github_poller(options, ctx, log);
    log(`spinnerd listening on http://${host}:${bound_port}, home ${home.root}`);

    return {
        port: bound_port,
        home,
        bus,
        jobs,
        watcher,
        close: async () => {
            poller?.stop();
            observer?.stop();
            await watcher.close();
            for (const socket of sockets.clients) {
                socket.terminate();
            }
            sockets.close();
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
        { gh: ctx.gh, notify: options.notify ?? macos_notifier, cwd: ctx.cwd, log },
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

/**
 * Upgrades requests for `EVENTS_PATH` to WebSockets and forwards bus events to each client.
 * Any `Origin` is accepted: the UI dev server and the built UI run on different origins and
 * the daemon only listens on loopback.
 */
function attach_events_socket(
    server: Server,
    bus: EventBus,
    log: (line: string) => void,
): WebSocketServer {
    const sockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
        const path = new URL(request.url ?? "/", "http://localhost").pathname;
        if (path !== EVENTS_PATH) {
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            socket.destroy();
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
