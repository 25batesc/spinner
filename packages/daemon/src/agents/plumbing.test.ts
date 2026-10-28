// Goal: the agent plumbing of M2 works end to end against the daemon: the mission route
// writes through the serialized writer and the file watcher turns the change into one steer
// per other agent; an inbox message reaches a busy agent as a steer, an idle one on its next
// prompt, and the operator through the Log; the context route lists the chain and a write
// reloads the running agent; the fixer plan honours `threads.autofix`. Method: a daemon on a
// temporary home with the fake pi (`test/fixtures/fake-pi.ts`), which records steers and
// echoes them on `steers?`, plus the pure functions on fixtures.
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
    ContextFileResponse,
    ContextResponse,
    MessageDeliveredEvent,
    PipelineConfig,
    SpinnerEvent,
    ThreadsView,
} from "@spinner/protocol";
import { PIPELINE_CONFIG_DEFAULTS } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { start_daemon, type Daemon } from "../server.js";
import { create_session } from "../store/session-store.js";
import { describe_changes, diff_mission } from "../watch/mission-diff.js";
import { fixer_prompt, plan_fixer_work, render_fixer_brief } from "./fixer.js";
import { parse_inbox_file_name } from "./inbox.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(here, "..", "..", "test", "fixtures", "fake-pi.ts");

let home: SpinnerHome;
let daemon: Daemon;
let base: string;
let events: SpinnerEvent[];

beforeEach(async () => {
    chmodSync(FAKE_PI, 0o755);
    home = resolve_home({ SPINNER_HOME: mkdtempSync(join(tmpdir(), "spinner-plumbing-")) });
    daemon = await start_daemon({
        home,
        port: 0,
        log: () => undefined,
        poll_seconds: 0,
        gh: () => Promise.reject(new Error("no gh in tests")),
        notify: async () => undefined,
        ui_dir: null,
        observe_interval_ms: 60_000,
        pi: FAKE_PI,
        extension: null,
    });
    base = `http://127.0.0.1:${daemon.port}`;
    events = [];
    daemon.bus.subscribe((event) => events.push(event));
});

afterEach(async () => {
    await daemon.close();
    rmSync(home.root, { recursive: true, force: true });
});

function call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

/** Polls `check` until it is true, at most 4 s. */
async function until(check: () => boolean): Promise<void> {
    for (let poll = 0; poll < 200; poll += 1) {
        if (check()) {
            return;
        }
        await new Promise((resolve_) => setTimeout(resolve_, 20));
    }
    throw new Error("condition not met in time");
}

function add_agent(session_path: string, name: string): Promise<Response> {
    mkdirSync(join(session_path, "agents", name), { recursive: true });
    writeFileSync(join(session_path, "agents", name, "BRIEF.md"), `# ${name}\n`);
    return call("POST", `/sessions/${session_path.split("/").pop() ?? ""}/agents`, { name });
}

function delivered(): MessageDeliveredEvent[] {
    return events.filter(
        (event): event is MessageDeliveredEvent => event.type === "message.delivered",
    );
}

/** The last assistant text the fake pi produced for `agent`. */
function last_echo(agent: string): string {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type !== "agent.event" || event.agent !== agent) {
            continue;
        }
        if (event.event.type === "message_end") {
            const content = event.event.message.content;
            const first = Array.isArray(content) ? content[0] : undefined;
            if (first !== undefined && first.type === "text") {
                return first.text;
            }
        }
    }
    return "";
}

describe("PUT /sessions/:dir/mission/section", () => {
    it("writes through the daemon and steers the other agents once", async () => {
        const summary = create_session(home, { title: "Mission" });
        expect((await add_agent(summary.path, "alpha")).status).toBe(201);
        expect((await add_agent(summary.path, "beta")).status).toBe(201);
        const bad = await call("PUT", `/sessions/${summary.dir}/mission/section`, {
            section: "log",
            mode: "replace",
            text: "x",
            author: "alpha",
        });
        expect(bad.status).toBe(400);

        const written = await call("PUT", `/sessions/${summary.dir}/mission/section`, {
            section: "log",
            mode: "append",
            text: "contract posted",
            author: "alpha",
        });
        expect(written.status).toBe(200);
        expect(await written.json()).toEqual({ ok: true, sections: ["log"] });
        const row = await call("PUT", `/sessions/${summary.dir}/mission/section`, {
            section: "roster",
            mode: "roster_row",
            text: "tests",
            author: "alpha",
            blocked: "no",
        });
        expect(row.status).toBe(200);
        const text = readFileSync(join(summary.path, "MISSION.md"), "utf8");
        expect(text).toMatch(/- \d\d:\d\d alpha: contract posted/);
        expect(text).toMatch(/\| alpha \| — \| tests \| no \| \d\d:\d\d \|/);

        // The watcher sees the file; beta gets one notice (the second write is within 30 s and
        // joins the first), alpha none.
        await until(() => delivered().some((event) => event.agent === "beta"));
        const to_beta = delivered().filter((event) => event.agent === "beta");
        expect(to_beta).toHaveLength(1);
        expect(to_beta[0]).toMatchObject({ file: null, how: "prompt" });
        expect(delivered().some((event) => event.agent === "alpha")).toBe(false);
        expect(daemon.agents.pending_for(summary.dir, "beta")[0]).toMatch(
            /^MISSION\.md changed by alpha: Roster \(own row\), Log \(\+1\)\.\n/,
        );
        expect(events.filter((event) => event.type === "mission.changed")).toHaveLength(2);

        // The notice is prepended to beta's next prompt.
        await call("POST", `/sessions/${summary.dir}/agents/beta/prompt`, { text: "work" });
        await until(() => last_echo("beta").includes("work"));
        expect(last_echo("beta")).toMatch(/^echo: MISSION\.md changed by alpha.*\n\n---\n\nwork$/s);
        expect(daemon.agents.pending_for(summary.dir, "beta")).toEqual([]);
    });
});

