// The agent-plumbing routes: `PUT /sessions/:dir/mission/section` (the serialized mission
// writer the extension's `mission_*` tools and the UI call), `POST /sessions/:dir/inbox` (a
// message file, delivered at once) and `GET|PUT /sessions/:dir/agents/:name/context` (the
// Context tab). Mounted on the daemon's Hono app by one registry line in `server.ts`, like
// the pipeline routes.
import type { Context, Hono } from "hono";
import type {
    ContextFileRequest,
    ContextFileResponse,
    ContextResponse,
    ErrorResponse,
    InboxMessageRequest,
    InboxMessageResponse,
    MissionSectionRequest,
    MissionSectionResponse,
} from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";
import { find_session } from "../store/session-store.js";
import { MissionWriteError, type MissionWriter } from "../store/mission-writer.js";
import { agent_context, write_context_file, type ContextDeps } from "./context.js";
import type { Deliverer } from "./delivery.js";
import { validate_inbox_message, write_inbox_message } from "./inbox.js";
import type { AgentManager } from "./manager.js";

export interface AgentRouteDeps {
    home: SpinnerHome;
    agents: AgentManager;
    writer: MissionWriter;
    deliverer: Deliverer;
    now?: () => Date;
}

const SECTIONS = ["goal", "done_when", "plan", "roster", "contracts", "open_questions", "log"];
const MODES = ["append", "replace", "roster_row"];

export function mount_agent_routes(app: Hono, deps: AgentRouteDeps): void {
    const now = deps.now ?? (() => new Date());
    const context_deps: ContextDeps = { agents: deps.agents };

    app.put("/sessions/:dir/mission/section", async (c) => {
        const request = parse_mission_section(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        try {
            const body: MissionSectionResponse = await deps.writer.write(summary.dir, request);
            return c.json(body);
        } catch (error) {
            const status = error instanceof MissionWriteError ? 400 : 500;
            return c.json(error_body(describe_error(error)), status);
        }
    });

    app.post("/sessions/:dir/inbox", async (c) => {
        const request = parse_inbox(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const file = write_inbox_message(summary.path, request, now());
        await deps.deliverer.deliver_inbox(summary.dir, file);
        const body: InboxMessageResponse = { file };
        return c.json(body, 201);
    });

    app.get("/sessions/:dir/agents/:name/context", async (c) => {
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const name = c.req.param("name");
        const body: ContextResponse = await agent_context(context_deps, summary, name);
        return c.json(body);
    });

    app.put("/sessions/:dir/agents/:name/context", async (c) => {
        const request = parse_context_file(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        try {
            const body: ContextFileResponse = await write_context_file(
                context_deps,
                summary,
                c.req.param("name"),
                request,
            );
            return c.json(body);
        } catch (error) {
            return c.json(error_body(describe_error(error)), 400);
        }
    });
}

export function parse_mission_section(input: unknown): MissionSectionRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const section = record["section"];
    if (typeof section !== "string" || !SECTIONS.includes(section)) {
        return `\`section\` must be one of ${SECTIONS.join(", ")}`;
    }
    const mode = record["mode"];
    if (typeof mode !== "string" || !MODES.includes(mode)) {
        return `\`mode\` must be one of ${MODES.join(", ")}`;
    }
    const text = record["text"];
    if (typeof text !== "string") {
        return "`text` must be a string";
    }
    const author = record["author"];
    if (typeof author !== "string" || author.length === 0) {
        return "`author` must be a non-empty string";
    }
    const blocked = record["blocked"];
    if (blocked !== undefined && typeof blocked !== "string") {
        return "`blocked` must be a string when given";
    }
    return {
        section: section as MissionSectionRequest["section"],
        mode: mode as MissionSectionRequest["mode"],
        text,
        author,
        ...(blocked === undefined ? {} : { blocked }),
    };
}

export function parse_inbox(input: unknown): InboxMessageRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const fields: Partial<Record<keyof InboxMessageRequest, string>> = {};
    for (const key of ["from", "to", "subject", "text"] as const) {
        const value = record[key];
        if (typeof value !== "string") {
            return `\`${key}\` must be a string`;
        }
        fields[key] = value;
    }
    const request = fields as InboxMessageRequest;
    const reason = validate_inbox_message(request);
    return reason ?? request;
}

export function parse_context_file(input: unknown): ContextFileRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const path = record["path"];
    const content = record["content"];
    if (typeof path !== "string" || path.length === 0) {
        return "`path` must be a non-empty string";
    }
    if (typeof content !== "string") {
        return "`content` must be a string";
    }
    return { path, content };
}

function as_record(input: unknown): Record<string, unknown> | string {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return "request body must be a JSON object";
    }
    return input as Record<string, unknown>;
}

async function json_body(c: Context): Promise<unknown> {
    const text = await c.req.text();
    if (text.trim().length === 0) {
        return undefined;
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return null;
    }
}

function error_body(error: string): ErrorResponse {
    return { error };
}

function describe_error(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
