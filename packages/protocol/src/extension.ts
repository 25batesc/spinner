// The contract between the daemon and the Spinner pi extension (`packages/pi-extension`):
// the environment the daemon sets when it spawns an agent, the tools the extension
// registers, their argument types, and the daemon route each tool calls. The extension holds
// no state; every tool is one HTTP call. The list follows docs/SESSION_PROTOCOL.md, section
// "What the pi extension provides (M2)". `EXTENSION_MANIFEST` is the runtime form of
// `ExtensionToolArgs`, so the extension can build pi tool definitions from it and a test can
// assert that the two agree.

import type { MissionSection } from "./events.js";

/** The manifest version the extension expects. It refuses a daemon that reports a newer one. */
export const EXTENSION_VERSION = 1 as const;

/** Environment variables the daemon sets on every agent process it spawns. */
export const EXTENSION_ENV = {
    /** Absolute path of the session directory. */
    session_dir: "SPINNER_SESSION_DIR",
    /** The agent's name, as in `agents/<name>/`. */
    agent: "SPINNER_AGENT",
    /** Base URL of the daemon, for example `http://localhost:7777`. */
    daemon_url: "SPINNER_DAEMON_URL",
    /** The agent's role: `worker` or `fixer`. The `thread_*` tools register for `fixer`. */
    role: "SPINNER_ROLE",
    /**
     * `tty` when pi runs interactively in a pty. The extension then opens the `commands`
     * long-poll, posts `hello` and the lifecycle events. Absent (or `rpc`) under `--mode rpc`.
     */
    harness: "SPINNER_HARNESS",
} as const;

export type ExtensionRole = "worker" | "fixer";

export const EXTENSION_TOOLS = [
    "mission_roster",
    "mission_log",
    "mission_contract",
    "mission_question",
    "message",
    "stack",
    "pr",
    "thread_list",
    "thread_reply",
    "thread_resolve",
    "thread_flag",
] as const;

export type ExtensionTool = (typeof EXTENSION_TOOLS)[number];

export type StackToolCommand = "show" | "logs" | "restart";

/** The arguments of each tool, as the model supplies them. */
export interface ExtensionToolArgs {
    /** Overwrites the agent's own Roster row. `blocked` is `no` or `yes: <what you wait for>`. */
    mission_roster: { doing: string; blocked: string };
    /** Appends one Log line. The daemon stamps the time and the agent name. */
    mission_log: { text: string };
    /** Appends one Contracts line. The daemon stamps the time and the agent name. */
    mission_contract: { text: string };
    /** Appends one Open questions line, prefixed with the agent name. */
    mission_question: { text: string };
    /** Writes `inbox/<HHMMSS>-<agent>-<to>.md`. `to` is an agent name, `operator` or `all`. */
    message: { to: string; subject: string; text: string };
    /** `show` lists services and hosts; `logs` and `restart` take a service. */
    stack: { command: StackToolCommand; service?: string; lines?: number };
    /** `show` lists the session's PRs with stage, checks and open threads. */
    pr: { command: "show" };
    /** Open threads of one PR (repo key) or of every PR. */
    thread_list: { pr?: string };
    /** Replies in a thread. `thread` is a `ThreadView.id` or its `label` within `pr`. */
    thread_reply: { thread: string; text: string; pr?: string };
    /** Resolves a replied-to thread. Refused without a reply or for a human thread when off. */
    thread_resolve: { thread: string; pr?: string };
    /** Marks a thread for the operator with a one-line reason. */
    thread_flag: { thread: string; reason: string; pr?: string };
}

/** A tool's JSON-schema parameters, in the subset pi's `Type.Object` can express. */
export interface ToolParameterSpec {
    type: "string" | "number";
    description: string;
    /** For a string that takes a fixed set of values. */
    enum?: readonly string[];
}

export interface ExtensionToolSpec {
    name: ExtensionTool;
    description: string;
    parameters: Record<string, ToolParameterSpec>;
    required: readonly string[];
    /** `fixer` tools register only when `SPINNER_ROLE` is `fixer`. */
    role: "all" | "fixer";
    /** The daemon route the tool calls. `:dir` is the session, `:name` the agent. */
    route: string;
}

export interface ExtensionManifest {
    version: typeof EXTENSION_VERSION;
    env: typeof EXTENSION_ENV;
    tools: readonly ExtensionToolSpec[];
}

const THREAD_PARAMS = {
    thread: { type: "string", description: "Thread id (PRRT_...) or label (T1)" },
    pr: { type: "string", description: "Repo key of the PR; needed with a label" },
} as const satisfies Record<string, ToolParameterSpec>;

