// Goal: in the lead role (MISSION.md s014) the extension registers the mission tools, the
// lead's own ones (`session_title`, `mission_goal`, `mission_done_when`, `mission_plan`,
// `adopt`) and the shared `agent_add` and `agent_steer` on its own session, turns each into
// the daemon route's body (the `item` mode of the section route, the title route with the
// author, the adopt job waited on), names the lead in its prompt section, and blocks the
// bash calls the operator keeps. Method: a fake `pi` that records registrations, a temporary
// session directory, and a fake daemon (`node:http`) that records requests.
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { register } from "./index.js";
import type {
    BeforeAgentStartEvent,
    ExtensionAPI,
    RegisteredCommand,
    ToolCallEvent,
    ToolCallResult,
    ToolDefinition,
} from "./pi-api.js";

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

const DIR = "s4-refunds";

/** Answers the lead tools' routes; the adopt job finishes on the second poll. */
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
                id: "j-7",
                action: "adopt",
                session: DIR,
                state,
                started: "2026-11-02T01:00:00.000Z",
                finished: state === "running" ? null : "2026-11-02T01:00:02.000Z",
                log: ["refused other#1: `other` is not a repo of the project", "adopted 1 PR"],
                error: null,
            });
            if (path.endsWith("/mission/section")) {
                answer(200, { ok: true, sections: [(body as { section: string }).section] });
            } else if (path.startsWith(`/sessions/${DIR}/title`)) {
                answer(200, { session: { summary: { session: { title: "x" } } } });
            } else if (path === `/sessions/${DIR}/adopt`) {
                answer(202, { job: job("running") });
            } else if (path === "/jobs/j-7") {
                polls += 1;
                answer(200, { job: job(polls >= 2 ? "ok" : "running") });
            } else if (method === "POST" && path === `/sessions/${DIR}/agents`) {
                answer(201, { name: (body as { name: string }).name, pi_session_id: "backend" });
            } else if (path.endsWith("/steer")) {
                answer(200, { ok: true, disposition: "queued" });
            } else if (path === `/sessions/${DIR}`) {
                answer(200, { session: { stack: { services: [] } } });
            } else if (path === `/sessions/${DIR}/review/briefing`) {
                answer(200, { ok: true });
            } else if (path === `/sessions/${DIR}/review/draft`) {
                const draft = body as { comments: unknown[] };
                if (draft.comments.length > 1) {
                    const fault = "comments[1] (x.ts:9): x.ts is not in the diff";
                    answer(400, { error: `the draft has 1 fault: ${fault}` });
                } else {
                    answer(200, { draft: body });
                }
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

beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "spinner-ext-lead-"));
    session_dir = join(root, DIR);
    mkdirSync(join(session_dir, "agents", "lead"), { recursive: true });
    writeFileSync(join(session_dir, "session.yaml"), "version: 1\nid: s4\ntitle: Refunds\n");
    writeFileSync(join(session_dir, "MISSION.md"), "# s4 · Refunds\n\n## Goal\n\n## Log\n");
    writeFileSync(join(session_dir, "agents", "lead", "BRIEF.md"), "# lead\n\nYou own it.\n");
});

afterEach(() => {
    rmSync(join(session_dir, ".."), { recursive: true, force: true });
});

function env_for(daemon_url: string): NodeJS.ProcessEnv {
    return {
        SPINNER_SESSION_DIR: session_dir,
        SPINNER_AGENT: "lead",
        SPINNER_DAEMON_URL: daemon_url,
        SPINNER_ROLE: "lead",
    };
}

async function run(pi: FakePi, name: string, args: Record<string, unknown>): Promise<string> {
    const tool = pi.tools.get(name);
    expect(tool, name).toBeDefined();
    const result = await tool!.execute("id", args, undefined, undefined, { cwd: session_dir });
    return result.content[0]?.text ?? "";
}

