// The routes of a tty agent (MISSION.md s009, Contracts "tty contract"). Three are the
// extension's, inside pi: `POST /sessions/:dir/agents/:name/hello` (pid and slash commands,
// at start and after a reload), `GET .../commands` (the 30 s long-poll that carries one
// `prompt`, `steer` or `abort`, acked on the next poll with `?ack=<id>&disposition=<text>`),
// and `POST .../events` (pi's lifecycle events, which reach the manager's fold unchanged).
// The fourth is the operator's: `GET .../tty` upgrades to a WebSocket on the agent's pty.
// Binary frames are the pty's bytes both ways, the one client text frame is a resize, the one
// server text frame is `exit`. Problems before the upgrade are plain HTTP: 404 for a session or
// agent that is not there or not running, 409 for an `rpc` agent or a ninth attachment.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Context, Hono } from "hono";
import { WebSocketServer, type WebSocket } from "ws";
import type {
    AgentCommandPollResponse,
    AgentCommandResponse,
    AgentEventsRequest,
    AgentHelloRequest,
    ErrorResponse,
    PiCommandInfo,
    PiEvent,
    TtyResize,
} from "@spinner/protocol";
import { TTY_ATTACHMENTS_MAX, TTY_DIMENSION_MAX } from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";
import { find_session } from "../store/session-store.js";
import type { Ack } from "./extension-channel.js";
import type { AgentManager } from "./manager.js";
import type { PiTtyHarness, TtyAgent, TtyClient } from "./tty-harness.js";

/** Upper bound on one `events` body. A `turn_end` with a long tool result stays well below. */
const EVENTS_BODY_BYTES_MAX = 8 * 1024 * 1024;

/** Upper bound on one `hello` body. */
const HELLO_BODY_BYTES_MAX = 1024 * 1024;

/** Upper bound on one keystroke frame; a paste is far smaller. */
const INPUT_FRAME_BYTES_MAX = 1024 * 1024;

export interface TtyRouteDeps {
    home: SpinnerHome;
    agents: AgentManager;
    tty: PiTtyHarness;
    log?: (line: string) => void;
}

export function mount_tty_routes(app: Hono, deps: TtyRouteDeps): void {
    app.post("/sessions/:dir/agents/:name/hello", async (c) => {
        const agent = tty_agent_of(deps, c.req.param("dir"), c.req.param("name"));
        if (typeof agent === "string") {
            return c.json(error_body(agent), 404);
        }
        const request = parse_hello(await json_body(c, HELLO_BODY_BYTES_MAX));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        agent.channel.on_hello({ pid: request.pid, commands: request.commands });
        const body: AgentCommandResponse = { ok: true };
        return c.json(body);
    });

    app.get("/sessions/:dir/agents/:name/commands", async (c) => {
        const agent = tty_agent_of(deps, c.req.param("dir"), c.req.param("name"));
        if (typeof agent === "string") {
            return c.json(error_body(agent), 404);
        }
        const ack = parse_ack(c.req.query("ack"), c.req.query("disposition"));
        if (typeof ack === "string") {
            return c.json(error_body(ack), 400);
        }
        const command = await agent.channel.poll(ack);
        if (command === null) {
            return c.body(null, 204);
        }
        const body: AgentCommandPollResponse = { command };
        return c.json(body);
    });

    app.post("/sessions/:dir/agents/:name/events", async (c) => {
        const agent = tty_agent_of(deps, c.req.param("dir"), c.req.param("name"));
        if (typeof agent === "string") {
            return c.json(error_body(agent), 404);
        }
        const request = parse_events(await json_body(c, EVENTS_BODY_BYTES_MAX));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        agent.channel.push_events(request.events);
        const body: AgentCommandResponse = { ok: true };
        return c.json(body, 202);
    });
}

