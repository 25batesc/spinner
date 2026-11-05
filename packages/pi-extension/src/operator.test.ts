// Goal: in the operator role the extension registers the operator tools and nothing
// session-bound, builds its prompt from `<home>/operator/BRIEF.md`, calls the daemon's routes
// with the bodies the UI sends (a session job is waited on through `GET /jobs/:id`), takes
// `session` on `stack` and `pr`, opens its tty channel on `/operator`, and blocks a bash call
// that pushes, posts, approves, lands, resets or closes. Method: a fake `pi` that records
// registrations, a temporary operator directory, and a fake daemon (`node:http`) that records
// requests and answers canned JSON.
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXTENSION_MANIFEST } from "@spinner/protocol";
import { agent_route_base, read_env } from "./env.js";
import { refuse_operator_bash, refuse_process_sweep } from "./guard.js";
import { register } from "./index.js";
import type {
    BeforeAgentStartEvent,
    ExtensionAPI,
    RegisteredCommand,
    ToolCallEvent,
    ToolCallResult,
    ToolDefinition,
} from "./pi-api.js";
import { render_session } from "./tools-operator.js";

interface FakePi extends ExtensionAPI {
    tools: Map<string, ToolDefinition>;
    commands: Map<string, RegisteredCommand>;
    handlers: Map<string, ((event: never, ctx: never) => unknown)[]>;
}

function fake_pi(): FakePi {
    const pi: FakePi = {
        tools: new Map(),
        commands: new Map(),
        handlers: new Map(),
        registerTool: (tool) => pi.tools.set(tool.name, tool),
        registerCommand: (name, command) => pi.commands.set(name, command),
        on: (event: string, handler: (event: never, ctx: never) => unknown) => {
            pi.handlers.set(event, [...(pi.handlers.get(event) ?? []), handler]);
            return () => undefined;
        },
    } as FakePi;
    return pi;
}

interface Recorded {
    method: string;
    path: string;
    body: unknown;
}

const SESSION_VIEW = {
    summary: {
        dir: "s3-refund-flow",
        path: "/tmp/s3-refund-flow",
        session: {
            id: "s3",
            title: "Refund flow",
            stage: "building",
            needs_human: null,
            repos: { api: { path: "api" } },
            agents: { backend: { harness: "tty", model: "default", process: "idle" } },
        },
    },
    board: null,
    stack: { state: "none", project: null, database: null, services: [], observed: null },
    agents_running: ["backend"],
    can_verify: false,
};

