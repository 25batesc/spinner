// Starts the real fixture server on a free port and drives it with fetch and a real WebSocket,
// so the test fails if the routes or the job events stop matching API v1 as the UI uses it.
import type { AddressInfo } from "node:net";

import {
    EVENTS_PATH,
    OPERATOR_TTY_PATH,
    type JobResponse,
    type OperatorView,
    type SessionResponse,
    type SessionsResponse,
    type SpinnerEvent,
} from "@spinner/protocol";
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";

import { initialSessions } from "./data.ts";
import { startFixture } from "./server.ts";

const servers: ReturnType<typeof startFixture>[] = [];
afterEach(() => {
    for (const server of servers.splice(0)) {
        server.close();
        server.closeAllConnections();
    }
});

function start() {
    const server = startFixture(0);
    servers.push(server);
    return new Promise<number>((resolve) => {
        server.on("listening", () => resolve((server.address() as AddressInfo).port));
    });
}

it("serves GET /sessions as SessionViews", async () => {
    const port = await start();
    const response = await fetch(`http://127.0.0.1:${port}/sessions`);
    const body = (await response.json()) as SessionsResponse;
    expect(body.sessions.map((s) => s.summary.dir)).toEqual(
        initialSessions().map((s) => s.summary.dir),
    );
});

it("runs `up` as a job: 202, job.log lines, job.finished, then a healthy stack", async () => {
    const port = await start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}${EVENTS_PATH}`);
    await new Promise((resolve) => socket.on("open", resolve));
    const events: SpinnerEvent[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString()) as SpinnerEvent));

    const response = await fetch(`http://127.0.0.1:${port}/sessions/s001-bootstrap/up`, {
        method: "POST",
    });
    expect(response.status).toBe(202);
    const { job } = (await response.json()) as JobResponse;
    expect(job.action).toBe("up");

    await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
            if (events.some((e) => e.type === "job.finished")) {
                clearInterval(timer);
                resolve();
            }
        }, 50);
    });
    socket.close();
    const types = events.map((e) => e.type);
    expect(types).toContain("job.log");
    expect(types.at(-1)).toBe("job.finished");
    const updated = events.filter((e) => e.type === "session.updated");
    const last = updated.at(-1);
    expect(last?.type === "session.updated" && last.data.stack.state).toBe("up");
});

it("DELETE /sessions/:dir/verify clears the tick, answers the view, 404 without one", async () => {
    const port = await start();
    const base = `http://127.0.0.1:${port}/sessions/s17-refund-flow`;
    const socket = new WebSocket(`ws://127.0.0.1:${port}${EVENTS_PATH}`);
    await new Promise((resolve) => socket.on("open", resolve));
    const events: SpinnerEvent[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString()) as SpinnerEvent));
    const ticked = (await (await fetch(`${base}/verify`, { method: "POST" })).json()) as
        JobResponse;
    expect(ticked.job.action).toBe("verify");
    await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
            if (events.some((e) => e.type === "job.finished")) {
                clearInterval(timer);
                resolve();
            }
        }, 50);
    });
    const before = (await (await fetch(base)).json()) as SessionResponse;
    expect(before.session.summary.session.pipeline?.verified_locally).toBe(true);

    const response = await fetch(`${base}/verify`, { method: "DELETE" });
    expect(response.status).toBe(200);
    const cleared = (await response.json()) as SessionResponse;
    expect(cleared.session.summary.session.pipeline?.verified_locally).toBe(false);
    expect(cleared.session.summary.session.pipeline?.verified_by).toBeUndefined();
    const after = (await (await fetch(base)).json()) as SessionResponse;
    expect(after.session.summary.session.pipeline?.verified_locally).toBe(false);
    const updated = events.filter((e) => e.type === "session.updated").at(-1);
    expect(updated?.type === "session.updated" && updated.data.summary.session.pipeline)
        .toMatchObject({ verified_locally: false });
    socket.close();

    const missing = await fetch(`http://127.0.0.1:${port}/sessions/nope/verify`, {
        method: "DELETE",
    });
    expect(missing.status).toBe(404);
});

it("refuses post and approve without confirm and runs them with it", async () => {
    const port = await start();
    const base = `http://127.0.0.1:${port}/sessions/s17-refund-flow`;
    const send = (route: string, body: unknown) =>
        fetch(`${base}/${route}`, { method: "POST", body: JSON.stringify(body) });
    expect((await send("post", {})).status).toBe(400);
    expect((await send("approve", {})).status).toBe(400);
    expect((await send("post", { confirm: true })).status).toBe(202);
    const preview = (await (await fetch(`${base}/post`)).json()) as { post: { text: string } };
    expect(preview.post.text).toContain("web#412");
});

it("rewrites one mission section and keeps the rest", async () => {
    const port = await start();
    const base = `http://127.0.0.1:${port}/sessions/s17-refund-flow/mission`;
    await fetch(`${base}/section`, {
        method: "PUT",
        body: JSON.stringify({
            section: "goal", mode: "replace", text: "New goal.", author: "operator",
        }),
    });
    const text = await (await fetch(base)).text();
    expect(text).toContain("## Goal\nNew goal.\n\n## Done when");
    expect(text).toContain("refund button works");
});

