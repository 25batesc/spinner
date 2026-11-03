// Goal: the Goldfish watcher reads pi-subagents' files as docs/designs/egm-adoption.md, entry
// 4.5, says: a documented `status.json` parses, missing step fields get their defaults, each
// status word maps to its chip state, `read_runs` keeps the newest 200 runs, each run's design
// step is written once, `live_count` sums two sessions, and the poll timer stops after the
// settle window. Also the two shapes pi-subagents 0.84.0 writes beyond the entry: a workflow
// run whose steps are their own child runs shows each Goldfish once, and a foreground run
// (only `subagent-artifacts/`) shows as running, done, or stopped once the lead's turn ended.
// Method: real files in a scratch home made by `create_session`; the lead's busy flag is a
// stub `is_busy`, the clock is a fake `now`, and the timer is driven by `tick` calls.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DesignStage, SessionSummary } from "@spinner/protocol";
import { GOLDFISH_RUNS_MAX, GOLDFISH_SETTLE_POLL_MS } from "@spinner/protocol";
import { EventBus } from "../event-bus.js";
import { resolve_home, type SpinnerHome } from "../home.js";
import { create_session, write_session } from "../store/session-store.js";
import {
    attribute_runs,
    chip_state,
    child_key,
    GoldfishWatcher,
    parse_status,
    read_attributions,
    read_runs,
    session_runs,
} from "./goldfish.js";

let root: string;
let home: SpinnerHome;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "spinner-goldfish-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home") });
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

/** A status file in the documented shape (`docs/observability.md`), one step per agent. */
function status(run: string, state: string, steps: Record<string, unknown>[]): unknown {
    return {
        lifecycleArtifactVersion: 3,
        runId: run,
        mode: "single",
        state,
        startedAt: 1000,
        steps,
    };
}

function write_run(session: string, run: string, json: unknown, mtime_s = 1000): void {
    const dir = join(session, "egm-runs", "async-subagent-runs", run);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status.json"), JSON.stringify(json));
    utimesSync(dir, mtime_s, mtime_s);
}

function session_with(stage: DesignStage): SessionSummary {
    const summary = create_session(home, { title: `CSV ${stage}` });
    summary.session.design = { track: "design", stage };
    write_session(summary);
    return summary;
}

describe("parse_status", () => {
    it("reads a documented status file with one step", () => {
        const step = {
            agent: "egm-zoom-out",
            status: "running",
            model: "anthropic/claude",
            tokens: { input: 10, output: 90, total: 100 },
            startedAt: 1001,
            lastActivityAt: 1500,
            sessionFile: "/s/agents/lead/pi/x/run-0/session.jsonl",
        };
        expect(parse_status(status("r-1", "running", [step]))).toEqual({
            run: "r-1",
            state: "running",
            started: 1000,
            foreground: false,
            steps: [
                {
                    index: 0,
                    agent: "egm-zoom-out",
                    status: "running",
                    model: "anthropic/claude",
                    tokens: 100,
                    started: 1001,
                    last_activity: 1500,
                    session_file: "/s/agents/lead/pi/x/run-0/session.jsonl",
                    child_run: null,
                },
            ],
        });
    });

    it("gives a bare step the defaults; refuses a file without runId or steps", () => {
        const parsed = parse_status({ id: "r-2", steps: [{}] });
        expect(parsed?.run).toBe("r-2");
        expect(parsed?.state).toBe("");
        expect(parsed?.steps[0]).toEqual({
            index: 0,
            agent: "",
            status: "",
            model: null,
            tokens: 0,
            started: null,
            last_activity: null,
            session_file: null,
            child_run: null,
        });
        expect(parse_status({ steps: [] })).toBeNull();
        expect(parse_status({ runId: "r-3" })).toBeNull();
        expect(parse_status("text")).toBeNull();
    });
});

describe("chip_state", () => {
    it("maps each pi-subagents word, and an unknown word by the run's state", () => {
        const table: [string, string, string][] = [
            ["queued", "running", "queued"],
            ["pending", "running", "queued"],
            ["running", "complete", "running"],
            ["complete", "complete", "done"],
            ["completed", "running", "done"],
            ["failed", "failed", "failed"],
            ["rejected", "complete", "failed"],
            ["stopped", "stopped", "stopped"],
            ["paused", "running", "stopped"],
            ["launching", "running", "running"],
            ["launching", "complete", "failed"],
            ["", "", "failed"],
        ];
        for (const [word, run_state, expected] of table) {
            expect(chip_state(word, run_state), `${word} in ${run_state}`).toBe(expected);
        }
        expect(child_key("r-1", 2)).toBe("r-1/2");
    });
});

