// Goal: the harness starts pi with the session's flags (session dir, session id, model, the
// brief), the manager records the agent in session.yaml and turns pi's records into
// agent.spawned, agent.event, agent.settled and agent.exited, and a stopped agent resumes
// with the same transcript id. Method: a fake pi (test/fixtures/fake-pi.mjs) that speaks the
// RPC protocol without a model, a temporary home, and a recording bus.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session, SpinnerEvent } from "@spinner/protocol";
import { EventBus } from "../event-bus.js";
import { resolve_home, type SpinnerHome } from "../home.js";
import { create_session } from "../store/session-store.js";
import { PiRpcHarness, default_extension_path } from "./harness.js";
import { events_of_transcript } from "./history.js";
import { AgentManager, ensure_brief } from "./manager.js";
import { models_of } from "./models.js";
import { model_args, resolve_pi_binary, spawn_pi } from "./pi-rpc.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(here, "..", "..", "test", "fixtures", "fake-pi.ts");

let home: SpinnerHome;

interface Spawned {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
}

beforeEach(() => {
    chmodSync(FAKE_PI, 0o755);
    home = resolve_home({ SPINNER_HOME: mkdtempSync(join(tmpdir(), "spinner-agents-")) });
});

afterEach(() => {
    rmSync(home.root, { recursive: true, force: true });
});

function until(check: () => boolean): Promise<void> {
    return new Promise((resolve_, reject) => {
        let polls = 0;
        const timer = setInterval(() => {
            polls += 1;
            if (check()) {
                clearInterval(timer);
                resolve_();
            } else if (polls > 200) {
                clearInterval(timer);
                reject(new Error("condition not met in time"));
            }
        }, 10);
    });
}

describe("spawn_pi", () => {
    it("starts the child, answers commands and forwards events", async () => {
        const pi = await spawn_pi({
            pi: FAKE_PI,
            cwd: home.root,
            session_dir: join(home.root, "pi"),
            session_id: "t",
        });
        const events: string[] = [];
        pi.on_event((event) => events.push(event.type));
        const response = await pi.send({ type: "prompt", message: "hi" });
        expect(response.data).toEqual({ disposition: "started" });
        await until(() => events.includes("agent_settled"));
        expect(events).toEqual([
            "agent_start",
            "turn_start",
            "message_start",
            "message_update",
            "message_end",
            "turn_end",
            "agent_end",
            "agent_settled",
        ]);
        await expect(pi.send({ type: "prompt", message: "fail" })).rejects.toThrow("no");
        expect(await pi.stop()).toBe(0);
        await expect(pi.send({ type: "get_state" })).rejects.toThrow(/exited/);
    });

    it("model_args splits provider/model once; resolve_pi_binary honours SPINNER_PI", () => {
        expect(model_args(undefined)).toEqual([]);
        expect(model_args("sonnet")).toEqual(["--model", "sonnet"]);
        expect(model_args("openrouter/anthropic/claude-sonnet-4.5")).toEqual([
            "--provider",
            "openrouter",
            "--model",
            "anthropic/claude-sonnet-4.5",
        ]);
        expect(resolve_pi_binary({ SPINNER_PI: FAKE_PI })).toBe(FAKE_PI);
        expect(() => resolve_pi_binary({ SPINNER_PI: "/nope/pi" })).toThrow(/does not exist/);
        expect(() => resolve_pi_binary({ PATH: "/nope" })).toThrow(/not on PATH/);
    });

    it("models_of keeps the four picker fields", () => {
        const models = models_of({
            models: [{ provider: "a", id: "m", contextWindow: 10, reasoning: true, extra: 1 }, {}],
        });
        expect(models).toEqual([{ provider: "a", id: "m", contextWindow: 10, reasoning: true }]);
    });
});