it("hosts the operator agent: GET /operator, its tty, stop closes the pty, start", async () => {
    const port = await start();
    const base = `http://127.0.0.1:${port}/operator`;
    const read = async () =>
        ((await (await fetch(base)).json()) as { operator: OperatorView }).operator;
    const first = await read();
    expect(first.process).toBe("idle");
    expect(first.last_notice?.text).toContain("s17-refund-flow: ");
    const socket = new WebSocket(`ws://127.0.0.1:${port}${EVENTS_PATH}`);
    await new Promise((resolve) => socket.on("open", resolve));
    const events: SpinnerEvent[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString()) as SpinnerEvent));

    const tty = new WebSocket(`ws://127.0.0.1:${port}${OPERATOR_TTY_PATH}`);
    const frames: string[] = [];
    tty.on("message", (data) => frames.push(data.toString()));
    await new Promise((resolve) => tty.on("open", resolve));
    await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
            if (frames.some((f) => f.includes("Spinner fixture pty for operator"))) {
                clearInterval(timer);
                resolve();
            }
        }, 20);
    });
    const closed = new Promise<number>((resolve) => tty.on("close", resolve));
    const stopped = await fetch(`${base}/stop`, { method: "POST" });
    expect(stopped.status).toBe(200);
    const view = ((await stopped.json()) as { operator: OperatorView }).operator;
    expect(view).toMatchObject({ process: "exited", pid: null, waiting_on: "start" });
    expect(await closed).toBe(1000);
    expect(frames.at(-1)).toBe(JSON.stringify({ exit: { code: 0 } }));
    expect((await read()).process).toBe("exited");
    expect((await fetch(`${base}/stop`, { method: "POST" })).status).toBe(409);

    const refused = new WebSocket(`ws://127.0.0.1:${port}${OPERATOR_TTY_PATH}`);
    const failure = await new Promise<Error>((resolve) => refused.on("error", resolve));
    expect(failure.message).toContain("404");

    const started = await fetch(`${base}/start`, { method: "POST" });
    expect(started.status).toBe(200);
    expect(await read()).toMatchObject({ process: "idle", waiting_on: "operator" });
    expect((await fetch(`${base}/start`, { method: "POST" })).status).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.close();
    const updates = events.filter((e) => e.type === "operator.updated");
    expect(updates.map((e) => e.type === "operator.updated" && e.data.process)).toEqual([
        "exited", "idle",
    ]);
});

it("diff/start is a `diff` job: fetch, then each viewer runs; stop is synchronous", async () => {
    const port = await start();
    const base = `http://127.0.0.1:${port}/sessions/s17-refund-flow`;
    const socket = new WebSocket(`ws://127.0.0.1:${port}${EVENTS_PATH}`);
    await new Promise((resolve) => socket.on("open", resolve));
    const events: SpinnerEvent[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString()) as SpinnerEvent));
    const before = (await (await fetch(base)).json()) as SessionResponse;
    expect(before.session.diff).toMatchObject({ fetch: "absent", available: false });
    expect(Object.keys(before.session.diff?.repos ?? {})).toEqual(["web", "api"]);

    const response = await fetch(`${base}/diff/start`, { method: "POST" });
    expect(response.status).toBe(202);
    const { job } = (await response.json()) as JobResponse;
    expect(job.action).toBe("diff");
    await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
            if (events.some((e) => e.type === "job.finished")) {
                clearInterval(timer);
                resolve();
            }
        }, 50);
    });
    const lines = events.flatMap((e) => (e.type === "job.log" ? [e.line] : []));
    expect(lines).toEqual([
        "cloning diff-viewer", "cloning peanut", "npm install", "starting web", "starting api",
        "viewers up",
    ]);
    const running = (await (await fetch(base)).json()) as SessionResponse;
    expect(running.session.diff).toMatchObject({ fetch: "ready", available: true });
    const web = running.session.diff?.repos["web"];
    expect(web?.state).toBe("running");
    expect(web?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/diffview\/web\/$/);
    const page = await fetch(web?.url ?? "");
    expect(await page.text()).toContain("repo web");

    const unknown = await fetch(`${base}/diff/stop`, {
        method: "POST", body: JSON.stringify({ repo: "nope" }),
    });
    expect(unknown.status).toBe(404);
    const stopped = await fetch(`${base}/diff/stop`, {
        method: "POST", body: JSON.stringify({ repo: "web" }),
    });
    expect(stopped.status).toBe(200);
    const after = (await stopped.json()) as SessionResponse;
    expect(after.session.diff?.repos["web"]?.state).toBe("stopped");
    expect(after.session.diff?.repos["api"]?.state).toBe("running");
    expect(after.session.diff?.fetch).toBe("ready");
    socket.close();
});
