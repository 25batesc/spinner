// Root Vitest config. Each package has its own vitest.config.ts; this file lists them as
// projects so that `pnpm vitest` at the root runs every package in one process.
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        projects: ["packages/*/vitest.config.ts"],
    },
});
