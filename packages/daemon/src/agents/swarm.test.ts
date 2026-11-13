// Goal: the swarm and the manager keep one pi per agent and a running reviewer's record true.
// `add` refuses a second start of an agent whose pi is still spawning; a restart's `prime`
// leaves a reviewer that `adopt_all` resumed reading, so its verdict lands instead of a
// `failed` record (dogfood #59b). Method: an in-memory harness that counts its spawns and
// emits pi's events on demand, and a temporary home.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PiCommand, PiEvent, SessionSummary, Settings } from "@spinner/protocol";
import { EventBus } from "../event-bus.js";
import { resolve_home, type SpinnerHome } from "../home.js";
import { create_session, read_session, write_session } from "../store/session-store.js";
import type { AgentHandle, AgentHarness, AgentSpawnSpec } from "./harness.js";
import { AgentManager } from "./manager.js";
import { ReviewSwarm, reviewer_name, verdict_file } from "./swarm.js";

const MODEL = "anthropic/claude-opus-5-5";
const REVIEWER = reviewer_name(MODEL, "backend", false);
const SETTINGS: Settings = { theme: "system", review: { models: [MODEL], n: 1 } };

let home: SpinnerHome;

/** A pi that answers every command and emits the events the test hands it. */
class FakeHandle implements AgentHandle {
    readonly exited: Promise<number | null>;
    private readonly listeners: ((event: PiEvent) => void)[] = [];
    private finish: (code: number | null) => void = () => undefined;

    constructor(
        readonly pid: number,
        readonly pi_session_id: string,
    ) {
        this.exited = new Promise((resolve) => {
            this.finish = resolve;
        });
    }

    prompt(): Promise<string> {
        return Promise.resolve("started");
    }

    steer(): Promise<string> {
        return Promise.resolve("queued");
    }

    abort(): Promise<void> {
        return Promise.resolve();
    }

    compact(): Promise<string> {
        return Promise.resolve("started");
    }

    commands(): Promise<PiCommand[]> {
        return Promise.resolve([]);
    }

    on_event(listener: (event: PiEvent) => void): () => void {
        this.listeners.push(listener);
        return () => undefined;
    }

    stop(): Promise<number | null> {
        this.finish(0);
        return this.exited;
    }

    emit(event: PiEvent): void {
        for (const listener of this.listeners) {
            listener(event);
        }
    }
}

/** Records each spawn as `dir/name` and answers after a timer, as a real pi start does. */
class FakeHarness implements AgentHarness {
    readonly spawned: string[] = [];
    readonly handles: FakeHandle[] = [];

    async spawn(session: SessionSummary, agent: AgentSpawnSpec): Promise<AgentHandle> {
        this.spawned.push(`${session.dir}/${agent.name}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const handle = new FakeHandle(90_000 + this.handles.length, agent.name);
        this.handles.push(handle);
        return handle;
    }

    resume(session: SessionSummary, agent: AgentSpawnSpec): Promise<AgentHandle> {
        return this.spawn(session, agent);
    }
}

/** A session with one open PR on the repo `backend` and its worktree. */
function pr_session(title: string): SessionSummary {
    const summary = create_session(home, { title });
    summary.session.repos = {
        backend: {
            path: "~/code/backend",
            worktree: "worktrees/backend",
            changed: false,
            pr: {
                number: 412,
                url: "https://github.com/acme/backend/pull/412",
                author: "owner-1",
                state: "open",
                head: "9f3c1e2",
                checks: "green",
                approval_check: "pending",
                approvals: { required: ["peer"], peer: [], owner: false },
                threads: { bots_open: 0, humans_open: 0, resolved: 0 },
                review: "none",
                bot_reviewed_head: "9f3c1e2",
                queue: "none",
                last_activity: "2026-10-27T00:00:00Z",
            },
        },
    };
    write_session(summary);
    return summary;
}

function session_of(dir: string): SessionSummary {
    const read = read_session(home, dir);
    if (!read.ok) {
        throw new Error(read.error);
    }
    return read.summary;
}

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

beforeEach(() => {
    home = resolve_home({ SPINNER_HOME: mkdtempSync(join(tmpdir(), "spinner-swarm-unit-")) });
});

afterEach(() => {
    rmSync(home.root, { recursive: true, force: true });
});

describe("one pi per agent (dogfood #59b)", () => {
    it("add refuses a second start of an agent whose pi is still spawning", async () => {
        const harness = new FakeHarness();
        const agents = new AgentManager(home, { default: "rpc", rpc: harness }, new EventBus());
        const summary = pr_session("Twice");

        const results = await Promise.allSettled([
            agents.add(summary, { name: "backend" }),
            agents.add(summary, { name: "backend" }),
        ]);

        expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
        const refused = results[1];
        expect(refused?.status === "rejected" && String(refused.reason)).toMatch(
            /already running/,
        );
        expect(harness.spawned).toEqual([`${summary.dir}/backend`]);
        expect(agents.running(summary.dir)).toEqual(["backend"]);
        await agents.stop_all();
    });

    it("prime leaves a reviewer that adopt_all resumed reading; its verdict lands", async () => {
        const harness = new FakeHarness();
        const bus = new EventBus();
        const agents = new AgentManager(home, { default: "tty", tty: harness }, bus);
        const swarm = new ReviewSwarm({
            home,
            agents,
            bus,
            settings: () => SETTINGS,
            log: () => undefined,
            skill_default: join(home.root, "no-skill"),
        });
        // What the previous daemon left: the reviewer listed as a running tty agent while its
        // swarm record says `queued`, the state s059 and s060 were in at the restart.
        const summary = pr_session("Restarted");
        summary.session.agents = {
            [REVIEWER]: { harness: "tty", model: "default", process: "idle" },
        };
        const record = { model: MODEL, pr: "backend", state: "queued" as const };
        summary.session.review = { swarm: { [REVIEWER]: record } };
        write_session(summary);

        expect(await agents.adopt_all()).toEqual([`${summary.dir}/${REVIEWER}`]);
        await swarm.prime();

        expect(harness.spawned).toEqual([`${summary.dir}/${REVIEWER}`]);
        expect(session_of(summary.dir).session.review?.swarm[REVIEWER]).toEqual({
            model: MODEL,
            pr: "backend",
            state: "reading",
        });
        const handle = harness.handles[0];
        expect(handle).toBeDefined();
        const message = { role: "assistant", content: "No findings.\nVERDICT: CLEAR" };
        handle?.emit({ type: "turn_end", message, toolResults: [] });
        handle?.emit({ type: "agent_settled", aborted: false });
        const state = (): string | undefined =>
            session_of(summary.dir).session.review?.swarm[REVIEWER]?.state;
        await until(() => state() === "done");
        expect(existsSync(join(summary.path, verdict_file(MODEL)))).toBe(true);
        swarm.close();
        await agents.stop_all();
    });
});
