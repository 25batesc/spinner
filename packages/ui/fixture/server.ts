// Stands in for the daemon until it is ready. It serves the routes from `@spinner/protocol` that
// the UI reads and replays canned events on the events socket. It listens on the daemon's port,
// so run either this or the daemon, not both. Start it with `pnpm --filter ui fixture`.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { DAEMON_HOST, EVENTS_PATH, type ROUTES, type SessionsResponse } from "@spinner/protocol";
import { WebSocketServer, type WebSocket } from "ws";

import { buildScript, FIXTURE_PORT, SESSIONS } from "./data.ts";

export const REPLAY_INTERVAL_MS = 1500;

/** `"GET /sessions"` becomes `"/sessions"`. */
function pathOf(route: keyof typeof ROUTES): string {
    const space = route.indexOf(" ");
    if (space < 0) {
        throw new Error(`Route without a method: ${route}`);
    }
    return route.slice(space + 1);
}

function sendJson(response: ServerResponse, body: unknown): void {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
}

/** Stands in for a session's stack: any other path is a page that names the host. */
function sendPreview(request: IncomingMessage, response: ServerResponse): void {
    const host = request.headers.host ?? "unknown host";
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<h1>Fixture preview</h1><p>${host.replace(/[<>&]/g, "")}</p>`);
}

function handle(request: IncomingMessage, response: ServerResponse): void {
    const path = (request.url ?? "/").split("?")[0];
    if (request.method === "GET" && path === pathOf("GET /sessions")) {
        const body: SessionsResponse = { sessions: SESSIONS };
        sendJson(response, body);
    } else if (request.method === "GET" && path === pathOf("GET /health")) {
        sendJson(response, { ok: true, home: "fixture", started: new Date().toISOString() });
    } else {
        sendPreview(request, response);
    }
}

function replay(socket: WebSocket): void {
    const script = buildScript();
    let next = 0;
    const timer = setInterval(() => {
        const event = script[next];
        if (event === undefined || socket.readyState !== socket.OPEN) {
            clearInterval(timer);
            return;
        }
        socket.send(JSON.stringify(event));
        next += 1;
    }, REPLAY_INTERVAL_MS);
    socket.on("close", () => clearInterval(timer));
}

export function startFixture(port: number = FIXTURE_PORT) {
    const server = createServer(handle);
    const sockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
        if (request.url !== EVENTS_PATH) {
            socket.destroy();
            return;
        }
        sockets.handleUpgrade(request, socket, head, replay);
    });
    server.listen(port, DAEMON_HOST);
    return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    startFixture();
    console.log(`Fixture daemon on http://localhost:${FIXTURE_PORT} (events at ${EVENTS_PATH})`);
}
