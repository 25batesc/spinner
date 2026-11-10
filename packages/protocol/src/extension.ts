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
    /**
     * The agent's role: `worker`, `fixer`, `lead` or `operator`. The `thread_*` tools
     * register for `fixer`; the `session_*`, `mission_write`, `brief_write`, `agent_*` and
     * `inbox_send` tools for `operator`, whose session directory is `<home>/operator` and
     * whose routes are `/operator/*` (MISSION.md s013). `lead` (s014) owns its session's
     * mission: `session_title`, `mission_goal`, `mission_done_when`, `mission_plan`,
     * `agent_add`, `agent_steer` and `adopt`, on its own session.
     */
    role: "SPINNER_ROLE",
    /**
     * `tty` when pi runs interactively in a pty. The extension then opens the `commands`
     * long-poll, posts `hello` and the lifecycle events. Absent (or `rpc`) under `--mode rpc`.
     */
    harness: "SPINNER_HARNESS",
    /** `full` when `settings.agents.github` is `full`: the lead's GitHub guard is off. */
    github: "SPINNER_GITHUB",
    /** The EGM checkout root (`<home>/egm/src`); set only on a lead of an EGM session. */
    egm_root: "SPINNER_EGM_ROOT",
    /** The EGM artifact directory (`<session>/design`); set only on a lead of an EGM session. */
    egm_artifacts: "SPINNER_EGM_ARTIFACTS",
} as const;

// The pi-subagents environment, cited from pi-subagents 0.83.0. `PI_SUBAGENTS_TEMP_ROOT` is
// documented (`docs/agents.md`, the sandbox paragraph) and read once at import, so it must be
// in the lead's spawn environment. The other two are not documented: `PI_SUBAGENT_CHILD` is
// `SUBAGENT_CHILD_ENV` in `src/runs/shared/child-runtime-config.js`, and
// `PI_SUBAGENT_EXTRA_AGENT_DIRS` is `EXTRA_AGENT_DIRS_ENV` in `src/agents/agents.js`.

/** pi-subagents sets this to `1` in every child; the Spinner extension then stays off. */
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
/** Extra directories that pi-subagents scans for user agents: the EGM adapter. */
export const SUBAGENT_EXTRA_AGENT_DIRS_ENV = "PI_SUBAGENT_EXTRA_AGENT_DIRS";
/** The root of pi-subagents' async run directories: `<session>/egm-runs`. */
export const SUBAGENTS_TEMP_ROOT_ENV = "PI_SUBAGENTS_TEMP_ROOT";

export type ExtensionRole = "worker" | "fixer" | "lead" | "operator";

export const EXTENSION_ROLES: readonly ExtensionRole[] = ["worker", "fixer", "lead", "operator"];

/** The agent named `fixer` is the fixer and the one named `lead` the lead; the rest work. */
export function role_of_agent(name: string): ExtensionRole {
    if (name === "fixer") {
        return "fixer";
    }
    return name === "lead" ? "lead" : "worker";
}

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
    "comments_list",
    "comment_reply",
    "comment_suggest_resolve",
] as const;

/** What `mission_plan` does; `mission_done_when` takes the first four. */
export const MISSION_ITEM_COMMANDS = [
    "add",
    "tick",
    "untick",
    "edit",
    "assign",
    "reorder",
] as const;

export type MissionItemCommand = (typeof MISSION_ITEM_COMMANDS)[number];

/**
 * The `item` commands on `open_questions` (dogfood #43). `answer` writes `  - HH:MM author:
 * text` under question `id`; any author may answer. `resolve` writes `  - HH:MM author:
 * [resolved] text` under it; only `lead` and `operator` may resolve, and a question resolves
 * once. Neither writes a Log line.
 */
export const QUESTION_ITEM_COMMANDS = ["answer", "resolve"] as const;

export type QuestionItemCommand = (typeof QUESTION_ITEM_COMMANDS)[number];

/** What `mission_question` does: `ask` appends a stamped question; the others are above. */
export const QUESTION_TOOL_COMMANDS = ["ask", ...QUESTION_ITEM_COMMANDS] as const;