describe("ensure_brief", () => {
    it("writes the default brief from the session, or the request's text, once", async () => {
        const summary = create_session(home, { title: "Briefs" });
        summary.session.repos = {
            backend: { path: "/code/backend", worktree: "worktrees/backend", changed: true },
            web: { path: "/code/web", changed: false },
        };
        summary.session.stack = { state: "down", hosts: { api: "api.s001.localhost" } };
        summary.session.agents = { other: { harness: "pi", model: "default", process: "idle" } };

        const path = ensure_brief(summary, { name: "backend-api", repo: "backend" });
        expect(path).toBe(join(summary.path, "agents", "backend-api", "BRIEF.md"));
        const brief = readFileSync(path, "utf8");
        expect(brief).toContain("# backend-api\n\nRole: engineer for session s001 (Briefs).");
        expect(brief).toContain("- `backend` (worktree `worktrees/backend`, branch `feat/briefs`)");
        expect(brief).toContain("- The other repos: `web`.");
        expect(brief).toContain("- What `other` owns (its Roster row).");
        expect(brief).toContain("- api: http://api.s001.localhost");
        expect(brief).toContain("1. Read `.spinner/MISSION.md` in full.");
        expect(brief).toContain("`HH:MM backend-api: <what>`");
        expect(brief).toContain("4. Put an API change under Contracts before you implement it.");
        expect(brief).toContain("## Finish");
        expect(brief).not.toContain("- `web` (");

        // Without a repo, every repo of the session is in Owns, and nothing is excluded by repo.
        const all = readFileSync(ensure_brief(summary, { name: "solo" }), "utf8");
        expect(all).toContain("- `backend` (worktree");
        expect(all).toContain("- `web` (no worktree yet, branch `feat/briefs`).");
        expect(all).not.toContain("The other repos");

        // The request's text wins over the default; an existing brief is never replaced.
        const own = ensure_brief(summary, { name: "custom", brief: "# custom\nDo X." });
        expect(readFileSync(own, "utf8")).toBe("# custom\nDo X.\n");
        ensure_brief(summary, { name: "custom", brief: "# other text" });
        expect(readFileSync(own, "utf8")).toBe("# custom\nDo X.\n");
        ensure_brief(summary, { name: "backend-api", brief: "# replaced?" });
        expect(readFileSync(path, "utf8")).toBe(brief);
        expect(() => ensure_brief(summary, { name: "blank", brief: "  " })).toThrow(/empty/);
    });
});

