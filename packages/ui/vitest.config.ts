import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        name: "ui",
        include: ["src/**/*.test.ts", "fixture/**/*.test.ts"],
        environment: "node",
        // Session ids come from the test home only; the machine may run other sessions.
        env: { SPINNER_SESSION_IDS: "home" },
    },
});
