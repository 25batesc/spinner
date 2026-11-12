// The tools, built from `EXTENSION_MANIFEST`: each is one HTTP call to the daemon route the
// manifest names, and a short text for the model. The extension holds no state; the daemon
// serializes the mission writes and enforces the thread rules (409 with the reason). The
// `thread_resolve` pre-check reads the threads first so a missing reply is refused with a
// clear sentence before anything reaches GitHub.
import { Type, type TSchema, type TProperties } from "typebox";
import {
    DESIGN_GATE_OPTIONS_MAX,
    DIFF_TOOL_TIMEOUT_MS,
    DONE_WHEN_COMMANDS,
    MISSION_ITEM_COMMANDS,
    QUESTION_TOOL_COMMANDS,
} from "@spinner/protocol";
import type {
    DesignGateRequest,
    DiffCommentsRequest,
    DiffCommentsResponse,
    ExtensionToolSpec,
    InboxMessageResponse,
    Job,
    JobResponse,
    OkResponse,
    ReviewDraftResponse,
    MissionItemCommand,
    MissionItemRequest,
    MissionSectionRequest,
    MissionSectionResponse,
    MissionViewResponse,
    QuestionItemCommand,
    SessionResponse,
    PrThreadsView,
    SessionView,
    StackLogsResponse,
    ThreadResponse,
    ThreadView,
    ThreadsResponse,
} from "@spinner/protocol";
import type { SpinnerEnv } from "./env.js";
import { run_comment_tool } from "./tools-comments.js";
import { run_operator_tool, wait_job } from "./tools-operator.js";

/** Time the daemon gets to answer one tool call. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** Upper bound on threads one `thread_list` prints; the rest are counted. */
const THREADS_LISTED_MAX = 60;

export type Fetch = typeof fetch;

export interface DaemonClient {
    get<T>(path: string): Promise<T>;
    /** A text route (`GET /sessions/:dir/mission`). */
    get_text(path: string): Promise<string>;
    send<T>(method: "POST" | "PUT", path: string, body: unknown, timeout_ms?: number): Promise<T>;
}

