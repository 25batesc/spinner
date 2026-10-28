// Goal: a job publishes exactly one job.started, one job.log per line and one job.finished;
// two jobs never run on the same session at once; an adopt job acquires its session once it
// names it; the log is bounded. Method: run work functions against a bus with a recording
// listener and no disk.
import { describe, expect, it } from "vitest";
import type { SpinnerEvent } from "@spinner/protocol";
import { EventBus } from "../event-bus.js";
import { JOB_LOG_LINES_MAX, JobRunner } from "./jobs.js";

function recorder(): { bus: EventBus; events: SpinnerEvent[] } {
    const bus = new EventBus();
    const events: SpinnerEvent[] = [];
    bus.subscribe((event) => events.push(event));
    return { bus, events };
}

function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 10));
}

describe("JobRunner", () => {
    it("runs a job to ok with started, log and finished events", async () => {
        const { bus, events } = recorder();
        const runner = new JobRunner(bus, { now: () => new Date("2026-10-28T13:00:00Z") });
        const job = runner.start("up", "s001-alpha", async (log) => {
            log("one");
            log("two\nthree");
        });
        expect(job.state).toBe("running");
        expect(job.id).toBe("j-1");
        await settle();
        expect(runner.get("j-1")?.state).toBe("ok");
        expect(runner.get("j-1")?.log).toEqual(["one", "two", "three"]);
        expect(events.map((event) => event.type)).toEqual([
            "job.started",
            "job.log",
            "job.log",
            "job.log",
            "job.finished",
        ]);
        const finished = events.at(-1);
        expect(finished).toMatchObject({ ok: true, session: "s001-alpha", job: "j-1" });
        expect(finished && "error" in finished).toBe(false);
        expect(runner.running_on("s001-alpha")).toBeNull();
    });

    it("records a failure and keeps the error on the job", async () => {
        const { bus, events } = recorder();
        const runner = new JobRunner(bus);
        runner.start("down", "s001-alpha", async () => {
            throw new Error("docker is not running");
        });
        await settle();
        expect(runner.get("j-1")).toMatchObject({
            state: "failed",
            error: "docker is not running",
        });
        expect(events.at(-1)).toMatchObject({
            type: "job.finished",
            ok: false,
            error: "docker is not running",
        });
    });

    it("refuses a second job on a busy session and allows one on another", async () => {
        const { bus } = recorder();
        const runner = new JobRunner(bus);
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));
        runner.start("up", "s001-alpha", () => gate);
        expect(() => runner.start("down", "s001-alpha", async () => undefined)).toThrow(
            /already has job j-1/,
        );
        expect(runner.start("up", "s002-beta", async () => undefined).id).toBe("j-2");
        release();
        await settle();
        expect(runner.start("down", "s001-alpha", async () => undefined).id).toBe("j-3");
    });

    it("an adopt job has no session until it names one, then owns it", async () => {
        const { bus, events } = recorder();
        const runner = new JobRunner(bus);
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const job = runner.start("adopt", null, async (log, set_session) => {
            set_session("s003-adopted");
            log("adopted");
            await gate;
        });
        expect(events[0]).toMatchObject({ type: "job.started", session: null });
        await settle();
        expect(job.session).toBe("s003-adopted");
        expect(runner.running_on("s003-adopted")).toBe("j-1");
        expect(events.find((event) => event.type === "job.log")).toMatchObject({
            session: "s003-adopted",
        });
        release();
        await settle();
        expect(events.at(-1)).toMatchObject({ type: "job.finished", session: "s003-adopted" });
    });

    it("recent() lists running jobs and the last finished ones, oldest first", async () => {
        const { bus } = recorder();
        const runner = new JobRunner(bus);
        for (let n = 0; n < 12; n += 1) {
            runner.start("down", `s${n}`, async () => undefined);
            await settle();
        }
        runner.start("up", "s-live", () => new Promise(() => undefined));
        const ids = runner.recent().map((job) => job.id);
        expect(ids).toHaveLength(11);
        expect(ids[0]).toBe("j-3");
        expect(ids.at(-1)).toBe("j-13");
        expect(runner.recent().at(-1)?.state).toBe("running");
    });

    it("bounds the log", async () => {
        const { bus } = recorder();
        const runner = new JobRunner(bus);
        runner.start("up", "s001-alpha", async (log) => {
            for (let line = 0; line < JOB_LOG_LINES_MAX + 10; line += 1) {
                log(`line ${line}`);
            }
        });
        await settle();
        const job = runner.get("j-1");
        expect(job?.log).toHaveLength(JOB_LOG_LINES_MAX + 1);
        expect(job?.log.at(-1)).toMatch(/truncated/);
    });
});
