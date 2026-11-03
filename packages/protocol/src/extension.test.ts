// Goal: keep the runtime manifest and the typed tool list in step, and keep every route a
// tool calls in `ROUTES`, so the extension and the daemon cannot drift apart silently.
// Method: compare names, check each route string against the route table, and check that
// every required parameter is declared.
import { describe, expect, it } from "vitest";
import { ROUTES } from "./api.js";
import {
    EXTENSION_ENV,
    EXTENSION_MANIFEST,
    EXTENSION_TOOLS,
    SUBAGENTS_TEMP_ROOT_ENV,
    SUBAGENT_CHILD_ENV,
    SUBAGENT_EXTRA_AGENT_DIRS_ENV,
    role_of_agent,
    type ExtensionToolArgs,
} from "./extension.js";

describe("extension manifest", () => {
    it("names the EGM variables and the pi-subagents variables by value", () => {
        expect(EXTENSION_ENV.egm_root).toBe("SPINNER_EGM_ROOT");
        expect(EXTENSION_ENV.egm_artifacts).toBe("SPINNER_EGM_ARTIFACTS");
        expect(SUBAGENT_CHILD_ENV).toBe("PI_SUBAGENT_CHILD");
        expect(SUBAGENT_EXTRA_AGENT_DIRS_ENV).toBe("PI_SUBAGENT_EXTRA_AGENT_DIRS");
        expect(SUBAGENTS_TEMP_ROOT_ENV).toBe("PI_SUBAGENTS_TEMP_ROOT");
    });

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
        const fixer_tools = EXTENSION_MANIFEST.tools.filter(
            (tool) => tool.roles.includes("fixer") && !tool.roles.includes("worker"),
        );
        expect(fixer_tools.map((tool) => tool.name)).toEqual([
            "thread_list",
            "thread_reply",
            "thread_resolve",
            "thread_flag",
        ]);
    });

    it("gives the operator role its session tools, stack and pr, and nothing session-bound", () => {
        const operator_tools = EXTENSION_MANIFEST.tools
            .filter((tool) => tool.roles.includes("operator"))
            .map((tool) => tool.name);
        expect(operator_tools).toEqual([
            "stack",
            "pr",
            "session_new",
            "session_adopt",
            "session_attach",
            "session_list",
            "session_show",
            "mission_write",
            "brief_write",
            "agent_add",
            "agent_steer",
            "inbox_send",
        ]);
        for (const tool of EXTENSION_MANIFEST.tools) {
            expect(tool.roles.length).toBeGreaterThan(0);
        }
    });

    it("gives the lead the mission and review tools, agent_add and adopt; nothing else", () => {
        const lead_tools = EXTENSION_MANIFEST.tools
            .filter((tool) => tool.roles.includes("lead"))
            .map((tool) => tool.name);
        expect(lead_tools).toEqual([
            "mission_roster",
            "mission_log",
            "mission_contract",
            "mission_question",
            "message",
            "stack",
            "pr",
            "agent_add",
            "agent_steer",
            "diff_comments",
            "diff_reply",
            "session_title",
            "mission_goal",
            "mission_done_when",
            "mission_plan",
            "adopt",
            "review_briefing",
            "review_draft",
            "design_doc",
            "ask_question",
        ]);
        // `session` is optional for the two shared tools: the lead acts on its own session.
        for (const name of ["agent_add", "agent_steer"]) {
            const tool = EXTENSION_MANIFEST.tools.find((entry) => entry.name === name);
            expect(tool?.required).not.toContain("session");
        }
        expect(role_of_agent("lead")).toBe("lead");
        expect(role_of_agent("fixer")).toBe("fixer");
        expect(role_of_agent("backend")).toBe("worker");
    });
});
