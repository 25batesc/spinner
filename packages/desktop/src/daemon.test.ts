// Goal: the link connects to a daemon that answers, starts one when none does and waits for
// it, reports `down` when the wait runs out, and never starts a daemon after a loss. Method:
// scripted probes, a counted start, and a sleep that only records its calls.
import { describe, expect, it } from "vitest";
import type { BuildInfo, DaemonStatus } from "@spinner/protocol";
import { DaemonLink, probe_health } from "./daemon.js";

const build: BuildInfo = { version: "0.0.0", commit: "abc1234", built: null };

function link(answers: Array<BuildInfo | null>) {
    const calls: string[] = [];
    const states: string[] = [];
    const instance = new DaemonLink({
        url: "http://localhost:7777",
        probe: () => {
            calls.push("probe");
            return Promise.resolve(answers.shift() ?? null);
        },
        start: () => {
            calls.push("start");
            return Promise.resolve();
        },
        sleep: (ms) => {
            calls.push(`sleep ${ms}`);
            return Promise.resolve();
        },
        start_wait_ms: 1000,
        start_poll_ms: 500,
    });
    instance.subscribe((status: DaemonStatus) => states.push(status.state));
    return { instance, calls, states };
}

describe("DaemonLink.ensure", () => {
    it("connects without starting when the daemon answers", async () => {
        const { instance, calls, states } = link([build]);
        const status = await instance.ensure();
        expect(status).toEqual({ url: "http://localhost:7777", state: "connected", build });
        expect(calls).toEqual(["probe"]);
        expect(states).toEqual(["connected"]);
    });

    it("starts a daemon and polls until it answers", async () => {
        const { instance, calls, states } = link([null, null, build]);
        const status = await instance.ensure();
        expect(status.state).toBe("connected");
        expect(calls).toEqual(["probe", "start", "probe", "sleep 500", "probe"]);
        expect(states).toEqual(["starting", "connected"]);
    });

    it("gives up as down when the wait runs out", async () => {
        const { instance, calls, states } = link([]);
        const status = await instance.ensure();
        expect(status.state).toBe("down");
        // One probe before the start, then wait / poll = 2 polls.
        expect(calls.filter((c) => c === "probe")).toHaveLength(3);
        expect(states).toEqual(["starting", "down"]);
    });

    it("is down when the start command throws", async () => {
        const instance = new DaemonLink({
            url: "http://localhost:7777",
            probe: () => Promise.resolve(null),
            start: () => Promise.reject(new Error("no node")),
            sleep: () => Promise.resolve(),
        });
        await expect(instance.ensure()).rejects.toThrow("no node");
        expect(instance.status().state).toBe("down");
    });
});

describe("DaemonLink after a loss", () => {
    it("moves to down on lost() and check() never starts a daemon", async () => {
        const { instance, calls, states } = link([build, null, build]);
        await instance.ensure();
        instance.lost();
        expect(instance.status().state).toBe("down");
        await instance.check();
        await instance.check();
        expect(instance.status().state).toBe("connected");
        expect(calls).not.toContain("start");
        expect(states).toEqual(["connected", "down", "connected"]);
    });

    it("notifies only on a change", async () => {
        const { instance, states } = link([build, build]);
        await instance.check();
        await instance.check();
        expect(states).toEqual(["connected"]);
        instance.lost();
        instance.lost();
        expect(states).toEqual(["connected", "down"]);
    });
});

describe("probe_health", () => {
    const ok_fetch = (body: unknown, ok = true) =>
        (() =>
            Promise.resolve({ ok, json: () => Promise.resolve(body) })) as unknown as typeof fetch;

    it("returns the build of a healthy daemon", async () => {
        const result = await probe_health("http://x", ok_fetch({ ok: true, build }));
        expect(result).toEqual(build);
    });

    it("is null on a refused connection, a non-2xx, or a body without ok", async () => {
        const refused = (() =>
            Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
        expect(await probe_health("http://x", refused)).toBeNull();
        expect(await probe_health("http://x", ok_fetch({ ok: true, build }, false))).toBeNull();
        expect(await probe_health("http://x", ok_fetch({ hello: 1 }))).toBeNull();
    });
});