/** An HTTP client on `env.daemon_url` that turns a non-2xx answer into an Error. */
export function daemon_client(env: SpinnerEnv, fetch_: Fetch = fetch): DaemonClient {
    if (env.daemon_url.length === 0) {
        throw new Error("SPINNER_DAEMON_URL is not set; the Spinner tools need the daemon");
    }
    const raw = async (method: string, path: string, body?: unknown): Promise<string> => {
        const response = await fetch_(`${env.daemon_url}${path}`, {
            method,
            headers: { "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`${method} ${path} → ${response.status}: ${error_of(text)}`);
        }
        return text;
    };
    const request = async <T>(
        method: string,
        path: string,
        body?: unknown,
        timeout_ms: number = REQUEST_TIMEOUT_MS,
    ): Promise<T> => {
        const response = await fetch_(`${env.daemon_url}${path}`, {
            method,
            headers: { "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(timeout_ms),
        });
        const text = await response.text();
        let parsed: unknown = null;
        try {
            parsed = text.length === 0 ? null : (JSON.parse(text) as unknown);
        } catch {
            parsed = null;
        }
        if (!response.ok) {
            const error =
                typeof parsed === "object" && parsed !== null && "error" in parsed
                    ? String((parsed as { error: unknown }).error)
                    : text;
            throw new Error(`${method} ${path} → ${response.status}: ${error}`);
        }
        return parsed as T;
    };
    return {
        get: (path) => request("GET", path),
        get_text: (path) => raw("GET", path),
        send: (method, path, body, timeout_ms) => request(method, path, body, timeout_ms),
    };
}

/** The `error` of a JSON error body, else the text itself. */
function error_of(text: string): string {
    try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
            return String((parsed as { error: unknown }).error);
        }
    } catch {
        // Not JSON; the text is the message.
    }
    return text;
}

/** The TypeBox schema for a manifest tool's parameters. */
export function schema_of(spec: ExtensionToolSpec): TSchema {
    const properties: TProperties = {};
    for (const [name, parameter] of Object.entries(spec.parameters)) {
        const options = { description: parameter.description };
        let schema: TSchema;
        if (parameter.enum !== undefined) {
            schema = Type.Union(
                parameter.enum.map((value) => Type.Literal(value)),
                options,
            );
        } else if (parameter.type === "number") {
            schema = Type.Number(options);
        } else {
            schema = Type.String(options);
        }
        properties[name] = spec.required.includes(name) ? schema : Type.Optional(schema);
    }
    return Type.Object(properties);
}

/**
 * A lead writes to GitHub as the operator only with `settings.agents.github: full`
 * (talk-change-ship.md, 1.4). The fixer is started by the operator's `fix`, so it is not held
 * to the setting.
 */
function refuse_guarded(env: SpinnerEnv, what: string): void {
    if (env.role === "lead" && env.github !== "full") {
        throw new Error(
            `${what} writes to GitHub as the operator, and GitHub access is guarded ` +
                "(settings: agents.github). Say what is ready; the operator does it.",
        );
    }
}

/**
 * `stack up`: the `run local` job, waited for. A stack that needs longer than the wait (a
 * first install) keeps starting; the answer says how to look again.
 */
async function stack_up(client: DaemonClient, session: string, poll_ms?: number): Promise<string> {
    const started = await client.send<JobResponse>("POST", `${session}/up`, {});
    let job: Job;
    try {
        job = await wait_job(client, started.job, poll_ms);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (reason.includes("is still running")) {
            return "The stack is still starting. Look again with `stack` `show` in a minute.";
        }
        throw error;
    }
    const tail = job.log.slice(-8).map((line) => `  ${line}`);
    return ["The stack is up. The job's last lines:", ...tail].join("\n");
}

/**
 * Runs one tool: the manifest's route with the model's arguments. Returns the model's text.
 * A session agent's tools act on its own session; the operator agent names one in `session`.
 */
export async function run_tool(
    spec: ExtensionToolSpec,
    args: Record<string, unknown>,
    env: SpinnerEnv,
    client: DaemonClient,
    poll_ms?: number,
): Promise<string> {
    const text = (key: string): string => String(args[key] ?? "");
    const operator_deps = { client, ...(poll_ms === undefined ? {} : { poll_ms }) };
    if (spec.roles.every((role) => role === "operator")) {
        return run_operator_tool(spec.name, args, operator_deps);
    }
    const dir = env.role === "operator" ? text("session").trim() : env.dir;
    if (dir.length === 0) {
        throw new Error("`session` must name a session directory; run session_list");
    }
    if (spec.name === "agent_add" || spec.name === "agent_steer") {
        // Shared with the operator role (s014): the lead acts on its own session.
        return run_operator_tool(spec.name, { ...args, session: dir }, operator_deps);
    }
    const session = `/sessions/${encodeURIComponent(dir)}`;
    // The routes take a repo key; models write `backend#100` as often as `backend`.
    if (typeof args["pr"] === "string") {
        args = { ...args, pr: repo_key(args["pr"]) };
    }
    switch (spec.name) {
        case "mission_roster":
            return mission_write(client, session, {
                section: "roster",
                mode: "roster_row",
                text: text("doing"),
                blocked: text("blocked"),
                author: env.agent,
            });
        case "mission_log":
            return mission_write(client, session, {
                section: "log",
                mode: "append",
                text: text("text"),
                author: env.agent,
            });
        case "mission_contract":
            return mission_write(client, session, {
                section: "contracts",
                mode: "append",
                text: text("text"),
                author: env.agent,
            });
        case "mission_question":
            return mission_write(client, session, question_request(args, env));
        case "message": {
            const body = {
                from: env.agent,
                to: text("to"),
                subject: text("subject"),
                text: text("text"),
            };
            const response = await client.send<InboxMessageResponse>(
                "POST",
                `${session}/inbox`,
                body,
            );
            return `Sent inbox/${response.file} to ${body.to}.`;
        }
        case "stack": {
            const command = text("command");
            if (command === "logs") {
                const service = text("service");
                const lines = typeof args["lines"] === "number" ? args["lines"] : 100;
                const query = `?lines=${encodeURIComponent(String(lines))}`;
                return render_logs(
                    await client.get<StackLogsResponse>(
                        `${session}/stack/logs/${encodeURIComponent(service)}${query}`,
                    ),
                );
            }
            if (command === "up") {
                return stack_up(client, session, poll_ms);
            }
            return render_stack(await client.get<{ session: SessionView }>(session), command);
        }
        case "pr": {
            if (text("command") !== "open") {
                return render_prs(await client.get<{ session: SessionView }>(session));
            }
            if (env.role !== "lead") {
                throw new Error("`pr open` is the lead's; ask the lead, or the operator");
            }
            refuse_guarded(env, "`pr open`");
            const started = await client.send<JobResponse>("POST", `${session}/pr`, {});
            const job = await wait_job(client, started.job, poll_ms);
            const tail = job.log.slice(-8).map((line) => `  ${line}`);
            return ["The pull request job ran. Its last lines:", ...tail].join("\n");
        }
        case "thread_list": {
            const view = await client.get<ThreadsResponse>(`${session}/threads`);
            const repo = args["pr"] === undefined ? null : text("pr");
            return render_threads(
                view.threads.prs.filter((pr) => repo === null || pr.repo === repo),
            );
        }
        case "thread_reply":
            refuse_guarded(env, "`thread_reply`");
            return thread_action(client, session, "reply", args, { text: text("text") });
        case "thread_flag":
            return thread_action(client, session, "flag", args, { reason: text("reason") });
        case "thread_resolve": {
            refuse_guarded(env, "`thread_resolve`");
            const view = await client.get<ThreadsResponse>(`${session}/threads`);
            const found = find_thread(view.threads.prs, text("thread"), args["pr"]);
            if (found === null) {
                throw new Error(`no thread ${text("thread")}; run thread_list`);
            }
            if (!found.thread.replied) {
                throw new Error(
                    `${found.thread.label} on ${found.pr.repo}#${found.pr.number} has no reply ` +
                        "from you yet; thread_reply first, then resolve",
                );
            }
            return thread_action(client, session, "resolve", args, {});
        }
        case "diff_comments":
        case "diff_reply":
            return diff_comments(client, session, env.agent, diff_request(spec.name, args));
        case "session_title": {
            const title = text("title").trim();
            if (title.length === 0) {
                throw new Error("`title` must not be empty");
            }
            const author = encodeURIComponent(env.agent);
            await client.send<SessionResponse>("PUT", `${session}/title?author=${author}`, {
                title,
            });
            return `Title set: ${title}.`;
        }
        case "mission_goal":
            return mission_write(client, session, {
                section: "goal",
                mode: "replace",
                text: text("text"),
                author: env.agent,
            });
        case "mission_done_when":
            return done_when_tool(client, session, env.agent, args);
        case "mission_plan": {
            const item = item_request(args);
            if (env.role === "worker") {
                await check_worker_tick(client, session, env.agent, item);
            }
            return mission_write(client, session, {
                section: "plan",
                mode: "item",
                text: "",
                author: env.agent,
                item,
            });
        }
        case "adopt": {
            const refs = text("refs")
                .split(/[\s,]+/)
                .filter((ref) => ref.length > 0);
            if (refs.length === 0) {
                throw new Error("`refs` must name at least one pull request");
            }
            const started = await client.send<JobResponse>("POST", `${session}/adopt`, { refs });
            const job = await wait_job(client, started.job, poll_ms);
            const tail = job.log.slice(-6).map((line) => `  ${line}`);
            return ["Adopted. The job's last lines:", ...tail].join("\n");
        }
        case "review_briefing": {
            const markdown = text("markdown");
            if (markdown.trim().length === 0) {
                throw new Error("`markdown` must not be empty");
            }
            await client.send<OkResponse>("PUT", `${session}/review/briefing`, { markdown });
            return "Briefing written: the operator sees it in the review pane.";
        }
        case "review_draft": {
            const body = {
                event: text("event").trim(),
                body: text("body"),
                comments: parse_comments(text("comments")),
            };
            const response = await client.send<ReviewDraftResponse>(
                "PUT",
                `${session}/review/draft`,
                body,
            );
            const count = response.draft.comments.length;
            return (
                `Draft written: ${response.draft.event}, "${response.draft.body}", ${count} line ` +
                `comment${count === 1 ? "" : "s"}. The operator posts or drops it from the ` +
                "review pane; do not post."
            );
        }
        case "design_doc": {
            const path = text("path").trim();
            await client.send<SessionResponse>("PUT", `${session}/design/doc`, { path });
            return `Spinner tracks ${path} as the design doc.`;
        }
        case "ask_question": {
            const gate = parse_gate(text("questions"));
            await client.send<OkResponse>("PUT", `${session}/design/gate`, gate);
            return (
                "The operator sees this question as buttons in Spinner and in your terminal. " +
                "End your turn now. The answer arrives as your next message."
            );
        }
        case "comments_list":
        case "comment_reply":
        case "comment_suggest_resolve":
            return run_comment_tool(spec.name, args, client, session, env.agent, env.session_dir);
        default:
            throw new Error(`${spec.name} is not implemented in this role`);
    }
}

/** `mission_done_when`: `set` replaces the list; the rest are item commands by position. */
async function done_when_tool(
    client: DaemonClient,
    session: string,
    author: string,
    args: Record<string, unknown>,
): Promise<string> {
    const command = String(args["command"] ?? "");
    if (command === "set") {
        const items = String(args["items"] ?? "")
            .split("\n")
            .map((line) => line.trim().replace(/^-\s*(?:\[[ x]\]\s*)?/, ""))
            .filter((line) => line.length > 0);
        if (items.length === 0) {
            throw new Error("`items` must hold at least one line for set");
        }
        return mission_write(client, session, {
            section: "done_when",
            mode: "replace",
            text: items.map((item) => `- [ ] ${item}`).join("\n"),
            author,
        });
    }
    if (!(DONE_WHEN_COMMANDS as readonly string[]).includes(command)) {
        throw new Error(`\`command\` must be one of ${DONE_WHEN_COMMANDS.join(", ")}`);
    }
    return mission_write(client, session, {
        section: "done_when",
        mode: "item",
        text: "",
        author,
        item: item_request(args),
    });
}

/**
 * `mission_question` (dogfood #43): `ask` (the default) appends a stamped question; `answer`
 * and `resolve` are the `item` mode on question `id`. Only the lead resolves; the daemon
 * refuses other authors too, so the check here only gives the model a clear message first.
 */
function question_request(args: Record<string, unknown>, env: SpinnerEnv): MissionSectionRequest {
    const command = String(args["command"] ?? "ask");
    const text = String(args["text"] ?? "");
    if (!(QUESTION_TOOL_COMMANDS as readonly string[]).includes(command)) {
        throw new Error(`\`command\` must be one of ${QUESTION_TOOL_COMMANDS.join(", ")}`);
    }
    if (command === "ask") {
        return { section: "open_questions", mode: "append", text, author: env.agent };
    }
    if (command === "resolve" && env.role !== "lead") {
        throw new Error("only the lead resolves a question; answer it instead");
    }
    const id = Number(args["id"]);
    if (!Number.isInteger(id) || id < 1) {
        throw new Error("`id` must be the question's number, as the mission shows it");
    }
    const item = { command: command as QuestionItemCommand, id, text: text.trim() };
    return { section: "open_questions", mode: "item", text: "", author: env.agent, item };
}

/**
 * A worker's `mission_plan` (dogfood r3.6): `tick` and `untick` only, on an item it owns or
 * that has no owner yet (a seeded item; the tick makes the worker its owner). The lead adds,
 * edits, assigns and reorders. Reads the mission view for the owner.
 */
async function check_worker_tick(
    client: DaemonClient,
    session: string,
    agent: string,
    item: MissionItemRequest,
): Promise<void> {
    if (item.command !== "tick" && item.command !== "untick") {
        throw new Error(
            `a worker only ticks and unticks its Plan items; ask the lead to ${item.command}`,
        );
    }
    const { view } = await client.get<MissionViewResponse>(`${session}/mission/view`);
    const target = view.plan.find((candidate) => candidate.id === item.id);
    if (target === undefined) {
        throw new Error(`no item ${String(item.id)} in the Plan`);
    }
    if (target.owner !== null && target.owner !== agent) {
        throw new Error(
            `item ${target.id} belongs to ${target.owner}; only its owner or the lead ticks it`,
        );
    }
}

/** The model's `mission_plan` or `mission_done_when` arguments as the route's `item`. */
function item_request(args: Record<string, unknown>): MissionItemRequest {
    const command = String(args["command"] ?? "");
    if (!(MISSION_ITEM_COMMANDS as readonly string[]).includes(command)) {
        throw new Error(`\`command\` must be one of ${MISSION_ITEM_COMMANDS.join(", ")}`);
    }
    const request: MissionItemRequest = { command: command as MissionItemCommand };
    const id = args["id"];
    if (id !== undefined && id !== "") {
        const number = Number(id);
        if (!Number.isInteger(number) || number < 1) {
            throw new Error("`id` must be the item's number, as the mission shows it");
        }
        request.id = number;
    }
    const text = args["text"];
    if (typeof text === "string" && text.trim().length > 0) {
        request.text = text.trim();
    }
    const owner = args["owner"];
    if (typeof owner === "string" && owner.trim().length > 0) {
        request.owner = owner.trim();
    }
    const entry = args["entry"];
    if (typeof entry === "string" && entry.trim().length > 0) {
        request.entry = entry.trim();
    }
    const order = args["order"];
    if (typeof order === "string" && order.trim().length > 0) {
        request.order = order
            .split(/[\s,]+/)
            .filter((part) => part.length > 0)
            .map((part) => {
                const number = Number(part);
                if (!Number.isInteger(number) || number < 1) {
                    throw new Error(`\`${part}\` is not an item id`);
                }
                return number;
            });
    }
    return request;
}

/** `diff_comments` and `diff_reply` arguments as the daemon's `DiffCommentsRequest`. */
function diff_request(
    tool: "diff_comments" | "diff_reply",
    args: Record<string, unknown>,
): DiffCommentsRequest {
    const command = String(args["command"] ?? "");
    if (tool === "diff_comments") {
        if (command !== "list" && command !== "show") {
            throw new Error("`command` must be `list` or `show`");
        }
        const threads = parse_ids(String(args["threads"] ?? ""));
        if (command === "show" && threads.length === 0) {
            throw new Error("`show` needs `threads`: one or more ids, separated by spaces");
        }
        return { command, threads };
    }
    if (command !== "reply" && command !== "suggest-resolve") {
        throw new Error("`command` must be `reply` or `suggest-resolve`");
    }
    const thread = Number(args["thread"]);
    if (!Number.isInteger(thread) || thread <= 0) {
        throw new Error("`thread` must be a thread id, as diff_comments shows it");
    }
    const text = String(args["text"] ?? "");
    if (text.trim().length === 0) {
        throw new Error("`text` must not be empty");
    }
    return { command, threads: [thread], text };
}

/** `"12 15"` to `[12, 15]`; anything that is not a positive integer is an error. */
function parse_ids(text: string): number[] {
    const ids: number[] = [];
    for (const word of text.split(/[\s,]+/).filter((w) => w.length > 0)) {
        const id = Number(word);
        if (!Number.isInteger(id) || id <= 0) {
            throw new Error(`\`${word}\` is not a thread id`);
        }
        ids.push(id);
    }
    return ids;
}

/**
 * Runs the CLI through the daemon and hands the model its stdout. A non-zero exit is an
 * error with the CLI's stderr, so the model sees why (`refused`, `no thread`).
 */
async function diff_comments(
    client: DaemonClient,
    session: string,
    agent: string,
    request: DiffCommentsRequest,
): Promise<string> {
    const response = await client.send<DiffCommentsResponse>(
        "POST",
        `${session}/agents/${encodeURIComponent(agent)}/diff/comments`,
        request,
        DIFF_TOOL_TIMEOUT_MS + 5_000,
    );
    if (response.code !== 0) {
        const reason = response.stderr.trim() || response.stdout.trim() || "no output";
        throw new Error(`diffview comments ${request.command} exited ${response.code}: ${reason}`);
    }
    return response.stdout.trimEnd() || "(no output)";
}

async function mission_write(
    client: DaemonClient,
    session: string,
    request: MissionSectionRequest,
): Promise<string> {
    const response = await client.send<MissionSectionResponse>(
        "PUT",
        `${session}/mission/section`,
        request,
    );
    return `MISSION.md updated: ${response.sections.join(", ")}.`;
}

async function thread_action(
    client: DaemonClient,
    session: string,
    action: "reply" | "resolve" | "flag",
    args: Record<string, unknown>,
    body: Record<string, string>,
): Promise<string> {
    const thread = encodeURIComponent(String(args["thread"] ?? ""));
    const pr = args["pr"] === undefined ? "" : `?pr=${encodeURIComponent(String(args["pr"]))}`;
    const response = await client.send<ThreadResponse>(
        "POST",
        `${session}/threads/${thread}/${action}${pr}`,
        body,
    );
    const view = response.thread;
    const state = view.flagged !== null ? `flagged (${view.flagged})` : view.state;
    return `${view.label} on ${response.repo}#${response.number}: ${action} done; now ${state}.`;
}

/** The `comments` text of `review_draft`: a JSON array; an empty text is no comments. */
export function parse_comments(text: string): unknown[] {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
        return [];
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        throw new Error(
            '`comments` must be a JSON array text: [{"path": "...", "line": 1, "body": "..."}]',
        );
    }
    if (!Array.isArray(parsed)) {
        throw new Error("`comments` must be a JSON array; [] for none");
    }
    return parsed;
}

