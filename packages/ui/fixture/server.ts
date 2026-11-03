// Stands in for the daemon in UI tests. It serves the API v1 routes from `@spinner/protocol`
// that the UI calls, keeps the sessions in memory, runs each action as a job with scripted log
// lines, and broadcasts the same events the daemon does. It listens on its own port (`port.ts`,
// `17777`), not the daemon's, so a driver with `SPINNER_PORT` unset never reaches the operator's
// daemon; `SPINNER_PORT` moves it. Start it with `pnpm --filter ui fixture`.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
    BUILTIN_THEMES,
    DAEMON_HOST,
    EVENTS_PATH,
    type ExtractResponse,
    SESSION_TITLE_MAX,
    SETTINGS_DEFAULT,
    THEME_SYSTEM,
    validate_palette,
    type Job,
    OPERATOR_TTY_PATH,
    type JobAction,
    type OperatorView,
    type PiAssistantMessage,
    type PiEvent,
    type SessionView,
    type ServiceUsage,
    type SessionUsage,
    type Settings,
    type SettingsResponse,
    type SpinnerEvent,
    type ThemesResponse,
    type UsageResponse,
} from "@spinner/protocol";
import { WebSocketServer, type WebSocket } from "ws";

import { costsReport, OPERATOR_COST } from "./costs.ts";
import { DESIGN_ROUTE, DesignFixture } from "./design.ts";
import { extract } from "./extract.ts";
import { handleGoldfish } from "./goldfish.ts";
import { PipelineFixture } from "./pipeline.ts";
import {
    FIXTURE_PORT, designView, diffRepoStopped, diffViewerUrl, egmStatus, initialDesignSessions,
    initialReviews, initialSessions, machineUsage, PROJECTS, pr, session, stackView, view,
} from "./data.ts";
import { ReviewFixture } from "./reviews.ts";
import type { DiffRepoView, DiffView } from "@spinner/protocol";
import { EchoPty } from "./tty.ts";

export const TTY_ROUTE = /^\/sessions\/([^/]+)\/agents\/([^/]+)\/tty$/;

/** The operator agent at the fixture's start: hosted, idle, one notice behind it. */
export function initialOperator(): OperatorView {
    return {
        enabled: true,
        ready: true,
        process: "idle",
        pid: 4242,
        model: "fixture/default",
        dir: "/home/fixture/.spinner/operator",
        waiting_on: "operator",
        last_notice: {
            ts: "2026-10-30T22:20:00.000Z",
            text: "s17-refund-flow: needs_human set: Approve the refund copy in PR #412",
        },
        notices_pending: 0,
        cost: OPERATOR_COST,
    };
}

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

export const DIFF_VIEWER_ROUTE = /^\/diffview\/([^/]+)\/(keys)?$/;

/**
 * Stands in for a `diffview` page: it names the repo and records every key pressed in it,
 * so a driver can check that the viewer's keys reach the frame. `POST .../keys` is what the
 * page sends; `GET .../keys` is what the driver reads.
 */