export interface TtyUpgrader {
    /** True when the request was for a tty path and was answered, upgraded or refused. */
    handle(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
    /** Terminates every attached client, for daemon shutdown. */
    close(): void;
}

const TTY_PATH = /^\/sessions\/([^/]+)\/agents\/([^/]+)\/tty$/;

/**
 * The WebSocket side of `GET /sessions/:dir/agents/:name/tty`. The daemon's `upgrade` listener
 * offers every non-`/events` path here; a path that is not a tty path returns false.
 */
export function tty_upgrader(deps: TtyRouteDeps): TtyUpgrader {
    const sockets = new WebSocketServer({ noServer: true });
    const log = deps.log ?? (() => undefined);
    return {
        handle(request, socket, head) {
            const path = new URL(request.url ?? "/", "http://localhost").pathname;
            const match = TTY_PATH.exec(path);
            if (match === null) {
                return false;
            }
            const dir = decodeURIComponent(match[1] ?? "");
            const name = decodeURIComponent(match[2] ?? "");
            const agent = tty_agent_of(deps, dir, name);
            if (typeof agent === "string") {
                const status = agent.endsWith("uses the rpc harness") ? 409 : 404;
                refuse(socket, status, agent);
                return true;
            }
            if (agent.attachment_count >= TTY_ATTACHMENTS_MAX) {
                refuse(socket, 409, `${TTY_ATTACHMENTS_MAX} clients are attached to ${name}`);
                return true;
            }
            sockets.handleUpgrade(request, socket, head, (client) => {
                attach_socket(agent, client, log);
            });
            return true;
        },
        close() {
            for (const client of sockets.clients) {
                client.terminate();
            }
            sockets.close();
        },
    };
}

/** Wires one `ws` socket to the pty: scrollback and chunks down, keystrokes and resizes up. */
function attach_socket(agent: TtyAgent, client: WebSocket, log: (line: string) => void): void {
    const tty_client: TtyClient = {
        send_bytes: (chunk) => {
            if (client.readyState === client.OPEN) {
                client.send(chunk, { binary: true });
            }
        },
        send_text: (text) => {
            if (client.readyState === client.OPEN) {
                client.send(text);
            }
        },
        close: (code, reason) => client.close(code, reason),
    };
    const detach = agent.attach(tty_client);
    client.on("message", (data, is_binary) => {
        const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(as_buffers(data));
        if (is_binary) {
            if (bytes.length > INPUT_FRAME_BYTES_MAX) {
                client.close(1009, "input frame too large");
                return;
            }
            agent.write(bytes);
            return;
        }
        const resize = parse_resize(bytes.toString("utf8"));
        if (resize === null) {
            client.close(1008, "the only text frame is a resize");
            return;
        }
        agent.resize(resize);
    });
    client.on("close", detach);
    client.on("error", (error) => {
        log(`tty ${agent.name}: ws client error: ${error.message}`);
        detach();
    });
}

/**
 * The running tty agent of `dir/name`, or the reason there is none. The reason tells an
 * `rpc` agent from a missing one, so the upgrade can answer 409 rather than 404.
 */
function tty_agent_of(deps: TtyRouteDeps, dir: string, name: string): TtyAgent | string {
    const summary = find_session(deps.home, dir);
    if (summary === null) {
        return `no session ${dir}`;
    }
    const agent = deps.tty.lookup(summary.dir, name);
    if (agent !== null) {
        return agent;
    }
    if (deps.agents.get(summary.dir, name) !== null) {
        return `agent ${name} uses the rpc harness`;
    }
    return `agent ${name} is not running in ${summary.dir}`;
}

function refuse(socket: Duplex, status: 404 | 409, reason: string): void {
    const text = status === 404 ? "Not Found" : "Conflict";
    const body = JSON.stringify(error_body(reason));
    socket.write(
        `HTTP/1.1 ${status} ${text}\r\ncontent-type: application/json\r\n` +
            `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
    );
    socket.destroy();
}

/** `{"resize":{"cols":n,"rows":n}}` with both in 1..`TTY_DIMENSION_MAX`, else null. */
export function parse_resize(text: string): TtyResize | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    const record = as_record(parsed);
    if (typeof record === "string") {
        return null;
    }
    const resize = as_record(record["resize"]);
    if (typeof resize === "string") {
        return null;
    }
    const cols = resize["cols"];
    const rows = resize["rows"];
    if (!is_dimension(cols) || !is_dimension(rows)) {
        return null;
    }
    return { cols, rows };
}

function is_dimension(value: unknown): value is number {
    return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= TTY_DIMENSION_MAX
    );
}

export function parse_hello(input: unknown): AgentHelloRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const pid = record["pid"];
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
        return "`pid` must be a positive integer";
    }
    const commands = record["commands"];
    if (!Array.isArray(commands)) {
        return "`commands` must be an array";
    }
    for (const command of commands) {
        const entry = as_record(command);
        if (typeof entry === "string" || typeof entry["name"] !== "string") {
            return "each command needs a `name`";
        }
    }
    return { pid, commands: commands as PiCommandInfo[] };
}

export function parse_events(input: unknown): AgentEventsRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const events = record["events"];
    if (!Array.isArray(events)) {
        return "`events` must be an array";
    }
    for (const event of events) {
        const entry = as_record(event);
        if (typeof entry === "string" || typeof entry["type"] !== "string") {
            return "each event needs a `type`";
        }
    }
    return { events: events as PiEvent[] };
}

/** Both absent is no ack; both present is one; one without the other is a 400. */
export function parse_ack(
    id: string | undefined,
    disposition: string | undefined,
): Ack | null | string {
    if (id === undefined && disposition === undefined) {
        return null;
    }
    if (id === undefined || id.length === 0) {
        return "`ack` must name the command when `disposition` is given";
    }
    if (disposition === undefined || disposition.length === 0) {
        return "`disposition` must be given with `ack`";
    }
    return { id, disposition };
}

function as_buffers(data: WebSocket.RawData): Buffer[] {
    if (Array.isArray(data)) {
        return data;
    }
    return [Buffer.from(data as ArrayBuffer)];
}

function as_record(input: unknown): Record<string, unknown> | string {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return "request body must be a JSON object";
    }
    return input as Record<string, unknown>;
}

async function json_body(c: Context, bytes_max: number): Promise<unknown> {
    const text = await c.req.text();
    if (text.length > bytes_max) {
        return null;
    }
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
