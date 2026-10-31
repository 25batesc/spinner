// The tools, built from `EXTENSION_MANIFEST`: each is one HTTP call to the daemon route the
// manifest names, and a short text for the model. The extension holds no state; the daemon
// serializes the mission writes and enforces the thread rules (409 with the reason). The
// `thread_resolve` pre-check reads the threads first so a missing reply is refused with a
// clear sentence before anything reaches GitHub.
import { Type, type TSchema, type TProperties } from "typebox";
import type {
    ExtensionToolSpec,
    InboxMessageResponse,
    MissionSectionRequest,
    MissionSectionResponse,
    PrThreadsView,
    SessionView,
    StackLogsResponse,
    ThreadResponse,
    ThreadView,
    ThreadsResponse,
} from "@spinner/protocol";
import type { SpinnerEnv } from "./env.js";
import { run_operator_tool } from "./tools-operator.js";

/** Time the daemon gets to answer one tool call. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** Upper bound on threads one `thread_list` prints; the rest are counted. */
const THREADS_LISTED_MAX = 60;

export type Fetch = typeof fetch;

export interface DaemonClient {
    get<T>(path: string): Promise<T>;
    /** A text route (`GET /sessions/:dir/mission`). */
    get_text(path: string): Promise<string>;
    send<T>(method: "POST" | "PUT", path: string, body: unknown): Promise<T>;
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
    const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        const response = await fetch_(`${env.daemon_url}${path}`, {
            method,
            headers: { "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
        send: (method, path, body) => request(method, path, body),
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
    if (spec.roles.every((role) => role === "operator")) {
        return run_operator_tool(spec.name, args, {
            client,
            ...(poll_ms === undefined ? {} : { poll_ms }),
        });
    }
    const dir = env.role === "operator" ? text("session").trim() : env.dir;
    if (dir.length === 0) {
        throw new Error("`session` must name a session directory; run session_list");
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
            return mission_write(client, session, {
                section: "open_questions",
                mode: "append",
                text: text("text"),
                author: env.agent,
            });
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
            return render_stack(await client.get<{ session: SessionView }>(session), command);
        }
        case "pr":
            return render_prs(await client.get<{ session: SessionView }>(session));
        case "thread_list": {
            const view = await client.get<ThreadsResponse>(`${session}/threads`);
            const repo = args["pr"] === undefined ? null : text("pr");
            return render_threads(
                view.threads.prs.filter((pr) => repo === null || pr.repo === repo),
            );
        }
        case "thread_reply":
            return thread_action(client, session, "reply", args, { text: text("text") });
        case "thread_flag":
            return thread_action(client, session, "flag", args, { reason: text("reason") });
        case "thread_resolve": {
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
        default:
            throw new Error(`${spec.name} is not implemented in this role`);
    }
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
