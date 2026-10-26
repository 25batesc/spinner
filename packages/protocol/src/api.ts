// The daemon's HTTP and WebSocket surface. The daemon binds to loopback only; there is no
// authentication in v1. Request and response bodies are JSON.

import type { SpinnerEvent } from "./events.js";
import type { SessionSummary } from "./session.js";

export const DAEMON_HOST = "127.0.0.1";
export const DAEMON_PORT = 7777;
export const DAEMON_URL = `http://localhost:${DAEMON_PORT}`;
export const EVENTS_WS_URL = `ws://localhost:${DAEMON_PORT}/events`;

/** REST routes. The key is `METHOD path`; the value documents the response body. */
export const ROUTES = {
    /** Liveness probe. */
    "GET /health": "HealthResponse",
    /** Every session under `~/.spinner/sessions`, read fresh from disk. */
    "GET /sessions": "SessionsResponse",
    /** One session by directory name. 404 when it does not exist. */
    "GET /sessions/:dir": "SessionResponse",
    /** Create a session. Body: NewSessionRequest. 201 with SessionResponse. */
    "POST /sessions": "SessionResponse",
    /** The raw MISSION.md of a session. Content-Type text/markdown. */
    "GET /sessions/:dir/mission": "text/markdown",
} as const;

export type Route = keyof typeof ROUTES;

/** WebSocket path. Each message is one `SpinnerEvent` as JSON. */
export const EVENTS_PATH = "/events";

export interface HealthResponse {
    ok: true;
    /** Absolute path of the Spinner home the daemon reads, normally `~/.spinner`. */
    home: string;
    /** Process start time, ISO 8601. */
    started: string;
}

export interface SessionsResponse {
    sessions: SessionSummary[];
}

export interface SessionResponse {
    session: SessionSummary;
}

export interface NewSessionRequest {
    title: string;
    /** Optional slug. Derived from the title when absent. */
    slug?: string;
}

export interface ErrorResponse {
    error: string;
}

/** What the client receives on the `/events` socket, in case the message shape grows. */
export type EventsMessage = SpinnerEvent;
