// The preview comment routes (s054, docs/DAEMON_API.md "Preview comments"):
// `POST /sessions/:dir/attachments` saves a PNG under `artifacts/comments/`, `GET
// .../attachments/:name` serves it back, `POST|GET /sessions/:dir/comments` create and list
// the threads, and `.../comments/:id/reply|suggest-resolve|resolve` move them. A new comment
// and the operator's reply go to the comment's agent at once (`deliver_message`), the
// screenshot as an image; the agent answers with the extension's `comment_*` tools, which
// call the same routes with its name as `author`. Every change mirrors the comments that wait
// on the operator into `session.yaml` and re-derives `needs_human`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import {
    ATTACHMENT_BYTES_MAX,
    COMMENT_MESSAGES_MAX,
    COMMENTS_MAX,
    comment_prompt_text,
    comment_reply_text,
    redact,
    type AttachmentResponse,
    type Comment,
    type CommentResponse,
    type CommentsResponse,
    type ErrorResponse,
    type SessionSummary,
} from "@spinner/protocol";
import type { EventBus } from "../event-bus.js";
import type { SpinnerHome } from "../home.js";
import { derive_stage } from "../pipeline/derive-stage.js";
import { config_for } from "../pipeline/poller.js";
import { facts_from_session } from "../pipeline/tracker.js";
import { find_session, write_session } from "../store/session-store.js";
import {
    attachment_path,
    list_comments,
    next_comment_id,
    parse_attachment,
    parse_comment_reply,
    parse_new_comment,
    read_comment,
    redact_anchor,
    save_attachment,
    session_comments,
    write_comment,
} from "./comments.js";
import type { AgentManager } from "./manager.js";

/** The JSON body of an attachment: base64 is 4/3 of the bytes, plus the wrapper. */
const ATTACHMENT_BODY_MAX = Math.ceil((ATTACHMENT_BYTES_MAX * 4) / 3) + 4096;

export const OPERATOR = "operator";

export interface CommentRouteDeps {
    home: SpinnerHome;
    agents: AgentManager;
    bus: EventBus;
    /** Publishes the session's view after `session.yaml` changed. */
    refresh: (dir: string) => Promise<void>;
    log: (line: string) => void;
    /** Directory `find_spec` searches when a session names no project. */
    cwd: string;
    /** Where the secret values come from; `process.env` when absent. */
    env?: Readonly<Record<string, string | undefined>>;
    now?: () => Date;
}

