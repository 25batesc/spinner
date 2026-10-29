// Drives `connectTty` with Node's global WebSocket against the fixture's echo pty: the banner
// on attach, the echo of typed bytes, the resize frame, the scrollback replay for a second
// client, and the reconnect with its growing delay after the server drops the socket.
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { tty_path } from "@spinner/protocol";

import { startFixture } from "../fixture/server.ts";
import {
    connectTty,
    exitCodeOf,
    nextReconnectDelay,
    resizeFrame,
    ttyUrl,
    TTY_RECONNECT_MS_MAX,
    TTY_RECONNECT_MS_MIN,
    type TtyConnection,
    type TtyStatus,
} from "./tty-client.ts";

const servers: ReturnType<typeof startFixture>[] = [];
const connections: TtyConnection[] = [];
afterEach(() => {
    for (const connection of connections.splice(0)) {
        connection.close();
    }
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

const decoder = new TextDecoder();

/** A client whose output and statuses the test reads back as they arrive. */
function attach(port: number, agent = "backend") {
    const path = tty_path("s17-refund-flow", agent);
    const url = ttyUrl(path, { protocol: "http:", host: `127.0.0.1:${port}` });
    let output = "";
    const statuses: TtyStatus[] = [];
    const connection = connectTty(url, {
        onOutput: (bytes) => {
            output += decoder.decode(bytes);
        },
        onStatus: (status) => statuses.push(status),
    });
    connections.push(connection);
    return { connection, statuses, output: () => output };
}

async function until(check: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (check()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for ${label}`);
}

describe("the pure parts", () => {
    it("builds the socket URL from the page's origin and the agent route", () => {
        const path = tty_path("s1-a", "ui");
        expect(ttyUrl(path, { protocol: "http:", host: "localhost:5173" })).toBe(
            "ws://localhost:5173/sessions/s1-a/agents/ui/tty",
        );
        expect(ttyUrl(path, { protocol: "https:", host: "h" })).toBe(
            "wss://h/sessions/s1-a/agents/ui/tty",
        );
    });

    it("frames a resize as the one text frame, within the daemon's bounds", () => {
        expect(JSON.parse(resizeFrame(120, 40))).toEqual({ resize: { cols: 120, rows: 40 } });
        expect(JSON.parse(resizeFrame(0, 5000))).toEqual({ resize: { cols: 1, rows: 1000 } });
    });

    it("reads the exit frame and nothing else", () => {
        expect(exitCodeOf(JSON.stringify({ exit: { code: 0 } }))).toBe(0);
        expect(exitCodeOf(JSON.stringify({ exit: { code: null } }))).toBeNull();
        expect(exitCodeOf("{")).toBeUndefined();
        expect(exitCodeOf(JSON.stringify({ resize: { cols: 1, rows: 1 } }))).toBeUndefined();
    });

    it("doubles the delay from 1 s and stops at 30 s", () => {
        const delays = [TTY_RECONNECT_MS_MIN];
        for (let step = 0; step < 6; step += 1) {
            delays.push(nextReconnectDelay(delays[delays.length - 1] ?? 0));
        }
        expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
        expect(TTY_RECONNECT_MS_MAX).toBe(30000);
    });
});

describe("connectTty against the fixture pty", () => {
    it("sees the banner, the echo of typed bytes and the resize line", async () => {
        const port = await start();
        const client = attach(port);
        await until(() => client.statuses.some((s) => s.state === "open"), "open");
        await until(() => client.output().includes("fixture pty for backend"), "banner");
        client.connection.input("hello\r");
        await until(() => client.output().includes("hello\r\n$ "), "echo");
        client.connection.input(new Uint8Array([0x1b, 0x5b, 0x41]));
        await until(() => client.output().includes("^[[A"), "arrow key in caret notation");
        client.connection.resize(100, 30);
        await until(() => client.output().includes("[resize 100x30]"), "resize line");
    });

    it("replays the scrollback to a second client", async () => {
        const port = await start();
        const first = attach(port);
        await until(() => first.output().includes("$ "), "first banner");
        first.connection.input("typed before\r");
        await until(() => first.output().includes("typed before"), "echo");
        const second = attach(port);
        await until(() => second.output().includes("typed before\r\n$ "), "replayed echo");
        expect(second.output().startsWith("Spinner fixture pty for backend")).toBe(true);
    });

    it("refuses an agent that is not running", async () => {
        const port = await start();
        const client = attach(port, "frontend");
        await until(() => client.statuses.some((s) => s.state === "closed"), "closed");
        expect(client.statuses.at(-1)).toEqual({ state: "closed", retry_ms: 1000 });
    });

    it("reconnects after the server drops the socket and sends the size again", async () => {
        const port = await start();
        const client = attach(port);
        await until(() => client.statuses.some((s) => s.state === "open"), "open");
        client.connection.resize(90, 20);
        await until(() => client.output().includes("[resize 90x20]"), "first resize");
        for (const pty of servers[0]?.daemon.ptys.values() ?? []) {
            for (const client of pty.clients) {
                client.close();
            }
        }
        await until(() => client.statuses.some((s) => s.state === "closed"), "closed");
        expect(client.statuses.at(-1)).toEqual({ state: "closed", retry_ms: 1000 });
        await until(() => client.statuses.filter((s) => s.state === "open").length === 2, "reopen");
        // The second attach replays the scrollback (banner and one resize line, so the line
        // shows twice in the output) and then answers the re-sent size with a third one.
        await until(
            () => client.output().split("[resize 90x20]").length >= 4,
            "the size sent again after the reconnect",
        );
    }, 10_000);
});

describe("the exit frame", () => {
    it("shows the exit status through the close that follows, then reconnects", async () => {
        const port = await start();
        const client = attach(port);
        await until(() => client.statuses.some((s) => s.state === "open"), "open");
        const stop = await fetch(
            `http://127.0.0.1:${port}/sessions/s17-refund-flow/agents/backend/stop`,
            { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        );
        expect(stop.status).toBe(200);
        await until(() => client.statuses.some((s) => s.state === "exited"), "exited");
        await new Promise((resolve) => setTimeout(resolve, 100));
        // The close 1000 after `exit` does not replace the status; the retry's attempt does.
        expect(client.statuses.at(-1)).toEqual({ state: "exited", code: 0 });
        await until(() => client.statuses.filter((s) => s.state === "connecting").length === 2,
            "a retry after the exit");
    });
});
