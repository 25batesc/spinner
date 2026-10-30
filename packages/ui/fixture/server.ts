// Stands in for the daemon in UI tests. It serves the API v1 routes from `@spinner/protocol`
// that the UI calls, keeps the sessions in memory, runs each action as a job with scripted log
// lines, and broadcasts the same events the daemon does. It listens on the daemon's port, so
// run either this or the daemon, not both. Start it with `pnpm --filter ui fixture`.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
    DAEMON_HOST,
    EVENTS_PATH,
    type Job,
    type JobAction,
    type PiAssistantMessage,
    type PiEvent,
    type SessionView,
    type SpinnerEvent,
    type StackUsage,
    type UsageResponse,
} from "@spinner/protocol";
import { WebSocketServer, type WebSocket } from "ws";

import { PipelineFixture } from "./pipeline.ts";
import {
    FIXTURE_PORT, initialSessions, machineUsage, PROJECTS, pr, session, stackView, view,
} from "./data.ts";
import { EchoPty } from "./tty.ts";

export const TTY_ROUTE = /^\/sessions\/([^/]+)\/agents\/([^/]+)\/tty$/;

export const STEP_DELAY_MS = 300;
/** The fixture samples faster than the daemon (5 s), so a driver sees an update soon. */
export const USAGE_TICK_MS = 2000;

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
}

