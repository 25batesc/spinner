// Goal: keep the runtime manifest and the typed tool list in step, and keep every route a
// tool calls in `ROUTES`, so the extension and the daemon cannot drift apart silently.
// Method: compare names, check each route string against the route table, and check that
// every required parameter is declared.
import { describe, expect, it } from "vitest";
import { ROUTES } from "./api.js";
import { EXTENSION_MANIFEST, EXTENSION_TOOLS, type ExtensionToolArgs } from "./extension.js";

describe("extension manifest", () => {
    it("lists every tool once, in order", () => {
        expect(EXTENSION_MANIFEST.tools.map((tool) => tool.name)).toEqual([...EXTENSION_TOOLS]);
    });

    it("calls only routes the API declares", () => {
        for (const tool of EXTENSION_MANIFEST.tools) {
            expect(Object.keys(ROUTES)).toContain(tool.route);
        }
    });

    it("declares every required parameter", () => {
        for (const tool of EXTENSION_MANIFEST.tools) {
            for (const name of tool.required) {
                expect(Object.keys(tool.parameters)).toContain(name);
            }
        }
    });

    it("types the fixer tools' arguments", () => {
        const args: ExtensionToolArgs["thread_resolve"] = { thread: "T1", pr: "backend" };
        expect(args.thread).toBe("T1");
        const fixer_tools = EXTENSION_MANIFEST.tools.filter((tool) => tool.role === "fixer");
        expect(fixer_tools.map((tool) => tool.name)).toEqual([
            "thread_list",
            "thread_reply",
            "thread_resolve",
            "thread_flag",
        ]);
    });
});