describe("read_runs", () => {
    it("keeps the newest 200 run directories and skips unreadable files", () => {
        const session = join(root, "s");
        for (let index = 0; index < GOLDFISH_RUNS_MAX + 5; index += 1) {
            const run = `run-${String(index).padStart(3, "0")}`;
            const json = {
                ...(status(run, "complete", [{ agent: "egm-style" }]) as object),
                startedAt: index,
            };
            write_run(session, run, json, 1000 + index);
        }
        const broken = join(session, "egm-runs", "async-subagent-runs", "broken");
        mkdirSync(broken, { recursive: true });
        writeFileSync(join(broken, "status.json"), "{ not json");
        utimesSync(broken, 5000, 5000);
        const runs = read_runs(join(session, "egm-runs"));
        expect(runs).toHaveLength(GOLDFISH_RUNS_MAX - 1);
        expect(runs[0]?.run).toBe("run-204");
        expect(runs.some((run) => run.run === "run-005")).toBe(false);
        expect(read_runs(join(root, "absent", "egm-runs"))).toEqual([]);
    });

    it("shows each Goldfish of a workflow run once, under its own child run", () => {
        const session = join(root, "s");
        const steps = ["c-1", "c-2"].map((child) => ({
            agent: "egm-design",
            status: "completed",
            runId: child,
        }));
        write_run(session, "w-1", { runId: "w-1", mode: "workflow", state: "complete", steps });
        write_run(
            session,
            "c-1",
            status("c-1", "complete", [{ agent: "egm-design", status: "complete" }]),
        );
        const runs = read_runs(join(session, "egm-runs"));
        const ids = runs.flatMap((run) => run.steps.map((step) => child_key(run.run, step.index)));
        // c-2 has no directory yet, so the workflow's step 1 stands for it.
        expect(ids.sort()).toEqual(["c-1/0", "w-1/1"]);
    });

    it("reads a foreground run from the lead's artifacts: running, then done", () => {
        const summary = session_with("brainstorm");
        const pi = join(summary.path, "agents", "lead", "pi");
        const artifacts = join(pi, "subagent-artifacts");
        mkdirSync(artifacts, { recursive: true });
        const run = "59746629-755b-4973-b0ec-284528ff557f";
        writeFileSync(join(artifacts, `${run}_egm-zoom-out_0_transcript.jsonl`), "{}\n");
        const child = join(pi, "2026-11-03T01-39-57-647Z_lead", run, "run-0");
        mkdirSync(child, { recursive: true });
        writeFileSync(join(child, "session.jsonl"), "{}\n");
        let runs = session_runs(summary.path, true);
        expect(runs).toHaveLength(1);
        expect(runs[0]?.foreground).toBe(true);
        expect(runs[0]?.steps[0]?.agent).toBe("egm-zoom-out");
        expect(runs[0]?.steps[0]?.session_file).toBe(join(child, "session.jsonl"));
        expect(chip_state(runs[0]?.steps[0]?.status ?? "", runs[0]?.state ?? "")).toBe("running");
        // The lead's turn ended without the meta file: the step must not count as live.
        runs = session_runs(summary.path, false);
        expect(chip_state(runs[0]?.steps[0]?.status ?? "", runs[0]?.state ?? "")).toBe("stopped");
        const meta = { runId: run, exitCode: 0, model: "m/x", usage: { input: 5, output: 7 } };
        writeFileSync(join(artifacts, `${run}_egm-zoom-out_0_meta.json`), JSON.stringify(meta));
        runs = session_runs(summary.path, false);
        expect(runs[0]?.steps[0]).toMatchObject({ status: "complete", model: "m/x", tokens: 12 });
    });

    it("skips the artifacts of an async run, which its status file already shows", () => {
        const summary = session_with("brainstorm");
        const run = "aa5e8c51-7f3b-460b-aef8-c493dea09ea3";
        write_run(summary.path, run, status(run, "complete", [{ agent: "egm-zoom-out" }]));
        const artifacts = join(summary.path, "agents", "lead", "pi", "subagent-artifacts");
        mkdirSync(artifacts, { recursive: true });
        writeFileSync(join(artifacts, `${run}_egm-zoom-out_0_transcript.jsonl`), "{}\n");
        const runs = session_runs(summary.path, true);
        expect(runs.map((entry) => [entry.run, entry.foreground])).toEqual([[run, false]]);
    });
});