export type QuestionToolCommand = (typeof QUESTION_TOOL_COMMANDS)[number];

export const DONE_WHEN_COMMANDS = ["set", "tick", "untick", "edit"] as const;

export type DoneWhenCommand = (typeof DONE_WHEN_COMMANDS)[number];

/** The sections `mission_write` takes; the Roster belongs to the agents and the writer. */
export const OPERATOR_MISSION_SECTIONS = [
    "goal",
    "done_when",
    "plan",
    "contracts",
    "open_questions",
    "log",
] as const;

export type OperatorMissionSection = (typeof OPERATOR_MISSION_SECTIONS)[number];

/**
 * The actions the operator agent and the lead must leave to a person (MISSION.md s013 and
 * s014, Contracts). In those roles the extension blocks a `bash` call that runs one of them
 * through `spinner`, `git push` or `gh`, with a message that says the operator must do it.
 */
export const OPERATOR_REFUSED_ACTIONS = [
    "pr",
    "post",
    "approve",
    "land",
    "reset",
    "close",
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
    /**
     * Open questions (dogfood #43). `ask` (the default) appends `- HH:MM agent: text`;
     * `answer` writes `text` under question `id`; `resolve` (the lead only) closes question
     * `id` with `text` as the reason.
     */
    mission_question: { text: string; command?: QuestionToolCommand; id?: number };
    /** Writes `inbox/<HHMMSS>-<agent>-<to>.md`. `to` is an agent name, `operator` or `all`. */
    message: { to: string; subject: string; text: string };
    /**
     * `show` lists services and hosts; `logs` and `restart` take a service. `session` names
     * the session directory in the operator role and is ignored in the others.
     */
    stack: { command: StackToolCommand; service?: string; lines?: number; session?: string };
    /** `show` lists the session's PRs with stage, checks and open threads. */
    pr: { command: "show"; session?: string };
    /** Open threads of one PR (repo key) or of every PR. */
    thread_list: { pr?: string };
    /** Replies in a thread. `thread` is a `ThreadView.id` or its `label` within `pr`. */
    thread_reply: { thread: string; text: string; pr?: string };
    /** Resolves a replied-to thread. Refused without a reply or for a human thread when off. */
    thread_resolve: { thread: string; pr?: string };
    /** Marks a thread for the operator with a one-line reason. */
    thread_flag: { thread: string; reason: string; pr?: string };
    /**
     * Creates a session; the job attaches `project` (a name `GET /projects` lists, or a path)
     * and the tool waits for it. Returns the session directory the other tools take.
     */
    session_new: { title: string; project?: string; slug?: string };
    /** Adopts PRs opened outside Spinner. `urls` is whitespace- or comma-separated. */
    session_adopt: { urls: string; project?: string; title?: string };
    /** Attaches a project to a session created or adopted without one; waits for the job. */
    session_attach: { session: string; project: string };
    /** Every live session: directory, title, stage, agents and what they do. */
    session_list: Record<string, never>;
    /** One session: the view digest and its full `MISSION.md`. */
    session_show: { session: string };
    /**
     * One section of a named session's `MISSION.md`, as `operator`. `goal` and `done_when`
     * replace the body; `plan`, `contracts`, `open_questions` and `log` append one line.
     */
    mission_write: { session: string; section: OperatorMissionSection; text: string };
    /** Writes `agents/<agent>/BRIEF.md` of the session, whole file, over an existing one. */
    brief_write: { session: string; agent: string; text: string };
    /** Adds an agent and starts it. Writes `brief` first when the session has none for it. */
    agent_add: { session: string; name: string; brief?: string; repo?: string; model?: string };
    /** A steer to a running agent; it starts a turn when the agent is idle. */
    agent_steer: { session: string; agent: string; text: string };
    /** An `inbox/` message from `operator` to an agent or `all`. */
    inbox_send: { session: string; to: string; subject: string; text: string };
    /**
     * Read the diff viewer's comments on the agent's worktree (s012). `list` shows every
     * unresolved thread of the branch; `show` prints the threads in `threads` in full, with
     * the lines around them. `threads` is thread ids separated by spaces.
     */
    diff_comments: { command: "list" | "show"; threads?: string };
    /** Reply in a diff comment thread, or suggest that it is resolved; the operator resolves. */
    diff_reply: { command: "reply" | "suggest-resolve"; thread: number; text: string };
    /** The lead (s014) sets the session title in `session.yaml` and the mission heading. */
    session_title: { title: string };
    /** Replaces the Goal paragraph. */
    mission_goal: { text: string };
    /**
     * The Done when list: `set` replaces it with `items` (one per line); `tick`, `untick`
     * and `edit` take `id`, the item's 1-based position, and `edit` takes `text`.
     */
    mission_done_when: { command: DoneWhenCommand; items?: string; id?: number; text?: string };
    /**
     * The Plan (the lead; a worker has `tick` and `untick` on its own or unowned items only,
     * dogfood r3.6): `add` takes `text`, `owner` (the caller when absent) and `entry` (the doc
     * entry the item belongs to, `2.3`, written as the `[2.3]` token); `tick`, `untick`,
     * `edit` (with `text`) and `assign` (with `owner`) take `id`; `reorder` takes `order`,
     * ids separated by spaces (unlisted items follow in their old order).
     */
    mission_plan: {
        command: MissionItemCommand;
        text?: string;
        owner?: string;
        entry?: string;
        id?: number;
        order?: string;
    };
    /**
     * Adopts PR references into the lead's session: URLs, `owner/repo#N`, `repo#N` or `#N`,
     * separated by spaces or commas. A reference whose repo the project does not list is
     * refused with the reason; the rest get worktrees on their head branches.
     */
    adopt: { refs: string };
    /** The review lead (s016) writes its briefing for the operator, `artifacts/briefing.md`. */
    review_briefing: { markdown: string };
    /**
     * The review lead (s016) writes the one review in one voice: `event` (`APPROVE` with no
     * `BLOCKING:` finding, `COMMENT` otherwise), `body` (the summary only) and `comments`, a
     * JSON array text of `{ path, line, body }`. The daemon validates it against the PR diff
     * and returns every fault instead of writing. The operator posts; the lead never does.
     */
    review_draft: { event: string; body: string; comments: string };
    /** The lead names the design doc it wrote, by its absolute path (EGM, build session 2). */
    design_doc: { path: string };
    /**
     * The lead asks one EGM gate (build session 3, T8): `questions` is the JSON text of EGM's
     * gate payload, `[{ question, options, is_multi_select }]` or `{ questions: [...] }`.
     */
    ask_question: { questions: string };
    /**
     * The session's preview comments (s054): the open ones by default, each with its place
     * and its messages; `all` adds the resolved ones.
     */
    comments_list: { all?: string };
    /** Reply in a preview comment thread, as the agent; it then waits on the operator. */
    comment_reply: { id: string; text: string };
    /** Tell the operator the change is made and ask to resolve; the operator resolves. */
    comment_suggest_resolve: { id: string; text: string };
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
    /** The roles the tool registers for; `SPINNER_ROLE` picks. */
    roles: readonly ExtensionRole[];
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

const SESSION_PARAM = {
    session: { type: "string", description: "Session directory, as session_list shows it" },
} as const satisfies Record<string, ToolParameterSpec>;

const SESSION_ROLES: readonly ExtensionRole[] = ["worker", "fixer", "lead"];
const EVERY_ROLE: readonly ExtensionRole[] = ["worker", "fixer", "lead", "operator"];
const FIXER: readonly ExtensionRole[] = ["fixer"];
const OPERATOR: readonly ExtensionRole[] = ["operator"];
const OPERATOR_OR_LEAD: readonly ExtensionRole[] = ["operator", "lead"];
const WORKER_OR_LEAD: readonly ExtensionRole[] = ["worker", "lead"];
const LEAD: readonly ExtensionRole[] = ["lead"];

const COMMENT_ID_PARAM = {
    id: { type: "string", description: "The comment id, `c3`, as comments_list shows it" },
} as const satisfies Record<string, ToolParameterSpec>;

const ITEM_ID_PARAM = {
    id: { type: "number", description: "The item's id, as the mission shows it" },
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
            roles: SESSION_ROLES,
            route: "PUT /sessions/:dir/mission/section",
        },
        {
            name: "mission_log",
            description: "Append one Log line to MISSION.md. The daemon adds time and name.",
            parameters: { text: { type: "string", description: "What happened, one line" } },
            required: ["text"],
            roles: SESSION_ROLES,
            route: "PUT /sessions/:dir/mission/section",
        },
        {
            name: "mission_contract",
            description: "Append one Contracts & decisions line to MISSION.md.",
            parameters: { text: { type: "string", description: "The contract, one line" } },
            required: ["text"],
            roles: SESSION_ROLES,
            route: "PUT /sessions/:dir/mission/section",
        },
        {
            name: "mission_question",
            description:
                "Open questions: ask one for the operator (stamped with the time), answer " +
                "question id under it, or, as the lead, resolve question id with a reason.",
            parameters: {
                text: {
                    type: "string",
                    description: "The question, the answer or the reason, one line",
                },
                command: {
                    type: "string",
                    description: "ask (default), answer or resolve",
                    enum: QUESTION_TOOL_COMMANDS,
                },
                id: { type: "number", description: "For answer and resolve: the question's id" },
            },
            required: ["text"],
            roles: SESSION_ROLES,
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
            roles: SESSION_ROLES,
            route: "POST /sessions/:dir/inbox",
        },
        {
            name: "stack",
            description:
                "Show the session's stack (and why its last job failed), tail a service's " +
                "logs, or restart a service.",
            parameters: {
                command: {
                    type: "string",
                    description: "What to do",
                    enum: ["show", "logs", "restart"],
                },
                service: { type: "string", description: "Service name, for logs and restart" },
                lines: { type: "number", description: "Log lines to tail (default 100, max 2000)" },
                session: {
                    type: "string",
                    description: "Session directory; needed in the operator role, ignored else",
                },
            },
            required: ["command"],
            roles: EVERY_ROLE,
            route: "GET /sessions/:dir",
        },
        {
            name: "pr",
            description: "Show the session's PRs: stage, checks, review and open threads.",
            parameters: {
                command: { type: "string", description: "Only `show`", enum: ["show"] },
                session: {
                    type: "string",
                    description: "Session directory; needed in the operator role, ignored else",
                },
            },
            required: ["command"],
            roles: EVERY_ROLE,
            route: "GET /sessions/:dir",
        },
        {
            name: "thread_list",
            description: "List the open review threads of one PR or of every PR.",
            parameters: { pr: { type: "string", description: "Repo key; all PRs when absent" } },
            required: [],
            roles: FIXER,
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
            roles: FIXER,
            route: "POST /sessions/:dir/threads/:id/reply",
        },
        {
            name: "thread_resolve",
            description:
                "Resolve a thread you replied to, after the fix is pushed and checks are green.",
            parameters: THREAD_PARAMS,
            required: ["thread"],
            roles: FIXER,
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
            roles: FIXER,
            route: "POST /sessions/:dir/threads/:id/flag",
        },
        {
            name: "session_new",
            description:
                "Create a session and attach a project; waits for the worktrees. Returns the " +
                "session directory the other tools take.",
            parameters: {
                title: { type: "string", description: "Session title, a few words" },
                project: {
                    type: "string",
                    description: "Project name from GET /projects or a spinner.yaml path",
                },
                slug: { type: "string", description: "Directory slug; derived from the title" },
            },
            required: ["title"],
            roles: OPERATOR,
            route: "POST /sessions",
        },
        {
            name: "session_adopt",
            description: "Adopt pull requests opened outside Spinner into a new session.",
            parameters: {
                urls: { type: "string", description: "PR URLs, separated by spaces or commas" },
                project: { type: "string", description: "Project to attach, optional" },
                title: { type: "string", description: "Session title, optional" },
            },
            required: ["urls"],
            roles: OPERATOR,
            route: "POST /sessions/adopt",
        },
        {
            name: "session_attach",
            description: "Attach a project to a session that has none; waits for the worktrees.",
            parameters: {
                ...SESSION_PARAM,
                project: { type: "string", description: "Project name or spinner.yaml path" },
            },
            required: ["session", "project"],
            roles: OPERATOR,
            route: "POST /sessions/:dir/attach",
        },
        {
            name: "session_list",
            description: "List every live session: directory, title, stage, agents.",
            parameters: {},
            required: [],
            roles: OPERATOR,
            route: "GET /sessions",
        },
        {
            name: "session_show",
            description: "Show one session: stage, repos, stack, agents and its MISSION.md.",
            parameters: SESSION_PARAM,
            required: ["session"],
            roles: OPERATOR,
            route: "GET /sessions/:dir",
        },
        {
            name: "mission_write",
            description:
                "Write one section of a session's MISSION.md as operator. goal and done_when " +
                "replace the body; plan, contracts, open_questions and log append one line.",
            parameters: {
                ...SESSION_PARAM,
                section: {
                    type: "string",
                    description: "The section",
                    enum: OPERATOR_MISSION_SECTIONS,
                },
                text: { type: "string", description: "The body, or the one line to append" },
            },
            required: ["session", "section", "text"],
            roles: OPERATOR,
            route: "PUT /sessions/:dir/mission/section",
        },
        {
            name: "brief_write",
            description: "Write agents/<agent>/BRIEF.md of a session, the whole file.",
            parameters: {
                ...SESSION_PARAM,
                agent: { type: "string", description: "Agent name: lower-case, digits, dashes" },
                text: { type: "string", description: "The brief, Markdown" },
            },
            required: ["session", "agent", "text"],
            roles: OPERATOR,
            route: "PUT /sessions/:dir/agents/:name/brief",
        },
        {
            name: "agent_add",
            description:
                "Add an agent to the session, start it and send its first turn. Pass brief when " +
                "the session has no brief for it yet; an existing brief is kept. Pass message to " +
                "replace the default first turn.",
            parameters: {
                session: {
                    type: "string",
                    description: "Session directory; needed in the operator role, ignored else",
                },
                name: { type: "string", description: "Agent name: lower-case, digits, dashes" },
                brief: { type: "string", description: "BRIEF.md text when none exists" },
                repo: { type: "string", description: "Repo key; the agent runs in its worktree" },
                model: { type: "string", description: "provider/model; the default when absent" },
                message: {
                    type: "string",
                    description:
                        "The agent's first prompt; without it the daemon tells a new agent to " +
                        "read the mission and its brief, take its Plan items and start",
                },
            },
            required: ["name"],
            roles: OPERATOR_OR_LEAD,
            route: "POST /sessions/:dir/agents",
        },
        {
            name: "agent_steer",
            description: "Steer a running agent; it starts a turn when the agent is idle.",
            parameters: {
                session: {
                    type: "string",
                    description: "Session directory; needed in the operator role, ignored else",
                },
                agent: { type: "string", description: "Agent name" },
                text: { type: "string", description: "The message" },
            },
            required: ["agent", "text"],
            roles: OPERATOR_OR_LEAD,
            route: "POST /sessions/:dir/agents/:name/steer",
        },
        {
            name: "inbox_send",
            description: "Send an inbox/ message from operator to an agent or to all.",
            parameters: {
                ...SESSION_PARAM,
                to: { type: "string", description: "Agent name or `all`" },
                subject: { type: "string", description: "First line of the message" },
                text: { type: "string", description: "The message body" },
            },
            required: ["session", "to", "subject", "text"],
            roles: OPERATOR,
            route: "POST /sessions/:dir/inbox",
        },
        {
            name: "diff_comments",
            description:
                "Read the operator's comments in the diff viewer of your worktree: list the " +
                "unresolved threads, or show threads in full with the lines around them.",
            parameters: {
                command: { type: "string", description: "What to do", enum: ["list", "show"] },
                threads: { type: "string", description: "Thread ids, space-separated, for show" },
            },
            required: ["command"],
            roles: WORKER_OR_LEAD,
            route: "POST /sessions/:dir/agents/:name/diff/comments",
        },
        {
            name: "diff_reply",
            description:
                "Answer a diff comment thread: reply, or suggest that it is resolved after the " +
                "fix is committed. Only the operator resolves.",
            parameters: {
                command: {
                    type: "string",
                    description: "What to do",
                    enum: ["reply", "suggest-resolve"],
                },
                thread: { type: "number", description: "Thread id, as diff_comments shows it" },
                text: { type: "string", description: "The message" },
            },
            required: ["command", "thread", "text"],
            roles: WORKER_OR_LEAD,
            route: "POST /sessions/:dir/agents/:name/diff/comments",
        },
        {
            name: "session_title",
            description: "Set the session's title, a few words, once you know what the work is.",
            parameters: { title: { type: "string", description: "The title" } },
            required: ["title"],
            roles: LEAD,
            route: "PUT /sessions/:dir/title",
        },
        {
            name: "mission_goal",
            description: "Replace the Goal paragraph of MISSION.md.",
            parameters: { text: { type: "string", description: "One paragraph" } },
            required: ["text"],
            roles: LEAD,
            route: "PUT /sessions/:dir/mission/section",
        },
        {
            name: "mission_done_when",
            description:
                "The Done when list: set it (items, one per line), or tick, untick or edit one " +
                "item by its id (its position).",
            parameters: {
                command: { type: "string", description: "What to do", enum: DONE_WHEN_COMMANDS },
                items: { type: "string", description: "For set: the items, one per line" },
                ...ITEM_ID_PARAM,
                text: { type: "string", description: "For edit: the new text" },
            },
            required: ["command"],
            roles: LEAD,
            route: "PUT /sessions/:dir/mission/section",
        },
        {
            name: "mission_plan",
            description:
                "The Plan: add an item (text, owner, entry), tick or untick one the moment it is " +
                "done, edit its text, assign an owner, or reorder by ids. Ids never change. A " +
                "worker only ticks and unticks, and only its own items or unowned ones. An " +
                "item seeded from the design doc carries its entry as a `[2.3]` token at the " +
                "start of its line; edit keeps it unless the new text starts with a token.",
            parameters: {
                command: { type: "string", description: "What to do", enum: MISSION_ITEM_COMMANDS },
                text: { type: "string", description: "For add and edit: the item text" },
                owner: { type: "string", description: "For add and assign: the agent name" },
                entry: {
                    type: "string",
                    description: "The doc entry this item belongs to, `2.3`; add only",
                },
                ...ITEM_ID_PARAM,
                order: { type: "string", description: "For reorder: ids, space-separated" },
            },
            required: ["command"],
            roles: WORKER_OR_LEAD,
            route: "PUT /sessions/:dir/mission/section",
        },
        {
            name: "adopt",
            description:
                "Adopt pull requests into this session: a worktree on each PR's head branch. " +
                "A PR of a repo the project does not list is refused with the reason.",
            parameters: {
                refs: {
                    type: "string",
                    description: "PR URLs, owner/repo#N, repo#N or #N, separated by spaces",
                },
            },
            required: ["refs"],
            roles: LEAD,
            route: "POST /sessions/:dir/adopt",
        },
        {
            name: "review_briefing",
            description:
                "Write the reviewer briefing for the operator: what the PR does, how, the " +
                "design pattern, the codebase fit, the approach and slop verdict. Markdown. " +
                "It replaces an earlier briefing.",
            parameters: { markdown: { type: "string", description: "The briefing, Markdown" } },
            required: ["markdown"],
            roles: LEAD,
            route: "PUT /sessions/:dir/review/briefing",
        },
        {
            name: "review_draft",
            description:
                "Write the draft of the one PR review for the operator to post: the event, the " +
                "summary body and the line comments. The daemon checks each comment's label " +
                "and that each path:line is on the right side of the PR diff; on a fault it " +
                "returns the errors and writes nothing. It replaces an earlier draft.",
            parameters: {
                event: {
                    type: "string",
                    description: "APPROVE with no BLOCKING finding, COMMENT otherwise",
                    enum: ["APPROVE", "COMMENT"],
                },
                body: {
                    type: "string",
                    description: "The summary only: LGTM, A few nits, but LGTM, or A few blockers",
                },
                comments: {
                    type: "string",
                    description:
                        'JSON array text: [{"path": "src/a.ts", "line": 12, "body": ' +
                        '"BLOCKING: ..."}]; [] for none',
                },
            },
            required: ["event", "body", "comments"],
            roles: LEAD,
            route: "PUT /sessions/:dir/review/draft",
        },
        {
            name: "design_doc",
            description:
                "Name the design doc you just wrote, by its absolute path. Call it once the " +
                "draft's final file is written in the designs directory. Spinner tracks, " +
                "reviews and approves this file.",
            parameters: {
                path: { type: "string", description: "The absolute path of the design doc" },
            },
            required: ["path"],
            roles: LEAD,
            route: "PUT /sessions/:dir/design/doc",
        },
        {
            name: "ask_question",
            description:
                "Ask the operator one single-select question. Pass EGM's gate payload as JSON " +
                'text: [{"question": "...", "options": ["...", "..."], "is_multi_select": ' +
                "false}]. Exactly one question with 2 to 6 options. Spinner shows the options " +
                "as buttons. End your turn after this call.",
            parameters: {
                questions: {
                    type: "string",
                    description:
                        "JSON array text of exactly one { question, options, is_multi_select } " +
                        "object",
                },
            },
            required: ["questions"],
            roles: LEAD,
            route: "PUT /sessions/:dir/design/gate",
        },
        {
            name: "comments_list",
            description:
                "List the operator's preview comments: the open ones with their place (service, " +
                "URL, selector, component, source file:line), the screenshot path, the console " +
                "errors and the messages. Read a screenshot with the read tool.",
            parameters: {
                all: { type: "string", description: "`yes` to include resolved comments" },
            },
            required: [],
            roles: SESSION_ROLES,
            route: "GET /sessions/:dir/comments",
        },
        {
            name: "comment_reply",
            description:
                "Reply in a preview comment thread: what you changed, or a question. The " +
                "comment then waits on the operator.",
            parameters: {
                ...COMMENT_ID_PARAM,
                text: { type: "string", description: "The reply" },
            },
            required: ["id", "text"],
            roles: SESSION_ROLES,
            route: "POST /sessions/:dir/comments/:id/reply",
        },
        {
            name: "comment_suggest_resolve",
            description:
                "Suggest that a preview comment is resolved, after the change is made; say " +
                "what changed. Only the operator resolves.",
            parameters: {
                ...COMMENT_ID_PARAM,
                text: { type: "string", description: "What changed, one or two lines" },
            },
            required: ["id", "text"],
            roles: SESSION_ROLES,
            route: "POST /sessions/:dir/comments/:id/suggest-resolve",
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
    | "roster_row"
    /** One item of the Plan, Done when or Open questions; `item` says which and what. */
    | "item";

/**
 * The `item` mode of `PUT /sessions/:dir/mission/section`, on `plan` and `done_when`.
 * `add` on `plan` writes `- [ ] N. text (owner)` with N = max id + 1 and `owner` defaulting to
 * the author; on `done_when` it writes `- [ ] text`. `tick` writes `[x]` and `(owner, HH:MM)`;
 * `untick` drops the time; `edit` replaces the text; `assign` sets the owner; `reorder` takes
 * the ids in their new order (unlisted ones follow in their old order). A done_when item's id
 * is its 1-based position; Plan ids are the numbers in the file and never change. On
 * `open_questions` the mode takes `answer` and `resolve` with `id` (the position) and `text`;
 * see `QUESTION_ITEM_COMMANDS`.
 */
export interface MissionItemRequest {
    /** A `MissionItemCommand` on `plan` and `done_when`; a `QuestionItemCommand` on questions. */
    command: MissionItemCommand | QuestionItemCommand;
    id?: number;
    text?: string;
    owner?: string;
    /** `add` only: the doc entry the item belongs to, written as the `[2.3]` token. */
    entry?: string;
    order?: number[];
}

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
    /** For `item`: the command and its arguments. `text` is then unused. */
    item?: MissionItemRequest;
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