/**
 * The one gate of `ask_question` (3.4): EGM's payload as JSON text, either the array of
 * questions or an object with a `questions` array, because EGM's examples show the object.
 * Throws the first fault, so the tool calls nothing for a payload that is not one
 * single-select question with 2 to `DESIGN_GATE_OPTIONS_MAX` options.
 */
export function parse_gate(text: string): DesignGateRequest {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text.trim());
    } catch {
        throw new Error(
            '`questions` must be JSON text: [{"question": "...", "options": ["...", "..."], ' +
                '"is_multi_select": false}]',
        );
    }
    const questions: unknown =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as { questions?: unknown }).questions
            : parsed;
    if (!Array.isArray(questions) || questions.length !== 1) {
        throw new Error("`questions` must hold exactly one question; ask the next one later");
    }
    const entry: unknown = questions[0];
    if (typeof entry !== "object" || entry === null) {
        throw new Error("the question must be an object { question, options, is_multi_select }");
    }
    const { question, options, is_multi_select } = entry as Record<string, unknown>;
    if (typeof question !== "string" || question.trim().length === 0) {
        throw new Error("`question` must be a non-empty string");
    }
    const valid_options =
        Array.isArray(options) &&
        options.length >= 2 &&
        options.length <= DESIGN_GATE_OPTIONS_MAX &&
        options.every((option) => typeof option === "string");
    if (!valid_options) {
        throw new Error(
            `\`options\` must be 2 to ${DESIGN_GATE_OPTIONS_MAX} strings; ask an open question ` +
                "in chat",
        );
    }
    if (is_multi_select === true) {
        throw new Error("EGM gates are single-select.");
    }
    return { question, options: options as string[] };
}

