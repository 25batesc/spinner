// Goal: the watcher turns the daemon URL into the events socket URL, forwards
// `session.closed` with its session, ignores other and malformed messages, and reports a
// loss once per socket. Method: a fake socket that records listeners and replays messages.
import { describe, expect, it } from "vitest";
import { events_url, watch_events, type EventsSocketLike } from "./events.js";

function fake_socket() {
    const listeners = new Map<string, Array<(event: { data: unknown }) => void>>();
    let closed = 0;
    const socket: EventsSocketLike & {
        emit(type: string, data?: unknown): void;
        closed(): number;
        url: string;
    } = {
        url: "",
        addEventListener(type: string, listener: (event: { data: unknown }) => void) {
            listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
        close() {
            closed += 1;
        },
        emit(type, data) {
            for (const listener of listeners.get(type) ?? []) {
                listener({ data });
            }
        },
        closed: () => closed,
    };
    return socket;
}

describe("events_url", () => {
    it("maps http to ws on the events path", () => {
        expect(events_url("http://localhost:7777")).toBe("ws://localhost:7777/events");
        expect(events_url("https://x.example/")).toBe("wss://x.example/events");
    });
});

describe("watch_events", () => {
    it("forwards session.closed and ignores the rest", () => {
        const socket = fake_socket();
        const closed: string[] = [];
        let lost = 0;
        watch_events(
            "http://localhost:7777",
            { on_session_closed: (dir) => closed.push(dir), on_lost: () => (lost += 1) },
            (url) => {
                socket.url = url;
                return socket;
            },
        );
        expect(socket.url).toBe("ws://localhost:7777/events");
        socket.emit("message", JSON.stringify({ type: "session.updated", session: "s1-a" }));
        socket.emit("message", JSON.stringify({ type: "session.closed", session: "s1-a" }));
        socket.emit("message", "not json");
        socket.emit("message", JSON.stringify({ type: "session.closed" }));
        socket.emit("message", new Uint8Array(2));
        expect(closed).toEqual(["s1-a"]);
        expect(lost).toBe(0);
    });

    it("reports a loss once, and not after the watcher closed the socket itself", () => {
        const socket = fake_socket();
        let lost = 0;
        const stop = watch_events(
            "http://localhost:7777",
            { on_session_closed: () => undefined, on_lost: () => (lost += 1) },
            () => socket,
        );
        socket.emit("error");
        socket.emit("close");
        expect(lost).toBe(1);

        const second = fake_socket();
        let lost_second = 0;
        const stop_second = watch_events(
            "http://localhost:7777",
            { on_session_closed: () => undefined, on_lost: () => (lost_second += 1) },
            () => second,
        );
        stop_second();
        second.emit("close");
        expect(second.closed()).toBe(1);
        expect(lost_second).toBe(0);
        stop();
    });
});