describe("step attribution", () => {
    it("writes each run's design step once, at its first sight", () => {
        const summary = session_with("brainstorm");
        write_run(summary.path, "r-1", status("r-1", "running", [{ agent: "egm-design" }]));
        expect(attribute_runs(summary.path, session_runs(summary.path, true), "brainstorm")).toBe(
            true,
        );
        write_run(summary.path, "r-2", status("r-2", "running", [{ agent: "egm-style" }]));
        // The stage moved on: r-1 keeps brainstorm, r-2 gets review.
        expect(attribute_runs(summary.path, session_runs(summary.path, true), "review")).toBe(true);
        expect(attribute_runs(summary.path, session_runs(summary.path, true), "review")).toBe(
            false,
        );
        expect(read_attributions(summary.path)).toEqual({ "r-1": "brainstorm", "r-2": "review" });
        const file = join(summary.path, "egm-runs", "runs.json");
        expect(Object.keys(JSON.parse(readFileSync(file, "utf8")) as object)).toEqual([
            "r-1",
            "r-2",
        ]);
    });
});

describe("GoldfishWatcher", () => {
    function watcher_with(
        busy: Set<string>,
        clock: { now: number },
        changes: string[],
    ): GoldfishWatcher {
        return new GoldfishWatcher({
            home,
            agents: { is_busy: (dir) => busy.has(dir) },
            bus: new EventBus(),
            on_change: async (dir) => {
                changes.push(dir);
            },
            log: () => undefined,
            now: () => clock.now,
        });
    }

    it("counts the running Goldfish of two sessions and attributes their runs", async () => {
        const a = session_with("brainstorm");
        const b = session_with("design-review");
        write_run(
            a.path,
            "a-1",
            status("a-1", "running", [{ agent: "egm-design", status: "running" }]),
        );
        const two = [
            { agent: "egm-style", status: "running" },
            { agent: "egm-critic", status: "queued" },
        ];
        write_run(b.path, "b-1", status("b-1", "running", two));
        const changes: string[] = [];
        const watcher = watcher_with(new Set([a.dir, b.dir]), { now: 0 }, changes);
        watcher.wake(a.dir);
        watcher.wake(b.dir);
        await watcher.tick(a.dir);
        await watcher.tick(b.dir);
        expect(watcher.live_count()).toBe(2);
        expect(read_attributions(a.path)).toEqual({ "a-1": "brainstorm" });
        expect(read_attributions(b.path)).toEqual({ "b-1": "review" });
        // The first tick of each session saw a change; the repeated ticks saw none.
        expect(changes.sort()).toEqual([a.dir, b.dir]);
        watcher.close();
        expect(watcher.live_count()).toBe(0);
    });

    it("stops the timer: lead idle, nothing running, settle window over", async () => {
        const summary = session_with("brainstorm");
        write_run(
            summary.path,
            "r-1",
            status("r-1", "complete", [{ agent: "egm-design", status: "complete" }]),
        );
        const clock = { now: 100_000 };
        const busy = new Set([summary.dir]);
        const bus = new EventBus();
        const watcher = new GoldfishWatcher({
            home,
            agents: { is_busy: (dir) => busy.has(dir) },
            bus,
            on_change: async () => undefined,
            log: () => undefined,
            now: () => clock.now,
        });
        const ts = new Date().toISOString();
        bus.publish({ type: "agent.settled", ts, session: summary.dir, agent: "lead" });
        expect(watcher.watching(summary.dir)).toBe(true);
        busy.clear();
        clock.now += GOLDFISH_SETTLE_POLL_MS - 1;
        await watcher.tick(summary.dir);
        expect(watcher.watching(summary.dir)).toBe(true);
        clock.now += 2;
        await watcher.tick(summary.dir);
        expect(watcher.watching(summary.dir)).toBe(false);
        watcher.close();
    });
});