describe("POST /sessions/:dir/inbox", () => {
    it("steers a busy agent, queues for an idle one, and logs for the operator", async () => {
        const summary = create_session(home, { title: "Inbox" });
        expect((await add_agent(summary.path, "alpha")).status).toBe(201);
        expect((await add_agent(summary.path, "beta")).status).toBe(201);
        const partial = { from: "alpha", to: "beta" };
        const short = await call("POST", `/sessions/${summary.dir}/inbox`, partial);
        expect(short.status).toBe(400);

        // beta runs a slow turn: the message reaches it as a steer.
        await call("POST", `/sessions/${summary.dir}/agents/beta/prompt`, { text: "slow one" });
        await until(() => daemon.agents.is_busy(summary.dir, "beta"));
        const sent = await call("POST", `/sessions/${summary.dir}/inbox`, {
            from: "alpha",
            to: "beta",
            subject: "contract posted",
            text: "you are unblocked",
        });
        expect(sent.status).toBe(201);
        const { file } = (await sent.json()) as { file: string };
        expect(file).toMatch(/^\d{6}-alpha-beta\.md$/);
        expect(readFileSync(join(summary.path, "inbox", file), "utf8")).toBe(
            "contract posted\n\nyou are unblocked\n",
        );
        expect(delivered().find((event) => event.file === file)).toMatchObject({
            agent: "beta",
            how: "steer",
        });
        await until(() => !daemon.agents.is_busy(summary.dir, "beta"));
        await call("POST", `/sessions/${summary.dir}/agents/beta/prompt`, { text: "steers?" });
        await until(() => last_echo("beta").startsWith("echo: steers:"));
        expect(last_echo("beta")).toContain(`Message from alpha (inbox/${file}): contract posted`);

        // alpha is idle: the message waits for its next prompt. The watcher must not deliver
        // the same file a second time.
        const idle = await call("POST", `/sessions/${summary.dir}/inbox`, {
            from: "beta",
            to: "all",
            subject: "done",
            text: "all yours",
        });
        const idle_file = ((await idle.json()) as { file: string }).file;
        expect(idle_file).toMatch(/^\d{6}-beta-all\.md$/);
        expect(delivered().filter((event) => event.file === idle_file)).toEqual([
            expect.objectContaining({ agent: "alpha", how: "prompt" }),
        ]);
        expect(daemon.agents.pending_for(summary.dir, "alpha")).toHaveLength(1);
        await new Promise((resolve_) => setTimeout(resolve_, 300));
        expect(delivered().filter((event) => event.file === idle_file)).toHaveLength(1);

        // To the operator: a Log line and an inbox.message event.
        const op = await call("POST", `/sessions/${summary.dir}/inbox`, {
            from: "alpha",
            to: "operator",
            subject: "need the repo name",
            text: "which repo?",
        });
        expect(op.status).toBe(201);
        const text = readFileSync(join(summary.path, "MISSION.md"), "utf8");
        expect(text).toMatch(/- \d\d:\d\d alpha: → operator: need the repo name/);
        expect(events.some((event) => event.type === "inbox.message")).toBe(true);
        const logged = delivered().some((e) => e.agent === "operator" && e.how === "log");
        expect(logged).toBe(true);
    });

    it("delivers a file the operator writes by hand", async () => {
        const summary = create_session(home, { title: "Hand" });
        expect((await add_agent(summary.path, "alpha")).status).toBe(201);
        writeFileSync(join(summary.path, "inbox", "120000-operator-alpha.md"), "go\n\nstart now\n");
        await until(() => delivered().some((event) => event.file === "120000-operator-alpha.md"));
        const queued = daemon.agents.pending_for(summary.dir, "alpha")[0];
        expect(queued).toContain("Message from operator");
    });
});