export const EXTENSION_MANIFEST: ExtensionManifest = {
    version: EXTENSION_VERSION,
    env: EXTENSION_ENV,
    tools: [
        {
            name: "mission_roster",
            description: "Overwrite your own Roster row in MISSION.md.",
            parameters: {
                doing: { type: "string", description: "One line, or `done`, or `—` when idle" },
                blocked: { type: "string", description: "`no` or `yes: <what you wait for>`" },
            },
            required: ["doing", "blocked"],
            role: "all",
            route: "PUT /sessions/:dir/mission/section",
        },
        {
            name: "mission_log",
            description: "Append one Log line to MISSION.md. The daemon adds time and name.",
            parameters: { text: { type: "string", description: "What happened, one line" } },
            required: ["text"],
            role: "all",
            route: "PUT /sessions/:dir/mission/section",
        },
        {
            name: "mission_contract",
            description: "Append one Contracts & decisions line to MISSION.md.",
            parameters: { text: { type: "string", description: "The contract, one line" } },
            required: ["text"],
            role: "all",
            route: "PUT /sessions/:dir/mission/section",
        },
        {
            name: "mission_question",
            description: "Append one Open questions line for the operator.",
            parameters: { text: { type: "string", description: "The question, one line" } },
            required: ["text"],
            role: "all",
            route: "PUT /sessions/:dir/mission/section",
        },
        {
            name: "message",
            description: "Send a message to another agent, `operator` or `all` through inbox/.",
            parameters: {
                to: { type: "string", description: "Agent name, `operator` or `all`" },
                subject: { type: "string", description: "First line of the message" },
                text: { type: "string", description: "The message body" },
            },
            required: ["to", "subject", "text"],
            role: "all",
            route: "POST /sessions/:dir/inbox",
        },
        {
            name: "stack",
            description: "Show the session's stack, tail a service's logs, or restart a service.",
            parameters: {
                command: {
                    type: "string",
                    description: "What to do",
                    enum: ["show", "logs", "restart"],
                },
                service: { type: "string", description: "Service name, for logs and restart" },
                lines: { type: "number", description: "Log lines to tail (default 100)" },
            },
            required: ["command"],
            role: "all",
            route: "GET /sessions/:dir",
        },
        {
            name: "pr",
            description: "Show the session's PRs: stage, checks, review and open threads.",
            parameters: {
                command: { type: "string", description: "Only `show`", enum: ["show"] },
            },
            required: ["command"],
            role: "all",
            route: "GET /sessions/:dir",
        },
        {
            name: "thread_list",
            description: "List the open review threads of one PR or of every PR.",
            parameters: { pr: { type: "string", description: "Repo key; all PRs when absent" } },
            required: [],
            role: "fixer",
            route: "GET /sessions/:dir/threads",
        },
        {
            name: "thread_reply",
            description: "Reply in a review thread: one line on what changed or why not.",
            parameters: {
                ...THREAD_PARAMS,
                text: { type: "string", description: "The reply" },
            },
            required: ["thread", "text"],
            role: "fixer",
            route: "POST /sessions/:dir/threads/:id/reply",
        },
        {
            name: "thread_resolve",
            description:
                "Resolve a thread you replied to, after the fix is pushed and checks are green.",
            parameters: THREAD_PARAMS,
            required: ["thread"],
            role: "fixer",
            route: "POST /sessions/:dir/threads/:id/resolve",
        },
        {
            name: "thread_flag",
            description: "Flag a thread for the operator: design question or out of scope.",
            parameters: {
                ...THREAD_PARAMS,
                reason: { type: "string", description: "One line" },
            },
            required: ["thread", "reason"],
            role: "fixer",
            route: "POST /sessions/:dir/threads/:id/flag",
        },
    ],
};

/** How `PUT /sessions/:dir/mission/section` changes a section. */
export type MissionWriteMode =
    /** Append one line at the end of the section (Log, Contracts, Open questions, Plan). */
    | "append"
    /** Replace the section body (Goal, Done when; the operator's sections). */
    | "replace"
    /** Overwrite the row of `author` in the Roster table. */
    | "roster_row";

/** Body of `PUT /sessions/:dir/mission/section`. The daemon serializes these writes. */
export interface MissionSectionRequest {
    section: MissionSection;
    mode: MissionWriteMode;
    /** The line, the new body, or for `roster_row` the `doing` cell; see `blocked`. */
    text: string;
    /** Who writes: an agent name or `operator`. Prefixes Log and Contracts lines. */
    author: string;
    /** For `roster_row`: the Blocked? cell. */
    blocked?: string;
}

export interface MissionSectionResponse {
    ok: true;
    /** The sections the write changed. */
    sections: MissionSection[];
}

/** Body of `POST /sessions/:dir/inbox`: a message file the daemon writes and delivers. */
export interface InboxMessageRequest {
    from: string;
    /** Agent name, `operator` or `all`. */
    to: string;
    subject: string;
    text: string;
}

export interface InboxMessageResponse {
    /** File name in `inbox/`. */
    file: string;
}