/** Stands in for a session's stack: any other path is a page that names the host. */
function sendPreview(request: IncomingMessage, response: ServerResponse): void {
    const host = (request.headers.host ?? "unknown host").replace(/[<>&]/g, "");
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<h1>Fixture preview</h1><p>${host}</p>`);
}

const USAGE = {
    input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};

/** The events pi sends for one prompt: a user message, a streamed answer and one tool call. */
export function replyScript(prompt: string): PiEvent[] {
    const answer: PiAssistantMessage = {
        role: "assistant", content: [{ type: "text", text: `Done: ${prompt}` }],
        api: "fixture", provider: "fixture", model: "fixture", usage: USAGE,
        stopReason: "stop", timestamp: 0,
    };
    const user = { role: "user" as const, content: prompt, timestamp: 0 };
    const delta = (text: string): PiEvent => ({
        type: "message_update", usage: USAGE,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
    });
    return [
        { type: "agent_start" },
        { type: "message_start", message: user },
        { type: "message_end", message: user },
        { type: "message_start", message: { ...answer, content: [] } },
        delta("Done: "),
        { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: "ls" },
        {
            type: "tool_execution_end", toolCallId: "t1", toolName: "bash",
            result: "README.md", isError: false,
        },
        delta(prompt),
        { type: "message_end", message: answer },
        { type: "agent_settled", aborted: false },
    ];
}

const bodies = new WeakMap<IncomingMessage, Record<string, unknown>>();

/** Reads the JSON body once; a second call for the same request returns the same object. */
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const known = bodies.get(request);
    if (known !== undefined) {
        return known;
    }
    const body = await parseBody(request);
    bodies.set(request, body);
    return body;
}

async function parseBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString();
    return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FixtureDaemon {
    sessions = new Map<string, SessionView>();
    jobs = new Map<string, Job>();
    sockets = new Set<WebSocket>();
    counter = 0;
    /** `message_end` events per `<dir>/<agent>`, what `GET .../events` returns. */
    history = new Map<string, PiEvent[]>();
    /** One fake pty per `<dir>/<agent>` that a terminal attached to; it outlives the socket. */
    ptys = new Map<string, EchoPty>();
    /** How many samples went out; each one moves the numbers a little. */
    ticks = 0;

    pipeline = new PipelineFixture(this);

    constructor() {
        for (const item of initialSessions()) {
            this.sessions.set(item.summary.dir, item);
        }
    }

    /** The pty of a running agent, made on the first attach; null when the agent is not running. */
    pty(dir: string, name: string): EchoPty | null {
        const current = this.sessions.get(dir);
        if (current === undefined || !current.agents_running.includes(name)) {
            return null;
        }
        const key = `${dir}/${name}`;
        const known = this.ptys.get(key);
        if (known !== undefined) {
            return known;
        }
        const made = new EchoPty(name);
        this.ptys.set(key, made);
        return made;
    }

    /** `GET /usage` and the `usage` event: each up stack's sum, nudged per tick; the machine. */
    usage(): UsageResponse {
        const sessions: Record<string, StackUsage> = {};
        let total = 0;
        for (const current of this.sessions.values()) {
            const base = current.stack.usage;
            if (current.stack.state !== "up" || base === null || base === undefined) {
                continue;
            }
            const wobble = (this.ticks % 4) * 8 * 1024 * 1024;
            const stack = {
                cpu_pct: base.cpu_pct + (this.ticks % 3), mem_bytes: base.mem_bytes + wobble,
                sampled: new Date().toISOString(),
            };
            sessions[current.summary.dir] = stack;
            total += stack.mem_bytes;
        }
        const up = Object.keys(sessions).length;
        return {
            machine: machineUsage(up, total), sessions, sampled: new Date().toISOString(),
        };
    }

    tick(): void {
        this.ticks += 1;
        const { machine, sessions } = this.usage();
        const ts = new Date().toISOString();
        this.emit({ type: "usage", ts, session: null, machine, sessions });
    }

    emit(event: SpinnerEvent): void {
        for (const socket of this.sockets) {
            socket.send(JSON.stringify(event));
        }
    }

    update(next: SessionView): void {
        const dir = next.summary.dir;
        const known = this.sessions.has(dir);
        this.sessions.set(dir, next);
        const ts = new Date().toISOString();
        const type = known ? "session.updated" : "session.created";
        this.emit({ type, ts, session: dir, data: next });
    }

    start(
        action: JobAction,
        dir: string | null,
        work: (log: (line: string) => void) => Promise<string | null>,
    ): Job {
        this.counter += 1;
        const job: Job = {
            id: `j-${this.counter}`, action, session: dir, state: "running",
            started: new Date().toISOString(), finished: null, log: [], error: null,
        };
        this.jobs.set(job.id, job);
        const event = () => ({ ts: new Date().toISOString(), session: job.session, job: job.id });
        this.emit({ type: "job.started", ...event(), data: { ...job } });
        const log = (line: string) => {
            job.log.push(line);
            this.emit({ type: "job.log", ...event(), line });
        };
        void work(log).then((created) => {
            job.session = created ?? job.session;
            job.state = "ok";
            job.finished = new Date().toISOString();
            this.emit({ type: "job.finished", ...event(), ok: true, data: { ...job } });
        });
        return job;
    }

    async run(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
        const body = await readBody(request);
        if (path === "/sessions") {
            const title = String(body["title"] ?? "untitled");
            return this.accepted(response, this.create("new", title, [], body["project"]));
        }
        if (path === "/sessions/adopt") {
            const urls = (body["urls"] as string[] | undefined) ?? [];
            const title = String(body["title"] ?? "Adopted");
            return this.accepted(response, this.create("adopt", title, urls, body["project"]));
        }
        if (await this.agentRoute(response, path, body)) {
            return true;
        }
        const match = /^\/sessions\/([^/]+)\/(up|down|close|verify)$/.exec(path);
        const current = match === null ? undefined : this.sessions.get(match[1] ?? "");
        if (match === null || current === undefined) {
            return false;
        }
        const action = match[2] as "up" | "down" | "close" | "verify";
        return this.accepted(response, this.act(action, current));
    }

    /** `POST /sessions/:dir/agents` and `.../agents/:name/{prompt,steer,abort,stop}`. */
    async agentRoute(
        response: ServerResponse,
        path: string,
        body: Record<string, unknown>,
    ): Promise<boolean> {
        const route = /^\/sessions\/([^/]+)\/agents(?:\/([^/]+)\/(prompt|steer|abort|stop))?$/;
        const match = route.exec(path);
        const current = this.sessions.get(match?.[1] ?? "");
        if (match === null || current === undefined) {
            return false;
        }
        const dir = current.summary.dir;
        const name = match[2] ?? String(body["name"]);
        const emit = (event: PiEvent) => {
            const ts = new Date().toISOString();
            if (event.type === "message_end") {
                const key = `${dir}/${name}`;
                this.history.set(key, [...(this.history.get(key) ?? []), event]);
            }
            this.emit({ type: "agent.event", ts, session: dir, agent: name, event });
        };
        if (match[3] === undefined) {
            const base = current.summary.session;
            const agents = {
                ...base.agents,
                [name]: {
                    harness: "tty" as const,
                    model: String(body["model"] ?? "fixture/default"),
                    process: "idle" as const,
                },
            };
            const summary = { ...current.summary, session: { ...base, agents } };
            const next = { ...current, summary, agents_running: [...current.agents_running, name] };
            this.update(next);
            sendJson(response, { name, pi_session_id: "pi-1" }, 201);
        } else if (!current.agents_running.includes(name)) {
            const process = current.summary.session.agents[name]?.process ?? "exited";
            sendJson(response, { error: `agent ${name} is not running`, process }, 409);
        } else if (match[3] === "prompt") {
            const script = replyScript(String(body["text"]));
            script.forEach((event, index) => setTimeout(() => emit(event), index * STEP_DELAY_MS));
            sendJson(response, { ok: true, disposition: "started" });
        } else if (match[3] === "stop") {
            // As the daemon: the pty's clients get the exit frame and close 1000, the agent
            // leaves `agents_running` and its process reads `idle`.
            this.ptys.get(`${dir}/${name}`)?.exit(0);
            this.ptys.delete(`${dir}/${name}`);
            const base = current.summary.session;
            const spec = base.agents[name];
            const agents = spec === undefined ? base.agents : {
                ...base.agents, [name]: { ...spec, process: "idle" as const },
            };
            const summary = { ...current.summary, session: { ...base, agents } };
            const running = current.agents_running.filter((item) => item !== name);
            this.update({ ...current, summary, agents_running: running });
            sendJson(response, { ok: true });
        } else {
            if (match[3] === "abort") {
                emit({ type: "agent_settled", aborted: true });
            }
            sendJson(response, { ok: true });
        }
        return true;
    }

    accepted(response: ServerResponse, job: Job): true {
        sendJson(response, { job }, 202);
        return true;
    }

    create(action: "new" | "adopt", title: string, urls: string[], project: unknown): Job {
        return this.start(action, null, async (log) => {
            const id = `s${100 + this.counter}`;
            const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
            const dir = `${id}-${slug}`;
            log(`creating ${dir}`);
            await sleep(STEP_DELAY_MS);
            const prs = urls.map((_, index) => pr(500 + index, "web"));
            const base = session({
                id, slug, title, created: new Date().toISOString(),
                stage: urls.length > 0 ? "peer-review" : "planned",
                ...(typeof project === "string" ? { project } : {}),
            });
            const stack = stackView(id, typeof project === "string" ? "down" : "none");
            this.update(view(dir, base, stack, prs));
            log("session ready");
            return dir;
        });
    }

    act(action: "up" | "down" | "close" | "verify", current: SessionView): Job {
        const dir = current.summary.dir;
        const base = current.summary.session;
        const keep = { prs: current.board?.prs ?? [], agents: current.agents_running };
        const put = (next: typeof base, state: "up" | "down" | "starting") =>
            this.update(view(dir, next, stackView(base.id, state), keep.prs, keep.agents));
        return this.start(action, dir, async (log) => {
            log(`${action} ${dir}`);
            await sleep(STEP_DELAY_MS);
            if (action === "up") {
                put(base, "starting");
                log("starting services");
                await sleep(STEP_DELAY_MS * 3);
                put(base, "up");
                log("all services healthy");
            } else if (action === "down") {
                put(base, "down");
            } else if (action === "verify") {
                const pipeline = {
                    ...base.pipeline,
                    slack_post: null,
                    verified_locally: true,
                    verified_by: "operator",
                    verified_at: new Date().toISOString(),
                };
                put({ ...base, pipeline }, current.stack.state === "up" ? "up" : "down");
                log("verified");
            } else {
                this.sessions.delete(dir);
                this.emit({ type: "session.closed", ts: new Date().toISOString(), session: dir });
                log("session archived");
            }
            return null;
        });
    }

    /** Mission, threads, previews, pipeline jobs and context files (see `pipeline.ts`). */
    async m2(
        request: IncomingMessage, response: ServerResponse, method: string, path: string,
    ): Promise<boolean> {
        const write = method === "POST" || method === "PUT";
        const body = write ? await readBody(request) : {};
        return this.pipeline.handle(method, path, body, response);
    }

    async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const path = (request.url ?? "/").split("?")[0] ?? "/";
        const method = request.method ?? "GET";
        if (await this.m2(request, response, method, path)) {
            return;
        }
        const dir = /^\/sessions\/([^/]+)$/.exec(path)?.[1];
        const jobId = /^\/jobs\/([^/]+)$/.exec(path)?.[1];
        if (method === "GET" && path === "/sessions") {
            sendJson(response, { sessions: [...this.sessions.values()] });
        } else if (method === "GET" && dir !== undefined && this.sessions.has(dir)) {
            sendJson(response, { session: this.sessions.get(dir) });
        } else if (method === "GET" && /\/agents\/[^/]+\/events$/.test(path)) {
            const parts = path.split("/");
            const events = this.history.get(`${parts[2]}/${parts[4]}`) ?? [];
            sendJson(response, { events });
        } else if (method === "GET" && path === "/models") {
            const models = [
                { provider: "fixture", id: "small", contextWindow: 1000, reasoning: false },
            ];
            sendJson(response, { models });
        } else if (method === "GET" && path === "/projects") {
            sendJson(response, { projects: PROJECTS });
        } else if (method === "GET" && path === "/jobs") {
            sendJson(response, { jobs: [...this.jobs.values()] });
        } else if (method === "GET" && jobId !== undefined && this.jobs.has(jobId)) {
            sendJson(response, { job: this.jobs.get(jobId) });
        } else if (method === "GET" && path === "/usage") {
            sendJson(response, this.usage());
        } else if (method === "GET" && path === "/health") {
            sendJson(response, { ok: true, home: "fixture", started: new Date().toISOString() });
        } else if (method === "POST" && (await this.run(request, response, path))) {
            return;
        } else if (method === "POST") {
            sendJson(response, { error: `no route ${path}` }, 404);
        } else {
            sendPreview(request, response);
        }
    }
}

export function startFixture(port: number = FIXTURE_PORT) {
    const daemon = new FixtureDaemon();
    const sampler = setInterval(() => daemon.tick(), USAGE_TICK_MS);
    sampler.unref();
    const server = createServer((request, response) => {
        daemon
            .handle(request, response)
            .catch((error: unknown) => sendJson(response, { error: String(error) }, 500));
    });
    const sockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
        const path = (request.url ?? "").split("?")[0] ?? "";
        const tty = TTY_ROUTE.exec(path);
        if (tty !== null) {
            const pty = daemon.pty(tty[1] ?? "", tty[2] ?? "");
            if (pty === null) {
                // As the daemon: a plain 404 before the upgrade when the agent is not running.
                socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
                return;
            }
            sockets.handleUpgrade(request, socket, head, (ws) => pty.attach(ws));
            return;
        }
        if (request.url !== EVENTS_PATH) {
            socket.destroy();
            return;
        }
        sockets.handleUpgrade(request, socket, head, (ws) => {
            daemon.sockets.add(ws);
            ws.on("close", () => daemon.sockets.delete(ws));
        });
    });
    server.listen(port, DAEMON_HOST);
    // The daemon rides along for tests that reach past HTTP, for example to drop a pty's clients.
    return Object.assign(server, { daemon });
}

if (import.meta.url === `file://${process.argv[1]}`) {
    startFixture();
    console.log(`Fixture daemon on http://localhost:${FIXTURE_PORT} (events at ${EVENTS_PATH})`);
}
