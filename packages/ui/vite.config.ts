// In dev, REST calls go through this proxy so the daemon needs no CORS headers. The WebSocket
// connects straight to EVENTS_WS_URL, which browsers do not restrict by origin.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { DAEMON_URL } from "@spinner/protocol";

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: { "/sessions": DAEMON_URL, "/health": DAEMON_URL },
    },
});
