import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        name: "daemon",
        include: ["src/**/*.test.ts"],
        environment: "node",
        // Session ids come from the test home only; the machine may run other sessions.
        // The pi settings come from a directory that does not exist, so a test daemon never
        // sees the operator's pi-subagents and never fetches EGM from GitHub.
        env: { SPINNER_SESSION_IDS: "home", PI_CODING_AGENT_DIR: "/nonexistent/spinner-test-pi" },
    },
});
