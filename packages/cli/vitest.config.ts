import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        name: "cli",
        include: ["src/**/*.test.ts"],
        environment: "node",
        // Session ids come from the test home only; the machine may run other sessions.
        env: { SPINNER_SESSION_IDS: "home" },
    },
});
