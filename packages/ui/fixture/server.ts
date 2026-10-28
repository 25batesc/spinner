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
    type SessionView,
    type SpinnerEvent,
} from "@spinner/protocol";
import { WebSocketServer, type WebSocket } from "ws";

import { FIXTURE_PORT, initialSessions, PROJECTS, pr, session, stackView, view } from "./data.ts";

export const STEP_DELAY_MS = 300;

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

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
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

    constructor() {
        for (const item of initialSessions()) {
            this.sessions.set(item.summary.dir, item);
        }
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
        const match = /^\/sessions\/([^/]+)\/(up|down|close|verify)$/.exec(path);
        const current = match === null ? undefined : this.sessions.get(match[1] ?? "");
        if (match === null || current === undefined) {
            return false;
        }
        const action = match[2] as "up" | "down" | "close" | "verify";
        return this.accepted(response, this.act(action, current));
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

    async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const path = (request.url ?? "/").split("?")[0] ?? "/";
        const method = request.method ?? "GET";
        const dir = /^\/sessions\/([^/]+)$/.exec(path)?.[1];
        const jobId = /^\/jobs\/([^/]+)$/.exec(path)?.[1];
        if (method === "GET" && path === "/sessions") {
            sendJson(response, { sessions: [...this.sessions.values()] });
        } else if (method === "GET" && dir !== undefined && this.sessions.has(dir)) {
            sendJson(response, { session: this.sessions.get(dir) });
        } else if (method === "GET" && path === "/projects") {
            sendJson(response, { projects: PROJECTS });
        } else if (method === "GET" && path === "/jobs") {
            sendJson(response, { jobs: [...this.jobs.values()] });
        } else if (method === "GET" && jobId !== undefined && this.jobs.has(jobId)) {
            sendJson(response, { job: this.jobs.get(jobId) });
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
    const server = createServer((request, response) => {
        daemon
            .handle(request, response)
            .catch((error: unknown) => sendJson(response, { error: String(error) }, 500));
    });
    const sockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
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
    return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    startFixture();
    console.log(`Fixture daemon on http://localhost:${FIXTURE_PORT} (events at ${EVENTS_PATH})`);
}
