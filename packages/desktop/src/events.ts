// The daemon's events socket, read by the main process for two things: `session.closed`, so
// the views of a closed session go away, and the socket closing, which means the daemon is
// gone. The UI keeps its own socket; this one is the main process's own. Node 24 in Electron
// has a global `WebSocket`; the constructor is a parameter so a test can pass a fake.
import assert from "node:assert/strict";
import { EVENTS_PATH, type SpinnerEvent } from "@spinner/protocol";

export interface EventsSocketLike {
    addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
    addEventListener(type: "close" | "error", listener: () => void): void;
    close(): void;
}

export type EventsSocketFactory = (url: string) => EventsSocketLike;

export interface EventsWatchHandlers {
    on_session_closed: (session_dir: string) => void;
    /** The socket closed or failed; called once per socket. */
    on_lost: () => void;
}

/** `http://host:port` to `ws://host:port/events`. */
export function events_url(daemon_url: string): string {
    const url = new URL(daemon_url);
    assert.ok(url.protocol === "http:" || url.protocol === "https:");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = EVENTS_PATH;
    return url.toString();
}

/** Opens one socket. Returns the function that closes it. */
export function watch_events(
    daemon_url: string,
    handlers: EventsWatchHandlers,
    make_socket: EventsSocketFactory,
): () => void {
    const socket = make_socket(events_url(daemon_url));
    let lost = false;
    const lose = () => {
        if (!lost) {
            lost = true;
            handlers.on_lost();
        }
    };
    socket.addEventListener("message", (message) => {
        const event = parse_event(message.data);
        if (event?.type === "session.closed") {
            handlers.on_session_closed(event.session);
        }
    });
    socket.addEventListener("close", lose);
    socket.addEventListener("error", lose);
    return () => {
        lost = true;
        socket.close();
    };
}

function parse_event(data: unknown): SpinnerEvent | null {
    if (typeof data !== "string") {
        return null;
    }
    try {
        const parsed = JSON.parse(data) as Partial<SpinnerEvent>;
        if (typeof parsed.type !== "string" || typeof parsed.session !== "string") {
            return null;
        }
        return parsed as SpinnerEvent;
    } catch {
        return null;
    }
}