export function mount_comment_routes(app: Hono, deps: CommentRouteDeps): void {
    const now = deps.now ?? (() => new Date());
    const env = deps.env ?? process.env;

    app.post("/sessions/:dir/attachments", async (c) => {
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const too_large = error_body(`the image is larger than ${ATTACHMENT_BYTES_MAX} bytes`);
        if (Number(c.req.header("content-length") ?? "0") > ATTACHMENT_BODY_MAX) {
            return c.json(too_large, 413);
        }
        const text = await c.req.text();
        if (text.length > ATTACHMENT_BODY_MAX) {
            return c.json(too_large, 413);
        }
        const png = parse_attachment(parse_json(text));
        if (typeof png === "string") {
            return c.json(error_body(png), 400);
        }
        const body: AttachmentResponse = save_attachment(summary, png, now());
        return c.json(body, 201);
    });

    app.get("/sessions/:dir/attachments/:name", (c) => {
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const path = attachment_path(summary, c.req.param("name"));
        if (path === null) {
            return c.json(error_body(`no attachment ${c.req.param("name")}`), 404);
        }
        return c.body(readFileSync(path), 200, {
            "content-type": "image/png",
            "cache-control": "private, max-age=86400",
        });
    });

    app.get("/sessions/:dir/comments", (c) => {
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const body: CommentsResponse = { comments: list_comments(summary) };
        return c.json(body);
    });

    app.post("/sessions/:dir/comments", async (c) => {
        const request = parse_new_comment(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        if (summary.session.agents?.[request.agent] === undefined) {
            return c.json(error_body(`agent ${request.agent} is not in ${summary.dir}`), 404);
        }
        if (list_comments(summary).length >= COMMENTS_MAX) {
            return c.json(error_body(`${summary.dir} holds ${COMMENTS_MAX} comments`), 409);
        }
        if (request.anchor.kind !== "preview") {
            return c.json(error_body("only preview comments for now"), 400);
        }
        const anchor = redact_anchor(request.anchor, env);
        if (anchor.screenshot !== null && !exists_under(summary, anchor.screenshot)) {
            return c.json(error_body(`no attachment ${anchor.screenshot}`), 400);
        }
        const created = now().toISOString();
        const comment: Comment = {
            id: next_comment_id(summary),
            agent: request.agent,
            anchor,
            messages: [{ author: OPERATOR, text: redact(request.text, env), created }],
            state: "open",
            waiting_on: "agent",
            created,
            updated: created,
        };
        write_comment(summary, comment);
        const screenshot =
            anchor.screenshot === null ? null : join(summary.path, anchor.screenshot);
        const delivered = await deps.agents.deliver_message(
            summary.dir,
            comment.agent,
            comment_prompt_text(comment, screenshot),
            screenshot === null ? [] : [screenshot],
        );
        deps.log(`${summary.dir}: comment ${comment.id} to ${comment.agent}: ${delivered}`);
        await changed(deps, summary, comment, OPERATOR);
        const body: CommentResponse = { comment, delivered };
        return c.json(body, 201);
    });

    app.post("/sessions/:dir/comments/:id/reply", (c) => answer(c, deps, env, now, "reply"));
    app.post("/sessions/:dir/comments/:id/suggest-resolve", (c) =>
        answer(c, deps, env, now, "suggest"),
    );

    app.post("/sessions/:dir/comments/:id/resolve", async (c) => {
        const found = find_comment(c, deps);
        if ("error" in found) {
            return c.json(error_body(found.error), found.status);
        }
        const { summary, comment } = found;
        if (comment.state === "resolved") {
            const body: CommentResponse = { comment };
            return c.json(body);
        }
        const resolved: Comment = {
            ...comment,
            state: "resolved",
            waiting_on: "operator",
            updated: now().toISOString(),
        };
        write_comment(summary, resolved);
        await changed(deps, summary, resolved, OPERATOR);
        const body: CommentResponse = { comment: resolved };
        return c.json(body);
    });
}

/**
 * A reply (either side) or the agent's suggestion. The operator's reply goes to the agent
 * and makes the comment wait on it; an agent's message makes it wait on the operator.
 */
async function answer(
    c: Context,
    deps: CommentRouteDeps,
    env: Readonly<Record<string, string | undefined>>,
    now: () => Date,
    kind: "reply" | "suggest",
): Promise<Response> {
    const request = parse_comment_reply(await json_body(c));
    if (typeof request === "string") {
        return c.json(error_body(request), 400);
    }
    const found = find_comment(c, deps);
    if ("error" in found) {
        return c.json(error_body(found.error), found.status);
    }
    const { summary, comment } = found;
    const by_operator = request.author === OPERATOR;
    if (!by_operator && summary.session.agents?.[request.author] === undefined) {
        return c.json(error_body(`author ${request.author} is not in ${summary.dir}`), 400);
    }
    if (kind === "suggest" && by_operator) {
        return c.json(error_body("the operator resolves; only an agent suggests"), 400);
    }
    if (comment.state === "resolved") {
        return c.json(error_body(`comment ${comment.id} is resolved`), 409);
    }
    if (comment.messages.length >= COMMENT_MESSAGES_MAX) {
        const full = `comment ${comment.id} holds ${COMMENT_MESSAGES_MAX} messages`;
        return c.json(error_body(full), 409);
    }
    const created = now().toISOString();
    const message = { author: request.author, text: redact(request.text, env), created };
    const next: Comment = {
        ...comment,
        messages: [...comment.messages, message],
        state: kind === "suggest" ? "suggested" : by_operator ? "open" : comment.state,
        waiting_on: by_operator ? "agent" : "operator",
        updated: created,
    };
    write_comment(summary, next);
    let delivered: string | undefined;
    if (by_operator) {
        const text = comment_reply_text(next, message);
        delivered = await deps.agents.deliver_message(summary.dir, next.agent, text, []);
    }
    await changed(deps, summary, next, request.author);
    const body: CommentResponse =
        delivered === undefined ? { comment: next } : { comment: next, delivered };
    return c.json(body);
}

type Found =
    | { summary: SessionSummary; comment: Comment }
    | { error: string; status: 404 };

function find_comment(c: Context, deps: CommentRouteDeps): Found {
    const dir = c.req.param("dir") ?? "";
    const id = c.req.param("id") ?? "";
    const summary = find_session(deps.home, dir);
    if (summary === null) {
        return { error: `no session ${dir}`, status: 404 };
    }
    const comment = read_comment(summary, id);
    if (comment === null) {
        return { error: `no comment ${id} in ${summary.dir}`, status: 404 };
    }
    return { summary, comment };
}

/**
 * After a write: mirror the comments waiting on the operator into `session.yaml`, re-derive
 * `stage` and `needs_human`, publish the view, and send `comment.updated`.
 */
async function changed(
    deps: CommentRouteDeps,
    summary: SessionSummary,
    comment: Comment,
    author: string,
): Promise<void> {
    const fresh = find_session(deps.home, summary.dir) ?? summary;
    const session = fresh.session;
    const waiting = session_comments(list_comments(fresh));
    if (waiting === undefined) {
        delete session.comments;
    } else {
        session.comments = waiting;
    }
    const config = config_for(session, deps.home, deps.cwd, deps.log);
    const result = derive_stage(facts_from_session(session, config, new Date()));
    session.stage = result.stage;
    session.needs_human = result.needs_human;
    write_session(fresh);
    deps.bus.publish({
        type: "comment.updated",
        ts: new Date().toISOString(),
        session: fresh.dir,
        id: comment.id,
        state: comment.state,
        waiting_on: comment.waiting_on,
        author,
    });
    await deps.refresh(fresh.dir);
}

function exists_under(summary: SessionSummary, relative: string): boolean {
    const name = relative.split("/").pop() ?? "";
    return attachment_path(summary, name) !== null;
}

async function json_body(c: Context): Promise<unknown> {
    return parse_json(await c.req.text());
}

function parse_json(text: string): unknown {
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