function sendDiffViewer(repo: string, response: ServerResponse): void {
    const safe = repo.replace(/[<>&]/g, "");
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>diffview ${safe}</title>
<h1>Fixture diff viewer</h1><p>repo ${safe}</p><pre id="keys"></pre>
<script>
document.addEventListener("keydown", (event) => {
    document.getElementById("keys").textContent += event.key + " ";
    fetch("keys", { method: "POST", body: JSON.stringify({ key: event.key }) });
});
</script>`);
}

/** Every repo's viewer at rest; the fetch state stays. */
function diffStopped(diff: DiffView | undefined): DiffView | undefined {
    if (diff === undefined) {
        return undefined;
    }
    const repos = Object.fromEntries(Object.keys(diff.repos).map((r) => [r, diffRepoStopped()]));
    return { ...diff, repos };
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

/**
 * The title of a session started from a paste, as the daemon derives it: the first non-empty
 * line of the text without its PR references, cut to `SESSION_TITLE_MAX`; else the first
 * adopted PR's title; else `New session`.
 */
export function provisionalTitle(found: ExtractResponse, adopt: readonly string[]): string {
    const line = found.rest.split("\n").map((item) => item.trim()).find((item) => item !== "");
    if (line !== undefined) {
        return line.slice(0, SESSION_TITLE_MAX);
    }
    const first = found.prs.find((pr) => pr.url !== null && adopt.includes(pr.url));
    return first?.title ?? "New session";
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
    /** The operator's settings, as `~/.spinner/settings.yaml` would hold them. */
    /** The operator agent is on in the fixture, so the `operator` flow has one to drive. */
    settings: Settings = { ...SETTINGS_DEFAULT, operator: { enabled: true } };
    /** The operator agent, `GET /operator`; its pty is made on the first attach. */
    operator: OperatorView = initialOperator();
    operatorPty: EchoPty | null = null;
    /** `GET /egm`: ready at the pin; `POST /egm/fetch` passes `fetching` and is ready again. */
    egm = egmStatus();

    pipeline = new PipelineFixture(this);
    /** The review routes (s015, s016): `POST /reviews`, the swarm, the lead's draft routes. */
    reviews = new ReviewFixture(this);
    /** The design routes (entry 3.24): the gate, the answer, the skill runs. */
    design = new DesignFixture(this);
    /** The keys each fake viewer page received, per repo (`DIFF_VIEWER_ROUTE`). */
    diffKeys = new Map<string, string[]>();
    /** The port the server listens on, set once it does: the fake viewer URLs name it. */
    port = FIXTURE_PORT;

    constructor() {
        const seeds = [...initialSessions(), ...initialDesignSessions(), ...initialReviews()];
        for (const item of seeds) {
            this.sessions.set(item.summary.dir, item);
            if (item.review !== undefined && "briefing" in item.review) {
                this.reviews.seedBriefing(item.summary.dir);
            }
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

    /** The operator agent's pty, as `pty()` for an agent: null while it is not running. */
    operatorTty(): EchoPty | null {
        if (this.operator.process === "exited") {
            return null;
        }
        this.operatorPty ??= new EchoPty("operator");
        return this.operatorPty;
    }

    /**
     * `POST /operator/start` and `/operator/stop`, as the daemon: the new view answers at
     * once and `operator.updated` carries it; 409 when the agent is already in that state. A
     * stop sends the pty's exit frame and closes its clients; a start hosts the agent again
     * with a fresh pty, so a resumed terminal sees a new banner.
     */
    operatorRoute(response: ServerResponse, path: string): boolean {
        const running = this.operator.process !== "exited";
        if (path === "/operator/stop" && running) {
            this.operatorPty?.exit(0);
            this.operatorPty = null;
            this.operator = { ...this.operator, process: "exited", pid: null, waiting_on: "start" };
        } else if (path === "/operator/start" && !running) {
            this.operator = {
                ...this.operator, process: "idle", pid: 4243, waiting_on: "operator",
            };
        } else if (path === "/operator/stop" || path === "/operator/start") {
            const state = running ? "already runs" : "does not run";
            sendJson(response, { error: `the operator agent ${state}` }, 409);
            return true;
        } else {
            return false;
        }
        const ts = new Date().toISOString();
        this.emit({ type: "operator.updated", ts, session: null, data: this.operator });
        sendJson(response, { operator: this.operator });
        return true;
    }

    /**
     * `GET /usage` and the `usage` event: each up session's stack total and services, nudged
     * per tick (the cpu by a whole percent, the memory by a few MB); the machine.
     */
    usage(): UsageResponse {
        const sessions: Record<string, SessionUsage> = {};
        let total = 0;
        for (const current of this.sessions.values()) {
            const base = current.stack.usage;
            if (current.stack.state !== "up" || base === null || base === undefined) {
                continue;
            }
            const nudge = this.ticks % 3;
            const wobble = (this.ticks % 4) * 8 * 1024 * 1024;
            const stack = {
                cpu_pct: base.cpu_pct + nudge, mem_bytes: base.mem_bytes + wobble,
                sampled: new Date().toISOString(),
            };
            const services: Record<string, ServiceUsage> = {};
            for (const service of current.stack.services) {
                if (service.usage !== null && service.usage !== undefined) {
                    services[service.name] = {
                        ...service.usage, cpu_pct: service.usage.cpu_pct + nudge,
                    };
                }
            }
            sessions[current.summary.dir] = { stack, services };
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

    /**
     * `GET /themes`: the two built-ins, one valid custom theme (`solar`, the dark palette
     * with a warm accent) and one invalid file (`broken`, the terminal block short of `red`).
     */
    themes(): ThemesResponse {
        const solar = {
            ...BUILTIN_THEMES.dark, accent: "#e0a63a", link: "#f2c14e",
            terminal: { ...BUILTIN_THEMES.dark.terminal, blue: "#e0a63a" },
        };
        const short: Record<string, string> = { ...BUILTIN_THEMES.dark.terminal };
        delete short["red"];
        const broken = validate_palette({ ...BUILTIN_THEMES.dark, terminal: short });
        return {
            themes: [
                { name: "light", source: "builtin", palette: BUILTIN_THEMES.light },
                { name: "dark", source: "builtin", palette: BUILTIN_THEMES.dark },
                { name: "rainbow", source: "builtin", palette: BUILTIN_THEMES.rainbow },
                { name: "solar", source: "user", palette: solar },
            ],
            invalid: broken.ok ? [] : [{
                name: "broken", path: "/home/fixture/.spinner/themes/broken.json",
                missing: broken.missing, reason: broken.reason,
            }],
        };
    }

    settingsResponse(): SettingsResponse {
        return { settings: this.settings, path: "/home/fixture/.spinner/settings.yaml" };
    }

    /** `PUT /settings`: the theme must be `system`, a built-in or a listed custom theme. */
    putSettings(body: Record<string, unknown>, response: ServerResponse): void {
        const theme = body["theme"];
        const known = [THEME_SYSTEM, ...this.themes().themes.map((t) => t.name)];
        if (typeof theme !== "string" || !known.includes(theme)) {
            sendJson(response, { error: `unknown theme ${String(theme)}` }, 400);
            return;
        }
        this.settings = body as unknown as Settings;
        const ts = new Date().toISOString();
        this.emit({ type: "settings", ts, session: null, settings: this.settings });
        // `OperatorView.enabled` reports the setting (s014); the view follows a change.
        const enabled = this.settings.operator?.enabled ?? false;
        if (enabled !== this.operator.enabled) {
            this.operator = { ...this.operator, enabled };
            this.emit({ type: "operator.updated", ts, session: null, data: this.operator });
        }
        sendJson(response, this.settingsResponse());
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
        if (path === "/sessions/extract") {
            // Synchronous, as the daemon: the PRs of the paste against the project's repos.
            const repos = this.projectRepos(body["project"]);
            sendJson(response, extract(String(body["text"] ?? ""), repos));
            return true;
        }
        if (path === "/reviews") {
            const text = String(body["text"] ?? "");
            if (text.trim() === "") {
                sendJson(response, { error: "text is empty" }, 400);
                return true;
            }
            const job = this.reviews.create(text);
            if (job === null) {
                sendJson(response, { error: "no PR reference in the text" }, 409);
                return true;
            }
            return this.accepted(response, job);
        }
        if (path === "/sessions" && typeof body["text"] === "string") {
            // Chat first (s014): the paste, the ticked PRs, and a lead agent on its terminal.
            const text = body["text"];
            const adopt = (body["adopt"] as string[] | undefined) ?? [];
            const found = extract(text, this.projectRepos(body["project"]));
            const title = provisionalTitle(found, adopt);
            return this.accepted(response, this.create("new", title, adopt, body["project"], text));
        }
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
        if (this.diffRoute(response, path, body)) {
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

    /**
     * `POST /sessions/:dir/diff/start` (a `diff` job: the first one fetches the sources, then
     * each viewer starts and turns `running` with the fixture's own viewer page as its URL)
     * and `.../diff/stop` (synchronous: the view answers, `session.updated` follows). Body
     * `DiffRepoRequest { repo? }`; 404 for an unknown repo.
     */
    diffRoute(response: ServerResponse, path: string, body: Record<string, unknown>): boolean {
        const match = /^\/sessions\/([^/]+)\/diff\/(start|stop)$/.exec(path);
        const current = match === null ? undefined : this.sessions.get(match[1] ?? "");
        if (match === null || current === undefined || current.diff === undefined) {
            return false;
        }
        const diff = current.diff;
        const only = typeof body["repo"] === "string" ? body["repo"] : undefined;
        if (only !== undefined && !(only in diff.repos)) {
            sendJson(response, { error: `no repo ${only}` }, 404);
            return true;
        }
        const names = only === undefined ? Object.keys(diff.repos) : [only];
        const dir = current.summary.dir;
        type Patch = (name: string) => Partial<DiffRepoView>;
        const withRepos = (next: DiffView, patch: Patch) => ({
            ...next,
            repos: Object.fromEntries(
                Object.entries(next.repos).map(([name, repo]) =>
                    [name, names.includes(name) ? { ...repo, ...patch(name) } : repo],
                ),
            ),
        });
        if (match[2] === "stop") {
            const latest = this.sessions.get(dir) ?? current;
            const next = {
                ...latest, diff: withRepos(latest.diff ?? diff, () => diffRepoStopped()),
            };
            this.update(next);
            sendJson(response, { session: next });
            return true;
        }
        const job = this.start("diff", dir, async (log) => {
            const latest = () => this.sessions.get(dir) ?? current;
            if (latest().diff?.fetch !== "ready") {
                this.update({
                    ...latest(), diff: { ...diff, fetch: "fetching", fetch_error: null },
                });
                for (const line of ["cloning diff-viewer", "cloning peanut", "npm install"]) {
                    log(line);
                    await sleep(STEP_DELAY_MS);
                }
                const fetched = latest().diff ?? diff;
                this.update({
                    ...latest(), diff: { ...fetched, fetch: "ready", available: true },
                });
            }
            const started = latest().diff ?? diff;
            this.update({
                ...latest(),
                diff: withRepos(started, () => ({ state: "starting", error: null })),
            });
            for (const name of names) {
                log(`starting ${name}`);
            }
            await sleep(STEP_DELAY_MS);
            const now = latest().diff ?? diff;
            this.update({
                ...latest(),
                diff: withRepos(now, (name) => ({
                    state: "running",
                    url: diffViewerUrl(this.port, name),
                    pid: 50000 + Object.keys(now.repos).indexOf(name),
                })),
            });
            log("viewers up");
            return null;
        });
        this.accepted(response, job);
        return true;
    }

    /**
     * `POST /egm/fetch` as a job `egm` with no session: the state is `fetching` while the job
     * runs, then `ready` with the job's finish time as `fetched_at`, as a refetch at the pin.
     */
    fetchEgm(response: ServerResponse): true {
        this.egm = { ...this.egm, state: "fetching", error: null };
        const job = this.start("egm", null, async (log) => {
            for (const line of ["cloning EGM at a119668d7dc5", "writing 9 adapter agents"]) {
                log(line);
                await sleep(STEP_DELAY_MS);
            }
            const fetched = new Date().toISOString();
            this.egm = {
                ...this.egm, state: "ready", fetched_sha: this.egm.pinned_sha, fetched_at: fetched,
            };
            log("fetched EGM a119668d7dc5 and 9 adapter agents");
            return null;
        });
        return this.accepted(response, job);
    }

    /**
     * `PUT /sessions/:dir/design/track` (entry 2.37), as the daemon: 400 for an unknown track,
     * 409 once a repo has commits, 409 for `design` while EGM is not ready with pi-subagents;
     * else the updated view answers and `session.updated` follows. A switch to `design` starts
     * at `intake`; a switch to `direct` keeps the files with a null stage.
     */
    designTrack(response: ServerResponse, dir: string, body: Record<string, unknown>): void {
        const current = this.sessions.get(dir);
        const track = body["track"];
        if (current === undefined) {
            sendJson(response, { error: `no session ${dir}` }, 404);
            return;
        }
        if (track !== "design" && track !== "direct") {
            sendJson(response, { error: `unknown track ${String(track)}` }, 400);
            return;
        }
        const repos = Object.values(current.summary.session.repos);
        if (current.design !== undefined && repos.some((repo) => repo.changed)) {
            sendJson(response, { error: "the build has started; the track is fixed" }, 409);
            return;
        }
        if (track === "design" && (this.egm.state !== "ready" || !this.egm.subagents)) {
            const reason = this.egm.subagents ? this.egm.state : "pi-subagents is not installed";
            sendJson(response, { error: `EGM is not available: ${reason}` }, 409);
            return;
        }
        const known = current.design ?? designView(null);
        const design = track === "design"
            ? { ...known, track: "design" as const, stage: known.stage ?? "intake" }
            : { ...known, track: "direct" as const, stage: null };
        const next = { ...current, design };
        this.update(next);
        sendJson(response, { session: next });
    }

    accepted(response: ServerResponse, job: Job): true {
        sendJson(response, { job }, 202);
        return true;
    }

    /** The repos of the project a body names, by name or by spec path; none without one. */
    projectRepos(project: unknown): string[] {
        const found = PROJECTS.find((item) => item.name === project || item.path === project);
        return found === undefined ? [] : found.repos;
    }

    /**
     * `POST /sessions` and `/sessions/adopt` as one job. With `text` (chat first), the PRs
     * are the adopted URLs on their repos and a `lead` tty agent runs from the start, so the
     * session opens on its terminal.
     */
    create(
        action: "new" | "adopt", title: string, urls: string[], project: unknown, text?: string,
    ): Job {
        return this.start(action, null, async (log) => {
            const id = `s${100 + this.counter}`;
            const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
            const dir = `${id}-${slug}`;
            log(`creating ${dir}`);
            await sleep(STEP_DELAY_MS);
            const prs = urls.map((url, index) => {
                const parts = /\/([^/]+)\/pull\/(\d+)/.exec(url);
                return parts === null
                    ? pr(500 + index, "web")
                    : pr(Number(parts[2]), parts[1] ?? "web", { url });
            });
            for (const item of prs) {
                log(`adopted ${item.repo}#${item.number}`);
            }
            const lead = text === undefined ? {} : {
                lead: {
                    harness: "tty" as const, model: "fixture/default", process: "running" as const,
                },
            };
            const base = session({
                id, slug, title, created: new Date().toISOString(),
                stage: urls.length > 0 ? "peer-review" : "planned",
                agents: lead,
                ...(typeof project === "string" ? { project } : {}),
            });
            const stack = stackView(id, typeof project === "string" ? "down" : "none");
            this.update(view(dir, base, stack, prs, text === undefined ? [] : ["lead"]));
            if (text !== undefined) {
                log("started lead");
                log("sent the first message to lead");
            }
            log("session ready");
            return dir;
        });
    }

    act(action: "up" | "down" | "close" | "verify", current: SessionView): Job {
        const dir = current.summary.dir;
        const base = current.summary.session;
        const keep = { prs: current.board?.prs ?? [], agents: current.agents_running };
        // The viewers outlive `up` and stop with `down` (and `close`), as on the daemon.
        const put = (next: typeof base, state: "up" | "down" | "starting") => {
            const diff = state === "down" ? diffStopped(current.diff) : current.diff;
            this.update(view(dir, next, stackView(base.id, state), keep.prs, keep.agents, diff));
        };
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

    /**
     * `DELETE /sessions/:dir/verify`, as the daemon: synchronous, the cleared view answers
     * with 200 and a `session.updated` follows; 404 without the session.
     */
    unverify(response: ServerResponse, path: string): boolean {
        const match = /^\/sessions\/([^/]+)\/verify$/.exec(path);
        if (match === null) {
            return false;
        }
        const current = this.sessions.get(match[1] ?? "");
        if (current === undefined) {
            sendJson(response, { error: `no session ${match[1]}` }, 404);
            return true;
        }
        const base = current.summary.session;
        const pipeline = {
            slack_post: base.pipeline?.slack_post ?? null,
            verified_locally: false,
            verified_heads: {},
        };
        const summary = { ...current.summary, session: { ...base, pipeline } };
        const next = { ...current, summary };
        this.update(next);
        sendJson(response, { session: next });
        return true;
    }

    /** Mission, threads, previews, pipeline jobs and context files (see `pipeline.ts`). */
    async m2(
        request: IncomingMessage, response: ServerResponse, method: string, path: string,
    ): Promise<boolean> {
        const write = method === "POST" || method === "PUT";
        const body = write ? await readBody(request) : {};
        return this.pipeline.handle(method, path, body, response);
    }

    /**
     * `POST /sessions/:dir/review` on a session with an open PR: the swarm, not the pipeline
     * step; and the lead's routes of s016 (the session file, the draft, the post).
     */
    async reviewRoute(
        request: IncomingMessage, response: ServerResponse, method: string, path: string,
    ): Promise<boolean> {
        const match = /^\/sessions\/([^/]+)\/review$/.exec(path);
        if (method === "POST" && match !== null) {
            const job = this.reviews.swarm(match[1] ?? "");
            return job === null ? false : this.accepted(response, job);
        }
        const body = method === "PUT" || method === "POST" ? await readBody(request) : {};
        return this.reviews.handle(method, path, body, response);
    }

    async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const [path = "/", search = ""] = (request.url ?? "/").split("?");
        const method = request.method ?? "GET";
        const track = /^\/sessions\/([^/]+)\/design\/track$/.exec(path);
        if (method === "PUT" && track !== null) {
            this.designTrack(response, track[1] ?? "", await readBody(request));
            return;
        }
        if (DESIGN_ROUTE.test(path)) {
            const body = method === "PUT" || method === "POST" ? await readBody(request) : {};
            if (this.design.handle(method, path, body, response)) {
                return;
            }
        }
        const fish = /^\/sessions\/([^/]+)\/egm\//.exec(path)?.[1];
        const goldfish = this.sessions.get(fish ?? "")?.design?.goldfish;
        if (fish !== undefined && handleGoldfish(method, path, goldfish, response)) {
            return;
        }
        if (await this.reviewRoute(request, response, method, path)) {
            return;
        }
        if (await this.m2(request, response, method, path)) {
            return;
        }
        const dir = /^\/sessions\/([^/]+)$/.exec(path)?.[1];
        const jobId = /^\/jobs\/([^/]+)$/.exec(path)?.[1];
        const viewer = DIFF_VIEWER_ROUTE.exec(path);
        if (viewer !== null && viewer[2] === undefined && method === "GET") {
            sendDiffViewer(viewer[1] ?? "", response);
        } else if (viewer !== null && method === "GET") {
            sendJson(response, { keys: this.diffKeys.get(viewer[1] ?? "") ?? [] });
        } else if (viewer !== null && method === "POST") {
            const repo = viewer[1] ?? "";
            const key = String((await readBody(request))["key"]);
            this.diffKeys.set(repo, [...(this.diffKeys.get(repo) ?? []), key]);
            sendJson(response, { ok: true });
        } else if (method === "GET" && path === "/sessions") {
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
        } else if (method === "GET" && path === "/settings") {
            sendJson(response, this.settingsResponse());
        } else if (method === "PUT" && path === "/settings") {
            this.putSettings(await readBody(request), response);
        } else if (method === "GET" && path === "/themes") {
            sendJson(response, this.themes());
        } else if (method === "GET" && path === "/usage") {
            sendJson(response, this.usage());
        } else if (method === "GET" && path === "/costs") {
            const query = new URLSearchParams(search);
            const report = costsReport(query, [...this.sessions.values()]);
            sendJson(response, report.body, report.status);
        } else if (method === "GET" && path === "/health") {
            sendJson(response, { ok: true, home: "fixture", started: new Date().toISOString() });
        } else if (method === "GET" && path === "/egm") {
            sendJson(response, { egm: this.egm });
        } else if (method === "POST" && path === "/egm/fetch") {
            this.fetchEgm(response);
        } else if (method === "GET" && path === "/operator") {
            sendJson(response, { operator: this.operator });
        } else if (method === "POST" && this.operatorRoute(response, path)) {
            return;
        } else if (method === "POST" && (await this.run(request, response, path))) {
            return;
        } else if (method === "DELETE" && this.unverify(response, path)) {
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
        if (tty !== null || path === OPERATOR_TTY_PATH) {
            const pty = tty === null
                ? daemon.operatorTty()
                : daemon.pty(tty[1] ?? "", tty[2] ?? "");
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
    server.on("listening", () => {
        daemon.port = (server.address() as AddressInfo).port;
    });
    // The daemon rides along for tests that reach past HTTP, for example to drop a pty's clients.
    return Object.assign(server, { daemon });
}

if (import.meta.url === `file://${process.argv[1]}`) {
    startFixture();
    console.log(`Fixture daemon on http://localhost:${FIXTURE_PORT} (events at ${EVENTS_PATH})`);
}