describe("the lead role", () => {
    it("registers the lead's tools and names the lead in its prompt section", async () => {
        const pi = fake_pi();
        const registered = register(pi, { env: env_for("") });
        expect(registered?.role).toBe("lead");
        const names = [...pi.tools.keys()];
        for (const name of ["session_title", "mission_goal", "mission_done_when", "mission_plan"]) {
            expect(names).toContain(name);
        }
        expect(names).toContain("adopt");
        expect(names).toContain("agent_add");
        expect(names).toContain("agent_steer");
        expect(names).not.toContain("session_new");
        expect(names).not.toContain("thread_reply");
        const handler = pi.handlers.get("before_agent_start")?.[0];
        const event: BeforeAgentStartEvent = { systemPromptOptions: { sections: {} } };
        await handler?.(event as never, {} as never);
        const section = event.systemPromptOptions.sections["spinner_session"] ?? "";
        expect(section).toContain("You are the lead");
        expect(section).toContain("`mission_plan`");
        expect(section).toContain("You own it.");
    });

    it("turns each tool into the route's body on its own session", async () => {
        const daemon = await fake_daemon();
        try {
            const pi = fake_pi();
            register(pi, { env: env_for(daemon.url), job_poll_ms: 5 });
            const section = `/sessions/${DIR}/mission/section`;

            expect(await run(pi, "session_title", { title: "Refunds, end to end" })).toContain(
                "Title set",
            );
            expect(daemon.requests.at(-1)).toEqual({
                method: "PUT",
                path: `/sessions/${DIR}/title?author=lead`,
                body: { title: "Refunds, end to end" },
            });

            await run(pi, "mission_goal", { text: "Ship refunds." });
            expect(daemon.requests.at(-1)).toEqual({
                method: "PUT",
                path: section,
                body: { section: "goal", mode: "replace", text: "Ship refunds.", author: "lead" },
            });

            const items = "API agreed\n- UI done\n";
            await run(pi, "mission_done_when", { command: "set", items });
            expect(daemon.requests.at(-1)?.body).toEqual({
                section: "done_when",
                mode: "replace",
                text: "- [ ] API agreed\n- [ ] UI done",
                author: "lead",
            });
            await run(pi, "mission_done_when", { command: "tick", id: 2 });
            expect(daemon.requests.at(-1)?.body).toEqual({
                section: "done_when",
                mode: "item",
                text: "",
                author: "lead",
                item: { command: "tick", id: 2 },
            });

            await run(pi, "mission_plan", { command: "add", text: "contract", owner: "backend" });
            expect(daemon.requests.at(-1)?.body).toEqual({
                section: "plan",
                mode: "item",
                text: "",
                author: "lead",
                item: { command: "add", text: "contract", owner: "backend" },
            });
            await run(pi, "mission_plan", { command: "reorder", order: "3 1, 2" });
            expect((daemon.requests.at(-1)?.body as { item: unknown }).item).toEqual({
                command: "reorder",
                order: [3, 1, 2],
            });
            await expect(run(pi, "mission_plan", { command: "tick", id: "x" })).rejects.toThrow(
                /`id` must be/,
            );
            await expect(run(pi, "mission_plan", { command: "drop" })).rejects.toThrow(
                /must be one of/,
            );

            const adopted = await run(pi, "adopt", { refs: "backend#4825, other#1" });
            expect(adopted).toContain("refused other#1");
            expect(daemon.requests.find((r) => r.path === `/sessions/${DIR}/adopt`)?.body).toEqual({
                refs: ["backend#4825", "other#1"],
            });
            expect(daemon.requests.filter((r) => r.path === "/jobs/j-7")).toHaveLength(2);

            const added = await run(pi, "agent_add", { name: "backend", repo: "api" });
            expect(added).toContain(`Agent backend started in ${DIR}`);
            expect(daemon.requests.at(-1)).toEqual({
                method: "POST",
                path: `/sessions/${DIR}/agents`,
                body: { name: "backend", repo: "api" },
            });
            const steered = await run(pi, "agent_steer", { agent: "backend", text: "go" });
            expect(steered).toContain("queued");
            expect(daemon.requests.at(-1)?.path).toBe(`/sessions/${DIR}/agents/backend/steer`);
            // The review lead's two tools (s016).
            const briefed = await run(pi, "review_briefing", {
                markdown: "# What\n\nIt adds a line.",
            });
            expect(briefed).toContain("Briefing written");
            expect(daemon.requests.at(-1)).toEqual({
                method: "PUT",
                path: `/sessions/${DIR}/review/briefing`,
                body: { markdown: "# What\n\nIt adds a line." },
            });
            const comment = {
                path: "README.md",
                line: 2,
                body: "BLOCKING: Fix the count. It is off.",
            };
            const drafted = await run(pi, "review_draft", {
                event: "COMMENT",
                body: "A few blockers",
                comments: JSON.stringify([comment]),
            });
            expect(drafted).toContain('Draft written: COMMENT, "A few blockers", 1 line comment');
            expect(drafted).toContain("do not post");
            expect(daemon.requests.at(-1)).toEqual({
                method: "PUT",
                path: `/sessions/${DIR}/review/draft`,
                body: { event: "COMMENT", body: "A few blockers", comments: [comment] },
            });
            const clear = await run(pi, "review_draft", {
                event: "APPROVE",
                body: "LGTM",
                comments: "",
            });
            expect(clear).toContain("0 line comments");
            await expect(
                run(pi, "review_draft", {
                    event: "COMMENT",
                    body: "A few blockers",
                    comments: JSON.stringify([comment, { path: "x.ts", line: 9, body: "NIT: y" }]),
                }),
            ).rejects.toThrow(/x\.ts is not in the diff/);
            await expect(
                run(pi, "review_draft", { event: "COMMENT", body: "x", comments: "not json" }),
            ).rejects.toThrow(/JSON array/);
        } finally {
            daemon.close();
        }
    });

    it("blocks the bash calls the operator keeps", () => {
        const pi = fake_pi();
        register(pi, { env: env_for("") });
        const handler = pi.handlers.get("tool_call")?.[0];
        const verdict = (command: string): ToolCallResult | undefined => {
            const event: ToolCallEvent = { toolName: "bash", input: { command } };
            return handler?.(event as never, { cwd: session_dir, hasUI: false } as never) as
                ToolCallResult | undefined;
        };
        expect(verdict("spinner land s4")?.block).toBe(true);
        expect(verdict("git push")?.reason).toMatch(/the operator must do it/);
        expect(verdict("git commit -m x")).toBeUndefined();
        // The review lead never posts (s016): the review verbs and gh api writes are refused.
        expect(verdict("gh pr review 2 --approve")?.block).toBe(true);
        expect(verdict("gh pr comment 2 --body hi")?.block).toBe(true);
        expect(verdict("gh api -X POST repos/a/b/pulls/2/reviews --input r.json")?.block).toBe(
            true,
        );
        expect(verdict("gh api repos/a/b/pulls/2/reviews --method POST -f body=x")?.block).toBe(
            true,
        );
        expect(verdict("gh api repos/a/b/pulls/2/reviews -f event=COMMENT")?.block).toBe(true);
        expect(verdict("gh api repos/a/b/pulls/2/files --paginate")).toBeUndefined();
        expect(verdict("gh api -X GET repos/a/b/pulls/2")).toBeUndefined();
        expect(verdict("gh pr diff 2")).toBeUndefined();
    });
});
