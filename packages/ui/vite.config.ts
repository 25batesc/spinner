// In dev, REST calls and the events socket go through this proxy, so the page talks to its own
// origin and the daemon needs no CORS headers. The daemon serves the built UI on its own port.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { DAEMON_HOST, DAEMON_PORT, EVENTS_PATH } from "@spinner/protocol";

// `SPINNER_PORT` points the dev server at a daemon (or the fixture) that is not on the default
// port, so a second daemon can run beside the operator's.
const DAEMON_URL = `http://${DAEMON_HOST}:${process.env["SPINNER_PORT"] ?? DAEMON_PORT}`;

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            ...Object.fromEntries(
                ["/sessions", "/projects", "/jobs", "/models", "/health"].map((path) => [
                    path,
                    DAEMON_URL,
                ]),
            ),
            [EVENTS_PATH]: { target: DAEMON_URL, ws: true },
        },
    },
});
