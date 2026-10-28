// Starts the real fixture server on a free port and drives it with fetch and a real WebSocket,
// so the test fails if the routes or the job events stop matching API v1 as the UI uses it.
import type { AddressInfo } from "node:net";

import {
    EVENTS_PATH,
    type JobResponse,
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
