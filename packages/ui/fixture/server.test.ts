// Starts the real fixture server on a free port and talks to it with a real WebSocket, so the
// test fails if the route constants or the event script stop matching what the UI expects.
import type { AddressInfo } from "node:net";

import { EVENTS_PATH, ROUTES, type SessionsResponse } from "@spinner/protocol";
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";

import { buildScript, SESSIONS } from "./data.ts";
import { startFixture } from "./server.ts";

const servers: ReturnType<typeof startFixture>[] = [];
afterEach(() => {
    for (const server of servers.splice(0)) {
        server.close();
    }
});

function start() {
    const server = startFixture(0);
    servers.push(server);
    return new Promise<number>((resolve) => {
        server.on("listening", () => resolve((server.address() as AddressInfo).port));
    });
}

it("serves GET /sessions", async () => {
    const port = await start();
    const path = "GET /sessions" in ROUTES ? "/sessions" : "";
    const body = (await (await fetch(`http://127.0.0.1:${port}${path}`)).json()) as SessionsResponse;
    expect(body.sessions.map((s) => s.dir)).toEqual(SESSIONS.map((s) => s.dir));
});

it("replays the first scripted event on /events", async () => {
    const port = await start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}${EVENTS_PATH}`);
    const first = await new Promise<string>((resolve, reject) => {
        socket.on("message", (data) => resolve(data.toString()));
        socket.on("error", reject);
    });
    socket.close();
    expect(JSON.parse(first).type).toBe(buildScript()[0]?.type);
});