describe("AgentManager with PiRpcHarness", () => {
    it("adds an agent from its brief, records it, forwards events, resumes", async () => {
        const summary = create_session(home, { title: "Agents" });
        mkdirSync(join(summary.path, "agents", "backend"), { recursive: true });
        writeFileSync(join(summary.path, "agents", "backend", "BRIEF.md"), "# backend\n");
        const args_file = join(home.root, "args.json");
        process.env["FAKE_PI_ARGS_FILE"] = args_file;
        const bus = new EventBus();
        const events: SpinnerEvent[] = [];
        bus.subscribe((event) => events.push(event));
        const manager = new AgentManager(
            home,
            { default: "rpc", rpc: new PiRpcHarness({ pi: () => FAKE_PI }) },
            bus,
        );

        const no_worktree = manager.add(summary, { name: "nobody", repo: "zz" });
        await expect(no_worktree).rejects.toThrow(/no worktree for repo "zz"/);
        const handle = await manager.add(summary, { name: "backend", model: "anthropic/claude-x" });
        expect(manager.running(summary.dir)).toEqual(["backend"]);
        expect(handle.pi_session_id).toBe("backend");
        const spawned = JSON.parse(readFileSync(args_file, "utf8")) as Spawned;
        expect(realpathSync(spawned.cwd)).toBe(realpathSync(summary.path));
        expect(spawned.argv).toEqual([
            "--mode",
            "rpc",
            "--session-dir",
            join(summary.path, "agents", "backend", "pi"),
            "--session-id",
            "backend",
            "--provider",
            "anthropic",
            "--model",
            "claude-x",
            "--extension",
            default_extension_path(),
        ]);
        expect(spawned.env).toMatchObject({
            SPINNER_SESSION_DIR: summary.path,
            SPINNER_AGENT: "backend",
            SPINNER_ROLE: "worker",
        });
        const agents_file = readFileSync(join(summary.path, "AGENTS.md"), "utf8");
        expect(agents_file).toContain(`${summary.path}/MISSION.md`);
        await expect(manager.add(summary, { name: "backend" })).rejects.toThrow(/already running/);

        expect(await handle.prompt("hello")).toBe("started");
        await until(() => events.some((event) => event.type === "agent.settled"));
        const types = events.map((event) => event.type);
        expect(types[0]).toBe("agent.spawned");
        expect(types.filter((type) => type === "agent.event")).toHaveLength(8);
        const text = events.find(
            (event) => event.type === "agent.event" && event.event.type === "message_update",
        );
        expect(text).toMatchObject({
            agent: "backend",
            event: { assistantMessageEvent: { type: "text_delta", delta: "echo: hello" } },
        });
        const yaml = parse(readFileSync(join(summary.path, "session.yaml"), "utf8")) as Session;
        expect(yaml.agents["backend"]).toMatchObject({
            harness: "rpc",
            model: "anthropic/claude-x",
            process: "idle",
            pid: handle.pid,
        });
        expect(await handle.steer("more")).toBe("queued");
        await handle.abort();

        await manager.stop(summary.dir, "backend");
        await until(() => events.some((event) => event.type === "agent.exited"));
        expect(manager.running(summary.dir)).toEqual([]);
        const after = parse(readFileSync(join(summary.path, "session.yaml"), "utf8")) as Session;
        expect(after.agents["backend"]).toEqual({
            harness: "rpc",
            model: "anthropic/claude-x",
            process: "exited",
        });
        await expect(manager.stop(summary.dir, "backend")).rejects.toThrow(/not running/);

        // Resume: the model comes from session.yaml when the request names none.
        const resumed = await manager.add(summary, { name: "backend" });
        const again = JSON.parse(readFileSync(args_file, "utf8")) as { argv: string[] };
        expect(again.argv).toContain("claude-x");
        expect(again.argv).toContain("backend");
        await manager.stop_all();
        await resumed.exited;
        delete process.env["FAKE_PI_ARGS_FILE"];
    });

    it("appends the brief itself without an extension; the fixer gets its role", async () => {
        const summary = create_session(home, { title: "Plain" });
        mkdirSync(join(summary.path, "agents", "fixer"), { recursive: true });
        writeFileSync(join(summary.path, "agents", "fixer", "BRIEF.md"), "# fixer\n");
        const args_file = join(home.root, "args.json");
        process.env["FAKE_PI_ARGS_FILE"] = args_file;
        const harness = new PiRpcHarness({ pi: () => FAKE_PI, extension: null });
        const manager = new AgentManager(home, { default: "rpc", rpc: harness }, new EventBus());
        await manager.add(summary, { name: "fixer" });
        const spawned = JSON.parse(readFileSync(args_file, "utf8")) as Spawned;
        expect(spawned.argv).toContain("--append-system-prompt");
        expect(spawned.argv).not.toContain("--extension");
        expect(spawned.env["SPINNER_ROLE"]).toBe("fixer");
        await manager.stop_all();
        delete process.env["FAKE_PI_ARGS_FILE"];
    });

    it("applies settings.yaml: default_model and harness come before config.yaml", async () => {
        const summary = create_session(home, { title: "Settings" });
        mkdirSync(join(summary.path, "agents", "backend"), { recursive: true });
        writeFileSync(join(summary.path, "agents", "backend", "BRIEF.md"), "# backend\n");
        writeFileSync(
            join(home.root, "settings.yaml"),
            "theme: system\ndefault_model: openai/gpt-s\nagents:\n  harness: rpc\n",
        );
        const args_file = join(home.root, "args.json");
        process.env["FAKE_PI_ARGS_FILE"] = args_file;
        // Both names map to the fake harness; `session.yaml` records which name was chosen.
        const harness = new PiRpcHarness({ pi: () => FAKE_PI, default_model: "x/config" });
        const manager = new AgentManager(
            home,
            { default: "tty", tty: harness, rpc: harness },
            new EventBus(),
        );
        await manager.add(summary, { name: "backend" });
        const spawned = JSON.parse(readFileSync(args_file, "utf8")) as Spawned;
        expect(spawned.argv).toContain("gpt-s");
        expect(spawned.argv).not.toContain("config");
        const yaml = parse(readFileSync(join(summary.path, "session.yaml"), "utf8")) as Session;
        expect(yaml.agents["backend"]).toMatchObject({ harness: "rpc", model: "openai/gpt-s" });
        await manager.stop_all();

        // The request's model still wins over the setting.
        await manager.add(summary, { name: "backend", model: "anthropic/claude-r" });
        const again = JSON.parse(readFileSync(args_file, "utf8")) as Spawned;
        expect(again.argv).toContain("claude-r");
        await manager.stop_all();
        delete process.env["FAKE_PI_ARGS_FILE"];
    });
});

describe("events_of_transcript", () => {
    it("keeps user, assistant and toolResult messages as message_end, drops the rest", () => {
        const text = [
            JSON.stringify({ type: "session", version: 3 }),
            JSON.stringify({ type: "model_change", provider: "a" }),
            JSON.stringify({ type: "message", message: { role: "system", content: "s" } }),
            JSON.stringify({
                type: "message",
                message: { role: "user", content: "u", timestamp: 1 },
            }),
            "not json",
            "",
        ].join("\n");
        expect(events_of_transcript(text)).toEqual([
            { type: "message_end", message: { role: "user", content: "u", timestamp: 1 } },
        ]);
    });
});
