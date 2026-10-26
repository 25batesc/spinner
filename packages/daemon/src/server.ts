// The HTTP and WebSocket surface of spinnerd. Routes are the ones listed in
// `@spinner/protocol` `ROUTES`; the WebSocket at `EVENTS_PATH` forwards every bus event as one
// JSON message. The server binds to loopback only and has no authentication (v1, single user).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { WebSocketServer, type WebSocket } from "ws";
import type {
    ErrorResponse,
    HealthResponse,
    NewSessionRequest,
    SessionResponse,
    SessionsResponse,
} from "@spinner/protocol";
import { DAEMON_HOST, DAEMON_PORT, EVENTS_PATH } from "@spinner/protocol";
import { EventBus } from "./event-bus.js";
import type { SpinnerHome } from "./home.js";
import { create_session, list_sessions, read_session } from "./store/session-store.js";
import { watch_sessions, type SessionWatcher } from "./watcher.js";

export interface DaemonOptions {
    home: SpinnerHome;
    /** TCP port. 0 asks the OS for a free port, which tests use. */
    port?: number;
    host?: string;
    /** Logger for one-line notices. Defaults to console.error so stdout stays clean. */
    log?: (line: string) => void;
}

export interface Daemon {
    /** The bound port, which differs from the requested one when 0 was asked for. */
    port: number;
    home: SpinnerHome;
    bus: EventBus;
    watcher: SessionWatcher;
    close(): Promise<void>;
}

/** Builds the Hono app alone, without sockets, so route tests can call `app.request()`. */
export function create_app(home: SpinnerHome, started: string): Hono {
    const app = new Hono();
    // The Vite dev server proxies REST calls, but a built UI served from another origin or a
    // curl from a browser extension still benefits from permissive CORS on a loopback daemon.
    app.use("*", cors());

    app.get("/health", (c) => {
        const body: HealthResponse = { ok: true, home: home.root, started };
        return c.json(body);
    });

    app.get("/sessions", (c) => {
        const result = list_sessions(home);
        const body: SessionsResponse = { sessions: result.sessions };
        return c.json(body);
    });

    app.post("/sessions", async (c) => {
        let input: unknown;
        try {
            input = await c.req.json();
        } catch {
            return c.json(error_body("request body must be JSON"), 400);
        }
        const request = parse_new_session(input);
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        try {
            const summary = create_session(home, request);
            const body: SessionResponse = { session: summary };
            return c.json(body, 201);
        } catch (error) {
            return c.json(error_body(describe_error(error)), 409);
        }
    });

    app.get("/sessions/:dir", (c) => {
        const read = read_session(home, c.req.param("dir"));
        if (!read.ok) {
            return c.json(error_body(read.error), 404);
        }
        const body: SessionResponse = { session: read.summary };
        return c.json(body);
    });

    app.get("/sessions/:dir/mission", (c) => {
        const file = join(home.sessions, c.req.param("dir"), "MISSION.md");
        if (!existsSync(file)) {
            return c.json(error_body(`${file} does not exist`), 404);
        }
        return c.body(readFileSync(file, "utf8"), 200, { "content-type": "text/markdown" });
    });

    return app;
}

/** Starts the HTTP server, the WebSocket endpoint and the session watcher. */
export async function start_daemon(options: DaemonOptions): Promise<Daemon> {
    const port = options.port ?? DAEMON_PORT;
    const host = options.host ?? DAEMON_HOST;
    const log = options.log ?? ((line) => console.error(line));
    assert.ok(port >= 0 && port <= 65535, `port ${port} out of range`);

    const started = new Date().toISOString();
    const bus = new EventBus();
    const app = create_app(options.home, started);

    const server = await listen(app, host, port);
    const address = server.address();
    assert.ok(address !== null && typeof address === "object", "server must have a TCP address");
    const bound_port = address.port;

    const sockets = attach_events_socket(server, bus, log);
    const watcher = watch_sessions(options.home, bus, { on_error: log });
    await watcher.ready;
    log(`spinnerd listening on http://${host}:${bound_port}, home ${options.home.root}`);

    return {
        port: bound_port,
        home: options.home,
        bus,
        watcher,
        close: async () => {
            await watcher.close();
            for (const socket of sockets.clients) {
                socket.terminate();
            }
            sockets.close();
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        },
    };
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

function parse_new_session(input: unknown): NewSessionRequest | string {
    if (typeof input !== "object" || input === null) {
        return "request body must be an object";
    }
    const record = input as Record<string, unknown>;
    const title = record["title"];
    if (typeof title !== "string" || title.trim().length === 0) {
        return "`title` must be a non-empty string";
    }
    const slug = record["slug"];
    if (slug === undefined) {
        return { title };
    }
    if (typeof slug !== "string" || slug.length === 0) {
        return "`slug` must be a non-empty string when given";
    }
    return { title, slug };
}

function error_body(error: string): ErrorResponse {
    return { error };
}

function describe_error(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