describe("GET|PUT /sessions/:dir/agents/:name/context", () => {
    it("lists the chain with scopes, writes one file and reloads the running agent", async () => {
        const summary = create_session(home, { title: "Context" });
        expect((await add_agent(summary.path, "alpha")).status).toBe(201);
        const got = await call("GET", `/sessions/${summary.dir}/agents/alpha/context`);
        expect(got.status).toBe(200);
        const context = (await got.json()) as ContextResponse;
        expect(context.files.map((file) => file.scope)).toEqual(["user", "session"]);
        const session_file = context.files[1];
        expect(session_file).toMatchObject({
            path: join(summary.path, "AGENTS.md"),
            exists: true,
            tracked: false,
        });
        expect(session_file?.content).toContain("Spinner session");
        expect(context.commands).toEqual([
            {
                name: "spinner-reload",
                kind: "extension",
                path: "/fake/ext.ts",
                description: "Reload context",
            },
        ]);

        const outside = await call("PUT", `/sessions/${summary.dir}/agents/alpha/context`, {
            path: join(summary.path, "MISSION.md"),
            content: "x",
        });
        expect(outside.status).toBe(400);
        const put = await call("PUT", `/sessions/${summary.dir}/agents/alpha/context`, {
            path: session_file?.path,
            content: "# edited\n",
        });
        expect(put.status).toBe(200);
        const response = (await put.json()) as ContextFileResponse;
        expect(response.reloaded).toBe(true);
        expect(response.file.content).toBe("# edited\n");
        expect(readFileSync(join(summary.path, "AGENTS.md"), "utf8")).toBe("# edited\n");

        await call("POST", `/sessions/${summary.dir}/agents/alpha/stop`);
        await until(() => daemon.agents.get(summary.dir, "alpha") === null);
        const stopped = (await (
            await call("GET", `/sessions/${summary.dir}/agents/alpha/context`)
        ).json()) as ContextResponse;
        expect(stopped.commands).toEqual([]);
    });
});

describe("pure helpers", () => {
    it("parses inbox file names with hyphenated agent names", () => {
        const known = ["backend-api", "admin-ui"];
        expect(parse_inbox_file_name("114502-backend-api-admin-ui.md", known)).toEqual({
            from: "backend-api",
            to: "admin-ui",
        });
        expect(parse_inbox_file_name("114502-operator-all.md", [])).toEqual({
            from: "operator",
            to: "all",
        });
        expect(parse_inbox_file_name("114502-ext-ui-2.md", ["ext", "ui"])).toEqual({
            from: "ext",
            to: "ui",
        });
        expect(parse_inbox_file_name("notes.md", known)).toBeNull();
    });

    it("describes mission changes by section with counts", () => {
        const before = "# t\n\n## Roster\n| a |\n\n## Log\n- 1\n";
        const after =
            "# t\n\n## Roster\n| b |\n\n## Contracts & decisions\n- c\n\n## Log\n- 1\n- 2\n- 3\n";
        const changes = diff_mission(before, after);
        expect(describe_changes(changes, true)).toBe(
            "Roster (own row), Contracts & decisions (+1), Log (+2)",
        );
        expect(describe_changes(changes, false)).toBe(
            "Roster, Contracts & decisions (+1), Log (+2)",
        );
        expect(diff_mission(after, after)).toEqual([]);
    });

    it("plans the fixer's work by threads.autofix and renders the prompt and brief", () => {
        const thread = (label: string, kind: "bot" | "human", flagged: string | null = null) => ({
            id: `PRRT_${label}`,
            label,
            state: "open" as const,
            outdated: false,
            author: kind === "bot" ? "bot[bot]" : "alice",
            author_kind: kind,
            path: "src/a.ts",
            line: 3,
            body: `fix ${label}\nmore`,
            replies: [],
            replied: false,
            flagged,
        });
        const threads: ThreadsView = {
            session: "s1",
            rendered: null,
            prs: [
                {
                    repo: "api",
                    number: 7,
                    url: "u",
                    head: "h",
                    checks: "green",
                    review: "none",
                    open_bot: 2,
                    open_human: 1,
                    resolved: 0,
                    flagged: 1,
                    file: "threads/api-7.md",
                    threads: [
                        thread("T1", "bot"),
                        thread("T2", "human"),
                        thread("T3", "bot", "design"),
                    ],
                },
            ],
        };
        const bots: PipelineConfig = PIPELINE_CONFIG_DEFAULTS;
        const plan = plan_fixer_work(threads, bots);
        expect(plan.handled.map((entry) => entry.thread.label)).toEqual(["T1"]);
        expect(plan.left.map((entry) => entry.thread.label)).toEqual(["T2"]);
        const all: PipelineConfig = { ...bots, threads: { ...bots.threads, autofix: "all" } };
        expect(plan_fixer_work(threads, all).handled.map((entry) => entry.thread.label)).toEqual([
            "T1",
            "T2",
        ]);
        const summary = create_session(home, { title: "Fix" });
        const prompt = fixer_prompt(summary, plan, bots);
        expect(prompt).toContain("- api#7 T1 (bot, bot[bot]) · src/a.ts:3: fix T1");
        expect(prompt).toContain("Human threads the operator handles");
        expect(prompt).toContain("leave them open");
        expect(render_fixer_brief("s1", false)).toContain("`threads.resolve_human` is off");
        expect(existsSync(join(summary.path, "agents", "fixer"))).toBe(false);
    });
});
