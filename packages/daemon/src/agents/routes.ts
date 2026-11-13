// The agent-plumbing routes: `PUT /sessions/:dir/mission/section` (the serialized mission
// writer the extension's `mission_*` tools and the UI call), `POST /sessions/:dir/inbox` (a
// message file, delivered at once), `GET|PUT /sessions/:dir/agents/:name/context` (the
// Context tab), `POST /sessions/:dir/attach` (worktrees for a session adopted without a
// project, so an agent has somewhere to work) and `GET /sessions/:dir/agents/default-brief`
// (the brief `POST /sessions/:dir/agents` writes for an agent without one, for the UI form
// to prefill). Mounted on the daemon's Hono app by one registry line in `server.ts`, like the
// pipeline routes.
import type { Context, Hono } from "hono";
import type {
    AttachRequest,
    ContextFileRequest,
    ContextFileResponse,
    ContextResponse,
    DefaultBriefResponse,
    ErrorResponse,
    InboxMessageRequest,
    InboxMessageResponse,
    JobResponse,
    MissionItemRequest,
    MissionSectionRequest,
    MissionSectionResponse,
    MissionViewResponse,
    SessionResponse,
    SessionSummary,
} from "@spinner/protocol";
import * as actions from "../actions.js";
import type { ActionContext } from "../actions.js";
import type { SpinnerHome } from "../home.js";
import type { JobRunner, JobWork } from "../jobs/jobs.js";
import { attach_adopted } from "../pipeline/adopt.js";
import { attach_project } from "../stack/runner.js";
import { load_spec } from "../stack/spec.js";
import { find_session } from "../store/session-store.js";
import { MissionWriteError, type MissionWriter } from "../store/mission-writer.js";
import { agent_context, write_context_file, type ContextDeps } from "./context.js";
import type { Deliverer } from "./delivery.js";
import { validate_inbox_message, write_inbox_message } from "./inbox.js";
import { default_brief, type AgentManager } from "./manager.js";
import { parse_session_title } from "../requests.js";
import type { ViewBuilder } from "../watcher.js";

export interface AgentRouteDeps {
    home: SpinnerHome;
    agents: AgentManager;
    writer: MissionWriter;
    deliverer: Deliverer;
    ctx: ActionContext;
    jobs: JobRunner;
    /** Called after a job on `dir` finished, so the view carries fresh stack facts. */
    refresh: (dir: string) => Promise<void>;
    /** The session view, for `PUT /sessions/:dir/title`'s answer. */
    view: ViewBuilder;
    now?: () => Date;
}

const SECTIONS = ["goal", "done_when", "plan", "roster", "contracts", "open_questions", "log"];
const MODES = ["append", "replace", "roster_row", "item"];

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

    app.get("/sessions/:dir/mission/view", (c) => {
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        try {
            const body: MissionViewResponse = { view: deps.writer.view(summary.dir) };
            return c.json(body);
        } catch (error) {
            return c.json(error_body(describe_error(error)), 404);
        }
    });

    app.put("/sessions/:dir/title", async (c) => {
        const request = parse_session_title(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        // The title line is not a section; the write still waits its turn behind the writer.
        const author = c.req.query("author") ?? actions.OPERATOR_AUTHOR;
        let titled: { summary: SessionSummary; was: string | null };
        try {
            titled = await deps.writer.serialized(summary.dir, author, () =>
                actions.retitle(deps.ctx, summary, request, author),
            );
        } catch (error) {
            const status = error instanceof actions.TitlePinned ? 409 : 400;
            return c.json(error_body(describe_error(error)), status);
        }
        if (titled.was !== null) {
            await deps.writer.write(summary.dir, {
                section: "log",
                mode: "append",
                author,
                text: `title: ${titled.summary.session.title} (was ${titled.was})`,
            });
        }
        const body: SessionResponse = { session: deps.view(titled.summary) };
        return c.json(body);
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

    app.post("/sessions/:dir/attach", async (c) => {
        const request = parse_attach(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        let spec_path: string;
        try {
            spec_path = actions.resolve_project(deps.ctx, request.project);
        } catch (error) {
            return c.json(error_body(describe_error(error)), 400);
        }
        const blocker = attach_blocker(summary, load_spec(spec_path).spec.name);
        if (blocker !== null) {
            return c.json(error_body(blocker), 409);
        }
        return start_job(c, deps, summary.dir, async (log) => {
            // A session that tracks pull requests gets their head branches (an adopted
            // session); any other session gets worktrees on its own branch, as a new
            // session with a project does.
            const attached = tracks_pr(summary)
                ? await attach_adopted(deps.home, summary, { spec_path, gh: deps.ctx.gh, log })
                : await attach_project(summary, load_spec(spec_path), log);
            log(`project attached; next: spinner up ${attached.session.id}`);
        });
    });

    app.get("/sessions/:dir/agents/default-brief", (c) => {
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const repo = c.req.query("repo");
        const name = c.req.query("name") ?? "agent";
        if (repo !== undefined && summary.session.repos[repo] === undefined) {
            return c.json(error_body(`session ${summary.dir} has no repo "${repo}"`), 400);
        }
        const body: DefaultBriefResponse = { brief: default_brief(summary, name, repo) };
        return c.json(body);
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
    const item = record["item"];
    if (item !== undefined && (typeof item !== "object" || item === null || Array.isArray(item))) {
        return "`item` must be an object when given";
    }
    return {
        section: section as MissionSectionRequest["section"],
        mode: mode as MissionSectionRequest["mode"],
        text,
        author,
        ...(blocked === undefined ? {} : { blocked }),
        ...(item === undefined ? {} : { item: item as MissionItemRequest }),
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

function tracks_pr(summary: SessionSummary): boolean {
    return Object.values(summary.session.repos ?? {}).some(
        (repo) => repo.pr !== null && repo.pr !== undefined,
    );
}

/**
 * Why the project cannot be attached, or null. A session keeps the project it has: its
 * worktrees and its stack come from that spec. The same project attaches again (a spec that
 * gained a repo or a service).
 */
export function attach_blocker(summary: SessionSummary, project: string): string | null {
    const kind = summary.session.kind ?? "session";
    if (kind === "review") {
        return "a review session has no project";
    }
    const current = summary.session.project;
    if (current !== undefined && current !== project) {
        return `${summary.dir} has the project ${current}; a session keeps its project`;
    }
    return null;
}

export function parse_attach(input: unknown): AttachRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const project = record["project"];
    if (typeof project !== "string" || project.length === 0) {
        return "`project` must be a non-empty string";
    }
    return { project };
}

/** Starts the attach job and answers 202, or 409 when the session is busy. */
function start_job(c: Context, deps: AgentRouteDeps, session: string, work: JobWork): Response {
    const refreshed: JobWork = async (log, set_session) => {
        try {
            await work(log, set_session);
        } finally {
            await deps.refresh(session);
        }
    };
    try {
        const job = deps.jobs.start("attach", session, refreshed);
        const body: JobResponse = { job };
        return c.json(body, 202);
    } catch (error) {
        return c.json(error_body(describe_error(error)), 409);
    }
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