/** Answers the operator tools' routes; `POST /sessions` starts a job that finishes on poll 2. */
async function fake_daemon(): Promise<{ url: string; requests: Recorded[]; close(): void }> {
    const requests: Recorded[] = [];
    let polls = 0;
    const server: Server = createServer((request, response) => {
        let raw = "";
        request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
        request.on("end", () => {
            const path = request.url ?? "";
            const method = request.method ?? "";
            const body = raw.length === 0 ? undefined : (JSON.parse(raw) as unknown);
            requests.push({ method, path, body });
            const answer = (status: number, json: unknown): void => {
                response.writeHead(status, { "content-type": "application/json" });
                response.end(JSON.stringify(json));
            };
            const job = (state: string) => ({
                id: "j-1",
                action: "new",
                session: "s3-refund-flow",
                state,
                started: "2026-10-30T22:00:00.000Z",
                finished: state === "running" ? null : "2026-10-30T22:00:01.000Z",
                log: ["created /tmp/s3-refund-flow", "project sample attached"],
                error: state === "failed" ? "boom" : null,
            });
            if (method === "POST" && path === "/sessions") {
                answer(202, { job: job("running") });
            } else if (path === "/jobs/j-1") {
                polls += 1;
                answer(200, { job: job(polls >= 2 ? "ok" : "running") });
            } else if (path === "/sessions") {
                answer(200, { sessions: [SESSION_VIEW] });
            } else if (path === "/sessions/s3-refund-flow/mission") {
                response.writeHead(200, { "content-type": "text/markdown" });
                response.end("# s3 · Refund flow\n\n## Goal\nShip it.\n");
            } else if (path === "/sessions/s3-refund-flow") {
                answer(200, { session: SESSION_VIEW });
            } else if (path.endsWith("/mission/section")) {
                answer(200, { ok: true, sections: [(body as { section: string }).section] });
            } else if (path.endsWith("/brief")) {
                answer(200, { ok: true, path: "/tmp/s3-refund-flow/agents/backend/BRIEF.md" });
            } else if (method === "POST" && path === "/sessions/s3-refund-flow/agents") {
                answer(201, {
                    name: (body as { name: string }).name,
                    pi_session_id: "backend",
                    first_turn: "started",
                });
            } else if (path.endsWith("/steer")) {
                answer(200, { ok: true, disposition: "started" });
            } else if (path.endsWith("/inbox")) {
                answer(201, { file: "120000-operator-backend.md" });
            } else {
                answer(404, { error: `no route ${path}` });
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return { url: `http://127.0.0.1:${port}`, requests, close: () => server.close() };
}

let operator_dir: string;

beforeEach(() => {
    operator_dir = mkdtempSync(join(tmpdir(), "spinner-ext-operator-"));
    writeFileSync(join(operator_dir, "BRIEF.md"), "# operator\n\nYou run sessions.\n");
});

afterEach(() => {
    rmSync(operator_dir, { recursive: true, force: true });
});

function env_for(daemon_url: string): NodeJS.ProcessEnv {
    return {
        SPINNER_SESSION_DIR: operator_dir,
        SPINNER_AGENT: "operator",
        SPINNER_DAEMON_URL: daemon_url,
        SPINNER_ROLE: "operator",
    };
}

async function run(pi: FakePi, name: string, args: Record<string, unknown>): Promise<string> {
    const tool = pi.tools.get(name);
    expect(tool, name).toBeDefined();
    const result = await tool!.execute("id", args, undefined, undefined, { cwd: operator_dir });
    return result.content[0]?.text ?? "";
}

describe("the operator role", () => {
    it("reads the role, routes its channel to /operator, registers the operator tools", () => {
        const env = read_env(env_for("http://127.0.0.1:1"));
        expect(env?.role).toBe("operator");
        expect(env?.dir).toBe(operator_dir.split("/").pop());
        expect(agent_route_base(env!)).toBe("http://127.0.0.1:1/operator");
        const pi = fake_pi();
        register(pi, { env: env_for("") });
        const expected = EXTENSION_MANIFEST.tools
            .filter((tool) => tool.roles.includes("operator"))
            .map((tool) => tool.name);
        expect([...pi.tools.keys()]).toEqual(expected);
        expect(pi.tools.has("mission_roster")).toBe(false);
        expect(pi.tools.has("thread_list")).toBe(false);
    });

    it("builds its prompt section from operator/BRIEF.md", async () => {
        const pi = fake_pi();
        register(pi, { env: env_for("") });
        const event: BeforeAgentStartEvent = {
            messageType: "user",
            systemPromptOptions: { sections: {}, cwd: operator_dir },
        };
        await pi.handlers.get("before_agent_start")?.[0]?.(event as never, {} as never);
        const section = event.systemPromptOptions.sections["spinner_session"] ?? "";
        expect(section).toContain("You are the operator agent of this Spinner home");
        expect(section).toContain(`Your directory is ${operator_dir}`);
        expect(section).toContain("## Your brief (operator/BRIEF.md)");
        expect(section).toContain("You run sessions.");
    });

    it("calls the daemon with the UI's bodies and waits for a session job", async () => {
        const daemon = await fake_daemon();
        const dir = "s3-refund-flow";
        try {
            const pi = fake_pi();
            register(pi, { env: env_for(daemon.url), job_poll_ms: 5 });
            const created = await run(pi, "session_new", {
                title: "Refund flow",
                project: "sample",
            });
            expect(created).toContain("Session s3-refund-flow created");
            expect(daemon.requests[0]).toEqual({
                method: "POST",
                path: "/sessions",
                body: { title: "Refund flow", project: "sample" },
            });
            expect(daemon.requests.filter((r) => r.path === "/jobs/j-1").length).toBe(2);

            const goal = await run(pi, "mission_write", {
                session: "s3-refund-flow",
                section: "goal",
                text: "Add a health endpoint.",
            });
            expect(goal).toContain("updated: goal");
            expect(daemon.requests.at(-1)).toEqual({
                method: "PUT",
                path: "/sessions/s3-refund-flow/mission/section",
                body: {
                    section: "goal",
                    mode: "replace",
                    text: "Add a health endpoint.",
                    author: "operator",
                },
            });
            await run(pi, "mission_write", { session: dir, section: "plan", text: "1. x" });
            expect((daemon.requests.at(-1)?.body as { mode: string }).mode).toBe("append");
            await expect(
                run(pi, "mission_write", { session: dir, section: "roster", text: "x" }),
            ).rejects.toThrow(/section must be one of/);

            const brief = await run(pi, "brief_write", {
                session: "s3-refund-flow",
                agent: "backend",
                text: "# backend\n",
            });
            expect(brief).toContain("Brief written");
            expect(daemon.requests.at(-1)).toEqual({
                method: "PUT",
                path: "/sessions/s3-refund-flow/agents/backend/brief",
                body: { brief: "# backend\n" },
            });

            const add = { session: dir, name: "backend", repo: "api" };
            const added = await run(pi, "agent_add", add);
            expect(added).toContain("Agent backend started in s3-refund-flow on repo api");
            expect(daemon.requests.at(-1)).toEqual({
                method: "POST",
                path: "/sessions/s3-refund-flow/agents",
                body: { name: "backend", repo: "api" },
            });

            const steer = { session: dir, agent: "backend", text: "go" };
            const steered = await run(pi, "agent_steer", steer);
            expect(steered).toContain("started");
            expect(daemon.requests.at(-1)?.body).toEqual({ text: "go" });

            const sent = await run(pi, "inbox_send", {
                session: "s3-refund-flow",
                to: "backend",
                subject: "hi",
                text: "body",
            });
            expect(sent).toContain("Sent inbox/120000-operator-backend.md to backend");
            expect(daemon.requests.at(-1)?.body).toEqual({
                from: "operator",
                to: "backend",
                subject: "hi",
                text: "body",
            });

            const listed = await run(pi, "session_list", {});
            expect(listed).toContain("s3-refund-flow · Refund flow · stage building");
            expect(listed).toContain("agents backend (idle)");
            const shown = await run(pi, "session_show", { session: "s3-refund-flow" });
            expect(shown).toContain("## Goal\nShip it.");

            const pr = await run(pi, "pr", { command: "show", session: "s3-refund-flow" });
            expect(pr).toContain("No PR yet");
            expect(daemon.requests.at(-1)?.path).toBe("/sessions/s3-refund-flow");
            await expect(run(pi, "pr", { command: "show" })).rejects.toThrow(/`session` must name/);
        } finally {
            daemon.close();
        }
    });

    it("blocks a bash call that pushes, posts, approves, lands, resets or closes", () => {
        const pi = fake_pi();
        register(pi, { env: env_for("") });
        const handler = pi.handlers.get("tool_call")?.[0];
        const verdict = (command: string): ToolCallResult | undefined => {
            const event: ToolCallEvent = { toolName: "bash", input: { command } };
            return handler?.(event as never, { cwd: operator_dir, hasUI: false } as never) as
                | ToolCallResult
                | undefined;
        };
        expect(verdict("spinner approve s3")?.block).toBe(true);
        expect(verdict("cd x && git push origin main")?.block).toBe(true);
        expect(verdict("gh pr merge 7")?.block).toBe(true);
        expect(verdict("spinner status s3")).toBeUndefined();
        expect(verdict("git log --oneline")).toBeUndefined();
        expect(refuse_operator_bash("spinner land s3")).toMatch(/the operator must do it/);
        expect(refuse_operator_bash("git -C api push --force")).toMatch(/git push/);
        expect(refuse_operator_bash("gh pr view 7")).toBeNull();
    });

    it("refuses pkill and killall for every role: a pattern can match the operator's apps", () => {
        const sweep = 'pkill -f "fixture/server.ts" -n 2>/dev/null; sleep 1';
        expect(refuse_process_sweep(sweep)).toMatch(/`pkill` is refused/);
        expect(refuse_process_sweep("cd ui && killall node")).toMatch(/`killall` is refused/);
        expect(refuse_process_sweep("lsof -ti :5190 | xargs kill")).toBeNull();
        expect(refuse_process_sweep("kill 1234")).toBeNull();
        expect(refuse_process_sweep("pgrep -fl vite")).toBeNull();
        // Every role is covered: the operator role above, and a worker here.
        const pi = fake_pi();
        register(pi, { env: { ...env_for(""), SPINNER_AGENT: "ui", SPINNER_ROLE: "worker" } });
        const handler = pi.handlers.get("tool_call")?.[0];
        const event: ToolCallEvent = { toolName: "bash", input: { command: "pkill -f vite" } };
        const verdict = handler?.(event as never, { cwd: operator_dir, hasUI: false } as never) as
            | ToolCallResult
            | undefined;
        expect(verdict?.block).toBe(true);
    });

    it("render_session names what a notice needs: dir, stage, needs_human, agents", () => {
        const line = render_session({
            ...SESSION_VIEW,
            summary: {
                ...SESSION_VIEW.summary,
                session: { ...SESSION_VIEW.summary.session, needs_human: "approve" },
            },
            agents_running: [],
        } as never);
        expect(line).toBe(
            "- s3-refund-flow · Refund flow · stage building · needs a human: approve · " +
                "repos api · stack none · agents backend (stopped)",
        );
    });
});