/** `backend#100`, `backend #100` or `backend` → `backend`. */
export function repo_key(pr: string): string {
    return pr.replace(/\s*#\d+\s*$/, "").trim();
}

/** A thread by node id, or by label within `pr` (or across PRs when the label is unique). */
export function find_thread(
    prs: readonly PrThreadsView[],
    key: string,
    pr: unknown,
): { pr: PrThreadsView; thread: ThreadView } | null {
    const matches: { pr: PrThreadsView; thread: ThreadView }[] = [];
    for (const entry of prs) {
        if (pr !== undefined && entry.repo !== String(pr)) {
            continue;
        }
        for (const thread of entry.threads) {
            if (thread.id === key || thread.label === key) {
                matches.push({ pr: entry, thread });
            }
        }
    }
    return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function render_threads(prs: readonly PrThreadsView[]): string {
    if (prs.length === 0) {
        return "No PR has a thread file yet.";
    }
    const lines: string[] = [];
    let listed = 0;
    for (const pr of prs) {
        const open = pr.threads.filter((thread) => thread.state === "open");
        lines.push(
            `${pr.repo}#${pr.number} · ${open.length} open ` +
                `(${pr.open_bot} bot, ${pr.open_human} human) · ${pr.resolved} resolved · ` +
                `${pr.flagged} flagged · checks ${pr.checks} · ${pr.url}`,
        );
        for (const thread of open) {
            if (listed >= THREADS_LISTED_MAX) {
                break;
            }
            listed += 1;
            const where = thread.path === null ? "" : ` · ${thread.path}:${thread.line ?? "-"}`;
            const marks = [
                thread.replied ? "replied" : "no reply",
                thread.flagged === null ? "" : `flagged: ${thread.flagged}`,
                thread.outdated ? "outdated" : "",
            ]
                .filter((mark) => mark.length > 0)
                .join(", ");
            lines.push(
                `- ${thread.label} [${thread.id}] ${thread.author_kind} ${thread.author}` +
                    `${where} (${marks})`,
            );
            lines.push(`  ${thread.body.trim().split("\n").join("\n  ")}`);
        }
    }
    return lines.join("\n");
}

export function render_prs(response: { session: SessionView }): string {
    const view = response.session;
    const board = view.board;
    if (board === null || board.prs.length === 0) {
        return `No PR yet; stage ${view.summary.session.stage}. Run \`spinner pr\` when ready.`;
    }
    const lines = [
        `Stage ${board.stage}` +
            (board.needs_human === null ? "" : ` · needs human: ${board.needs_human}`),
    ];
    for (const pr of board.prs) {
        const threads = pr.threads;
        lines.push(
            `- ${pr.repo}#${pr.number} ${pr.state} · checks ${pr.checks} · review ${pr.review}` +
                ` · threads ${threads.bots_open} bot + ${threads.humans_open} human open,` +
                ` ${threads.resolved} resolved · ${pr.url}`,
        );
    }
    return lines.join("\n");
}

export function render_stack(response: { session: SessionView }, command: string): string {
    const stack = response.session.stack;
    if (command !== "show") {
        return (
            `\`${command}\` is not available through the daemon yet; run ` +
            `\`spinner ${command} ${response.session.summary.dir} <service>\` ` +
            "with the bash tool."
        );
    }
    if (stack.services.length === 0) {
        return `This session has no stack (state ${stack.state}).`;
    }
    const lines = [
        `Stack ${stack.state}` + (stack.project === null ? "" : ` · project ${stack.project}`),
    ];
    for (const service of stack.services) {
        lines.push(
            `- ${service.name}: ${service.status}` +
                (service.url === null ? "" : ` · ${service.url}`),
        );
    }
    const last = stack.last_job;
    if (last !== null && last !== undefined && last.state === "failed") {
        lines.push(
            "",
            `Last job: \`${last.action}\` failed at ${last.finished}.`,
            `Error: ${last.error ?? "(no message)"}`,
            `Last ${last.tail.length} log lines:`,
            ...last.tail.map((line) => `  ${line}`),
        );
    }
    return lines.join("\n");
}

/** `stack logs`: the lines as they are, with a one-line header. */
export function render_logs(response: StackLogsResponse): string {
    const header = `${response.service} (${response.where}), last ${response.lines.length} lines:`;
    if (response.lines.length === 0) {
        return `${header} (empty)`;
    }
    return [header, ...response.lines].join("\n");
}
