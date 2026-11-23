// The Spinner pi extension (docs/SESSION_PROTOCOL.md, "What the pi extension provides").
// The daemon loads it into every agent with `--extension` and `SPINNER_SESSION_DIR`,
// `SPINNER_AGENT`, `SPINNER_DAEMON_URL`, `SPINNER_ROLE` in the environment. It adds the
// `spinner_session` prompt section on every run, registers the manifest's tools (the
// `thread_*` ones for the fixer role), guards `edit`/`write` outside the brief's owned globs,
// and registers `/spinner-reload`, which the daemon sends after a context edit. The daemon
// talks to pi over its rpc mode, not through this extension.
// Outside a Spinner session (no `SPINNER_SESSION_DIR`) it registers nothing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    EXTENSION_MANIFEST,
    LOCAL_ROUTE,
    redact_values,
    secret_values,
    type SecretValue,
    type SessionView,
} from "@spinner/protocol";
import { read_env, type SpinnerEnv } from "./env.js";
import {
    guard_edit,
    refuse_branch_change,
    refuse_operator_bash,
    refuse_process_sweep,
} from "./guard.js";
import type {
    ExtensionAPI,
    ToolDefinition,
    ToolResultEvent,
    ToolResultPatch,
} from "./pi-api.js";
import { load_session_files, render_prompt_section } from "./prompt.js";
import { daemon_client, run_tool, schema_of, type DaemonClient, type Fetch } from "./tools.js";

export interface SpinnerExtensionOptions {
    env?: NodeJS.ProcessEnv;
    fetch?: Fetch;
    /** For tests: a tool's wait between polls of a daemon job. */
    job_poll_ms?: number;
}

/** The factory pi calls. `register` is the testable core; this reads the real environment. */
export default function spinner_extension(pi: ExtensionAPI): void {
    register(pi, {});
}

export function register(pi: ExtensionAPI, options: SpinnerExtensionOptions): SpinnerEnv | null {
    const env = read_env(options.env ?? process.env);
    if (env === null) {
        return null;
    }
    const fetch_ = options.fetch ?? fetch;
    let client: DaemonClient | null = null;
    const client_of = (): DaemonClient => {
        client ??= daemon_client(env, fetch_);
        return client;
    };

    pi.on("before_agent_start", async (event) => {
        const view = await session_view(env, fetch_);
        const files = load_session_files(env, view);
        event.systemPromptOptions.sections["spinner_session"] = render_prompt_section(env, files);
    });

    for (const spec of EXTENSION_MANIFEST.tools) {
        if (!spec.roles.includes(env.role)) {
            continue;
        }
        const tool: ToolDefinition = {
            name: spec.name,
            label: spec.name.replace(/_/g, " "),
            description: spec.description,
            promptSnippet: spec.description,
            parameters: schema_of(spec),
            async execute(_id, params) {
                const client = spec.route === LOCAL_ROUTE ? null : client_of();
                const text = await run_tool(spec, params, env, client, options.job_poll_ms);
                return { content: [{ type: "text", text }], details: undefined };
            },
        };
        pi.registerTool(tool);
    }

    // Dogfood #48: the agent inherits the operator's secrets; no tool result may carry their
    // values into the transcript pi records. The environment is read once, at load.
    const secrets = secret_values(process.env);
    pi.on("tool_result", (event) => redacted_result(event, secrets));

    pi.on("tool_call", (event, ctx) => {
        if (event.toolName === "bash") {
            const command = String(event.input["command"] ?? "");
            const sweep = refuse_process_sweep(command) ?? refuse_branch_change(command);
            if (sweep !== null) {
                if (ctx.hasUI) {
                    ctx.ui.notify(sweep, "warning");
                }
                return { block: true, reason: sweep };
            }
        }
        if (env.role === "lead" && event.toolName === "bash") {
            // The lead never posts to Slack, approves, lands, resets or closes (MISSION.md
            // s014, Contracts); the operator does, in the UI or with `spinner`. GitHub
            // writes are refused too, unless the operator's settings give the lead full
            // GitHub access (`agents.github: full`).
            const command = event.input["command"];
            const reason = refuse_operator_bash(
                typeof command === "string" ? command : "",
                env.github,
            );
            if (reason === null) {
                return undefined;
            }
            if (ctx.hasUI) {
                ctx.ui.notify(reason, "warning");
            }
            return { block: true, reason };
        }
        if (event.toolName !== "edit" && event.toolName !== "write") {
            return undefined;
        }
        const path = event.input["path"];
        if (typeof path !== "string" || path.length === 0) {
            return undefined;
        }
        const verdict = guard_edit({
            path,
            cwd: ctx.cwd,
            session_dir: env.session_dir,
            brief: read_or_empty(join(env.session_dir, "agents", env.agent, "BRIEF.md")),
            mission: read_or_empty(join(env.session_dir, "MISSION.md")),
        });
        if (verdict.allow) {
            return undefined;
        }
        if (ctx.hasUI) {
            ctx.ui.notify(verdict.reason, "warning");
        }
        return { block: true, reason: verdict.reason };
    });

    pi.registerCommand("spinner-reload", {
        description: "Reload context files, skills and extensions after a Spinner context edit",
        handler: async (_args, ctx) => {
            await ctx.reload();
        },
    });
    return env;
}

/** `GET /sessions/:dir` for the hosts; null when the daemon does not answer in time. */
async function session_view(env: SpinnerEnv, fetch_: Fetch): Promise<SessionView | null> {
    if (env.daemon_url.length === 0) {
        return null;
    }
    try {
        const response = await fetch_(`${env.daemon_url}/sessions/${encodeURIComponent(env.dir)}`, {
            signal: AbortSignal.timeout(2_000),
        });
        if (!response.ok) {
            return null;
        }
        const body = (await response.json()) as { session: SessionView };
        return body.session;
    } catch {
        return null;
    }
}

function read_or_empty(path: string): string {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/**
 * The text parts of a tool result with the secret values replaced, or undefined when none
 * appears, so pi keeps the result as it was. A structured result is redacted through its
 * JSON text, since pi drops it when only `content` is replaced.
 */
export function redacted_result(
    event: ToolResultEvent,
    secrets: readonly SecretValue[],
): ToolResultPatch | undefined {
    if (secrets.length === 0) {
        return undefined;
    }
    let changed = false;
    const content = event.content.map((part) => {
        if (part.type !== "text") {
            return part;
        }
        const text = redact_values(part.text, secrets);
        changed ||= text !== part.text;
        return { ...part, text };
    });
    let structured = event.structuredContent;
    if (structured !== undefined) {
        const json = JSON.stringify(structured);
        const clean = redact_values(json, secrets);
        if (clean !== json) {
            changed = true;
            structured = JSON.parse(clean) as unknown;
        }
    }
    if (!changed) {
        return undefined;
    }
    return structured === undefined ? { content } : { content, structuredContent: structured };
}
