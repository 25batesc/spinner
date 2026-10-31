// In dev, REST calls and the events socket go through this proxy, so the page talks to its own
// origin and the daemon needs no CORS headers. The daemon serves the built UI on its own port.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { DAEMON_HOST, EVENTS_PATH } from "@spinner/protocol";

import { fixturePort } from "./fixture/port.ts";

// With `SPINNER_PORT` unset the dev server talks to the fixture's port (`17777`), never to the
// operator's daemon on its default port. `SPINNER_PORT` points it at a daemon or a fixture
// elsewhere, so a second daemon can run beside the operator's.
const DAEMON_URL = `http://${DAEMON_HOST}:${fixturePort(process.env)}`;

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            ...Object.fromEntries(
                ["/projects", "/jobs", "/models", "/health", "/usage", "/settings", "/themes"]
                    .map((path) => [path, DAEMON_URL]),
            ),
            // The agent tty route upgrades to a WebSocket under `/sessions`.
            "/sessions": { target: DAEMON_URL, ws: true },
            [EVENTS_PATH]: { target: DAEMON_URL, ws: true },
        },
    },
});
