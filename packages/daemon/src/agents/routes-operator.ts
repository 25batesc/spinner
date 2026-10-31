// The operator agent's routes (MISSION.md s013, Contracts "operator contract"): `GET
// /operator` (the view), `POST /operator/start|stop` (409 when the state does not allow it,
// 500 when pi fails to start), `POST /operator/prompt|steer` (through the extension channel,
// 409 while stopped). The pty WebSocket at `/operator/tty` and the extension's own routes
// live in `routes-tty.ts`, which both kinds of tty agent share. Also here: `PUT
// /sessions/:dir/agents/:name/brief`, the whole-file brief write the operator agent's
// `brief_write` tool and the UI use.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Context, Hono } from "hono";
import type {
    AgentBriefRequest,
    AgentBriefResponse,
    AgentCommandResponse,
    ErrorResponse,
    OperatorResponse,
} from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";
import { find_session } from "../store/session-store.js";
import { parse_agent_message } from "../requests.js";
import { agent_brief_path } from "./harness.js";
import type { OperatorHost } from "./operator.js";

/** Upper bound on one brief; the protocol asks for under 120 lines. */
const BRIEF_BYTES_MAX = 256 * 1024;

export interface OperatorRouteDeps {
    home: SpinnerHome;
    operator: OperatorHost;
}

export function mount_operator_routes(app: Hono, deps: OperatorRouteDeps): void {
    const operator = deps.operator;

    app.get("/operator", (c) => {
        const body: OperatorResponse = { operator: operator.view() };
        return c.json(body);
    });

    app.post("/operator/start", async (c) => {
        if (operator.running) {
            return c.json(error_body("the operator agent is already running"), 409);
        }
        try {
            const body: OperatorResponse = { operator: await operator.start() };
            return c.json(body);
        } catch (error) {
            return c.json(error_body(describe_error(error)), 500);
        }
    });

    app.post("/operator/stop", async (c) => {
        if (!operator.running) {
            return c.json(error_body("the operator agent is not running"), 409);
        }
        const body: OperatorResponse = { operator: await operator.stop() };
        return c.json(body);
    });

    for (const command of ["prompt", "steer"] as const) {
        app.post(`/operator/${command}`, async (c) => {
            const request = parse_agent_message(await json_body(c));
            if (typeof request === "string") {
                return c.json(error_body(request), 400);
            }
            const handle = operator.handle();
            if (handle === null) {
                return c.json(error_body("the operator agent is not running"), 409);
            }
            try {
                const disposition = await handle[command](request.text);
                const body: AgentCommandResponse = { ok: true, disposition };
                return c.json(body);
            } catch (error) {
                return c.json(error_body(describe_error(error)), 500);
            }
        });
    }

    app.put("/sessions/:dir/agents/:name/brief", async (c) => {
        const request = parse_brief(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const name = c.req.param("name");
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
            return c.json(error_body("`name` must be lower-case letters, digits and dashes"), 400);
        }
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const path = agent_brief_path(summary.path, name);
        mkdirSync(dirname(path), { recursive: true });
        const text = request.brief;
        writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
        const body: AgentBriefResponse = { ok: true, path };
        return c.json(body);
    });
}

export function parse_brief(input: unknown): AgentBriefRequest | string {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return "request body must be a JSON object";
    }
    const brief = (input as Record<string, unknown>)["brief"];
    if (typeof brief !== "string" || brief.trim().length === 0) {
        return "`brief` must be a non-empty string";
    }
    if (brief.length > BRIEF_BYTES_MAX) {
        return `\`brief\` is longer than ${BRIEF_BYTES_MAX} characters`;
    }
    return { brief };
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
