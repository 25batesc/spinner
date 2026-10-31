// Goal: the extension registers what the protocol says, builds the prompt section from the
// session files, calls the daemon's routes with the manifest's bodies, refuses a resolve
// without a reply, and guards edits outside the owned globs. Method: a fake `pi` that
// records registrations, a temporary session directory, and a fake daemon (`node:http`)
// that records requests and answers canned JSON. The real pi and daemon are exercised by
// hand (see the s005 Log).
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXTENSION_MANIFEST } from "@spinner/protocol";
import { glob_to_regex, guard_edit, owned_globs } from "./guard.js";
import { register } from "./index.js";
import type {
    BeforeAgentStartEvent,
    ExtensionAPI,
    ExtensionCommandContext,
    RegisteredCommand,
    ToolCallEvent,
    ToolCallResult,
    ToolDefinition,
} from "./pi-api.js";
import { roster_digests } from "./prompt.js";
import { schema_of } from "./tools.js";

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

/** A daemon that answers `GET /sessions/:dir`, `GET .../threads` and records every write. */
async function fake_daemon(
    replied: boolean,
): Promise<{ url: string; requests: Recorded[]; close(): void }> {
    const requests: Recorded[] = [];
    const server: Server = createServer((request, response) => {
        let raw = "";
        request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
        request.on("end", () => {
            const path = request.url ?? "";
            const body = raw.length === 0 ? undefined : (JSON.parse(raw) as unknown);
            requests.push({ method: request.method ?? "", path, body });
            const answer = (status: number, json: unknown): void => {
                response.writeHead(status, { "content-type": "application/json" });
                response.end(JSON.stringify(json));
            };
            if (path.startsWith("/nope")) {
                answer(404, { error: `no route ${path}` });
            } else if (path.endsWith("/threads")) {
                answer(200, {
                    threads: {
                        session: "s1-x",
                        rendered: null,
                        prs: [
                            {
                                repo: "api",
                                number: 7,
                                url: "https://example.test/pr/7",
                                head: "abc",
                                checks: "green",
                                review: "none",
                                open_bot: 1,
                                open_human: 0,
                                resolved: 0,
                                flagged: 0,
                                file: "threads/api-7.md",
                                threads: [
                                    {
                                        id: "PRRT_1",
                                        label: "T1",
                                        state: "open",
                                        outdated: false,
                                        author: "bot[bot]",
                                        author_kind: "bot",
                                        path: "src/a.ts",
                                        line: 3,
                                        body: "unused import",
                                        replies: [],
                                        replied,
                                        flagged: null,
                                    },
                                ],
                            },
                        ],
                    },
                });
            } else if (/\/threads\/[^/]+\/(reply|resolve|flag)/.test(path)) {
                const action = path.split("/").pop()?.split("?")[0] ?? "";
                answer(200, {
                    repo: "api",
                    number: 7,
                    thread: {
                        id: "PRRT_1",
                        label: "T1",
                        state: action === "resolve" ? "resolved" : "open",
                        flagged: action === "flag" ? "design" : null,
                    },
                });
            } else if (path.endsWith("/mission/section")) {
                answer(200, { ok: true, sections: [(body as { section: string }).section] });
            } else if (path.endsWith("/inbox")) {
                answer(201, { file: "120000-alpha-beta.md" });
            } else if (/\/stack\/logs\/web\?lines=20$/.test(path)) {
                answer(200, { service: "web", where: "host", lines: ["boot", "listening :8000"] });
            } else if (/^\/sessions\/[^/]+$/.test(path)) {
                answer(200, {
                    session: {
                        summary: { dir: "s1-x", session: { stage: "building" } },
                        board: null,
                        stack: {
                            state: "failed",
                            project: "spinner-s1",
                            services: [
                                { name: "web", status: "healthy", url: "http://web.s1.localhost" },
                            ],
                            last_job: {
                                action: "up",
                                state: "failed",
                                error: "service web is unhealthy",
                                finished: "2026-10-29T21:00:00.000Z",
                                tail: ["pulling web", "web exited 1"],
                            },
                        },
                    },
                });
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

let session_dir: string;

const MISSION = [
    "# s1 · X",
    "",
    "## Roster",
    "| Agent | Owns | Doing | Blocked? | Updated |",
    "|---|---|---|---|---|",
    "| alpha | `api/**` | tests | no | 10:00 |",
    "| beta | `web/**` | page | yes: /x | 10:01 |",
    "",
    "## Log",
    "- 10:00 alpha: started",
    "",
].join("\n");

beforeEach(() => {
    session_dir = mkdtempSync(join(tmpdir(), "spinner-ext-"));
    writeFileSync(join(session_dir, "session.yaml"), 'version: 1\nid: s1\ntitle: "X"\n');
    writeFileSync(join(session_dir, "MISSION.md"), MISSION);
    mkdirSync(join(session_dir, "agents", "alpha"), { recursive: true });
    writeFileSync(
        join(session_dir, "agents", "alpha", "BRIEF.md"),
        "# alpha\n\n## Owns\n- `api/**` and `docs/api.md`.\n- `shared/types/`\n",
    );
});

afterEach(() => {
    rmSync(session_dir, { recursive: true, force: true });
});

function env_for(role: string, daemon_url: string): NodeJS.ProcessEnv {
    return {
        SPINNER_SESSION_DIR: session_dir,
        SPINNER_AGENT: "alpha",
        SPINNER_DAEMON_URL: daemon_url,
        SPINNER_ROLE: role,
    };
}

async function run(pi: FakePi, name: string, args: Record<string, unknown>): Promise<string> {
    const tool = pi.tools.get(name);
    expect(tool, name).toBeDefined();
    const result = await tool!.execute("id", args, undefined, undefined, { cwd: session_dir });
    return result.content[0]?.text ?? "";
}

describe("registration", () => {
    it("registers nothing outside a Spinner session", () => {
        const pi = fake_pi();
        expect(register(pi, { env: {} })).toBeNull();
        expect(pi.tools.size).toBe(0);
        expect(pi.commands.size).toBe(0);
    });

    it("registers worker tools, fixer tools for the fixer, and /spinner-reload", async () => {
        const worker = fake_pi();
        register(worker, { env: env_for("worker", "") });
        const names_for = (role: "worker" | "fixer"): string[] =>
            EXTENSION_MANIFEST.tools
                .filter((tool) => tool.roles.includes(role))
                .map((tool) => tool.name);
        expect([...worker.tools.keys()]).toEqual(names_for("worker"));
        expect(worker.tools.has("session_new")).toBe(false);
        const fixer = fake_pi();
        register(fixer, { env: env_for("fixer", "") });
        expect([...fixer.tools.keys()]).toEqual(names_for("fixer"));
        expect(fixer.tools.has("thread_list")).toBe(true);
        let reloaded = 0;
        const ctx = {
            reload: async () => void (reloaded += 1),
        } as unknown as ExtensionCommandContext;
        await fixer.commands.get("spinner-reload")?.handler("", ctx);
        expect(reloaded).toBe(1);
    });

    it("builds parameter schemas with required, optional and enum fields", () => {
        const stack = EXTENSION_MANIFEST.tools.find((tool) => tool.name === "stack");
        const schema = schema_of(stack!) as {
            required?: string[];
            properties: Record<string, unknown>;
        };
        expect(schema.required).toEqual(["command"]);
        expect(Object.keys(schema.properties)).toEqual(["command", "service", "lines", "session"]);
        expect(JSON.stringify(schema.properties["command"])).toContain('"show"');
    });
});

describe("prompt section", () => {
    it("carries the session, hosts, brief, mission and the other agents' digests", async () => {
        const daemon = await fake_daemon(false);
        try {
            const pi = fake_pi();
            register(pi, { env: env_for("worker", daemon.url) });
            const event: BeforeAgentStartEvent = {
                messageType: "user",
                systemPromptOptions: { sections: {}, cwd: session_dir },
            };
            const handler = pi.handlers.get("before_agent_start")?.[0];
            await handler?.(event as never, {} as never);
            const section = event.systemPromptOptions.sections["spinner_session"] ?? "";
            expect(section).toContain("agent `alpha` (role worker) in Spinner session s1 · X.");
            expect(section).toContain("- web: http://web.s1.localhost");
            expect(section).toContain("- beta: page (blocked: yes: /x)");
            expect(section).not.toContain("- alpha: tests");
            expect(section).toContain("## Your brief (agents/alpha/BRIEF.md)\n\n# alpha");
            expect(section).toContain(
                "## MISSION.md (read in full; this is the current file)\n\n# s1 · X",
            );
        } finally {
            daemon.close();
        }
    });

    it("refuses a newer session.yaml and digests the roster", () => {
        writeFileSync(join(session_dir, "session.yaml"), "version: 9\nid: s1\n");
        const pi = fake_pi();
        register(pi, { env: env_for("worker", "") });
        expect(roster_digests(MISSION, "alpha")).toEqual(["beta: page (blocked: yes: /x)"]);
        expect(roster_digests(MISSION, "beta")).toEqual(["alpha: tests"]);
    });
});

describe("tools against the daemon routes", () => {
    it("writes the mission, messages, lists PRs and stack, replies and flags", async () => {
        const daemon = await fake_daemon(false);
        try {
            const pi = fake_pi();
            register(pi, { env: env_for("fixer", daemon.url) });
            expect(await run(pi, "mission_log", { text: "started" })).toBe(
                "MISSION.md updated: log.",
            );
            expect(await run(pi, "mission_roster", { doing: "tests", blocked: "no" })).toContain(
                "roster",
            );
            expect(await run(pi, "mission_contract", { text: "POST /x" })).toContain("contracts");
            expect(await run(pi, "mission_question", { text: "v1?" })).toContain("open_questions");
            expect(await run(pi, "message", { to: "beta", subject: "hi", text: "body" })).toBe(
                "Sent inbox/120000-alpha-beta.md to beta.",
            );
            expect(await run(pi, "pr", { command: "show" })).toContain("No PR yet; stage building");
            const shown = await run(pi, "stack", { command: "show" });
            expect(shown).toContain("- web: healthy · http://web");
            expect(shown).toContain("Last job: `up` failed at 2026-10-29T21:00:00.000Z.");
            expect(shown).toContain("Error: service web is unhealthy");
            expect(shown).toContain("  web exited 1");
            expect(await run(pi, "stack", { command: "logs", service: "web", lines: 20 })).toBe(
                "web (host), last 2 lines:\nboot\nlistening :8000",
            );
            expect(await run(pi, "stack", { command: "restart", service: "web" })).toContain(
                "spinner restart",
            );
            const listed = await run(pi, "thread_list", {});
            expect(listed).toContain("api#7 · 1 open (1 bot, 0 human)");
            expect(listed).toContain("- T1 [PRRT_1] bot bot[bot] · src/a.ts:3 (no reply)");
            expect(await run(pi, "thread_reply", { thread: "T1", pr: "api", text: "fixed" })).toBe(
                "T1 on api#7: reply done; now open.",
            );
            const flagged = { thread: "PRRT_1", reason: "design", pr: "api#7" };
            expect(await run(pi, "thread_flag", flagged)).toBe(
                "T1 on api#7: flag done; now flagged (design).",
            );
            await expect(run(pi, "thread_resolve", { thread: "T1" })).rejects.toThrow(
                /no reply from you/,
            );
            await expect(run(pi, "thread_resolve", { thread: "T9" })).rejects.toThrow(
                /no thread T9/,
            );

            const writes = daemon.requests.filter((request) => request.method !== "GET");
            const dir = session_dir.split("/").pop() ?? "";
            const seen = writes.map((request) => `${request.method} ${request.path}`);
            expect(seen).toEqual([
                `PUT /sessions/${dir}/mission/section`,
                `PUT /sessions/${dir}/mission/section`,
                `PUT /sessions/${dir}/mission/section`,
                `PUT /sessions/${dir}/mission/section`,
                `POST /sessions/${dir}/inbox`,
                `POST /sessions/${dir}/threads/T1/reply?pr=api`,
                `POST /sessions/${dir}/threads/PRRT_1/flag?pr=api`,
            ]);
            expect(writes[0]?.body).toEqual({
                section: "log",
                mode: "append",
                text: "started",
                author: "alpha",
            });
            expect(writes[1]?.body).toMatchObject({ mode: "roster_row", blocked: "no" });
            expect(writes[4]?.body).toEqual({
                from: "alpha",
                to: "beta",
                subject: "hi",
                text: "body",
            });
            expect(writes[5]?.body).toEqual({ text: "fixed" });
            expect(writes[6]?.body).toEqual({ reason: "design" });
        } finally {
            daemon.close();
        }
    });

    it("resolves a replied-to thread and surfaces the daemon's refusals", async () => {
        const daemon = await fake_daemon(true);
        try {
            const pi = fake_pi();
            register(pi, { env: env_for("fixer", daemon.url) });
            expect(await run(pi, "thread_resolve", { thread: "T1" })).toBe(
                "T1 on api#7: resolve done; now resolved.",
            );
            const last = daemon.requests[daemon.requests.length - 1];
            expect(`${last?.method} ${last?.path}`).toMatch(
                /^POST \/sessions\/[^/]+\/threads\/T1\/resolve$/,
            );
            const nowhere = fake_pi();
            register(nowhere, { env: env_for("worker", `${daemon.url}/nope`) });
            await expect(run(nowhere, "mission_log", { text: "x" })).rejects.toThrow(
                /404: no route/,
            );
        } finally {
            daemon.close();
        }
    });
});

describe("edit guard", () => {
    it("blocks an edit outside the owned globs until the Log names the file", () => {
        const pi = fake_pi();
        register(pi, { env: env_for("worker", "") });
        const handler = pi.handlers.get("tool_call")?.[0];
        const call = (tool: string, path: string): ToolCallResult | undefined => {
            const event: ToolCallEvent = { toolName: tool, input: { path } };
            const ctx = { cwd: "/repo", hasUI: false, ui: { notify: () => undefined } };
            return handler?.(event as never, ctx as never) as ToolCallResult | undefined;
        };
        expect(call("edit", "api/src/a.ts")).toBeUndefined();
        expect(call("write", "docs/api.md")).toBeUndefined();
        expect(call("write", "shared/types/x.ts")).toBeUndefined();
        expect(call("bash", "web/x.ts")).toBeUndefined();
        expect(call("edit", join(session_dir, "MISSION.md"))).toBeUndefined();
        const blocked = call("edit", "web/src/page.tsx");
        expect(blocked).toMatchObject({ block: true });
        expect(blocked?.reason).toContain("web/src/page.tsx is outside your owned paths (api/**");
        expect(blocked?.reason).toContain("mission_log");
        writeFileSync(
            join(session_dir, "MISSION.md"),
            `${MISSION}- 10:05 alpha: touching web/src/page.tsx to add the refund link\n`,
        );
        expect(call("edit", "web/src/page.tsx")).toBeUndefined();
    });

    it("parses globs from the brief and matches them", () => {
        expect(
            owned_globs(
                "## Owns\n- `a/**`, `b/c.ts` and `d/`\n- http://x\n## Do not edit\n- `z/**`\n",
            ),
        ).toEqual(["a/**", "b/c.ts", "d/**"]);
        expect(glob_to_regex("packages/*/src/**").test("packages/ui/src/a/b.ts")).toBe(true);
        expect(glob_to_regex("packages/*/src/**").test("packages/ui/test/a.ts")).toBe(false);
        expect(glob_to_regex("src/{a,b}.ts").test("src/b.ts")).toBe(true);
        expect(glob_to_regex("**/*.md").test("README.md")).toBe(true);
        expect(glob_to_regex("store/mission-*.ts").test("store/mission-writer.ts")).toBe(true);
        expect(
            guard_edit({ path: "x", cwd: "/r", session_dir: "/s", brief: "", mission: "" }),
        ).toEqual({
            allow: true,
        });
    });
});
