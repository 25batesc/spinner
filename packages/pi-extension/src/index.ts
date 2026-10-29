// The Spinner pi extension (docs/SESSION_PROTOCOL.md, "What the pi extension provides").
// The daemon loads it into every agent with `--extension` and `SPINNER_SESSION_DIR`,
// `SPINNER_AGENT`, `SPINNER_DAEMON_URL`, `SPINNER_ROLE` in the environment. It adds the
// `spinner_session` prompt section on every run, registers the manifest's tools (the
// `thread_*` ones for the fixer role), guards `edit`/`write` outside the brief's owned globs,
// and registers `/spinner-reload`, which the daemon sends after a context edit. Under
// `SPINNER_HARNESS=tty` it also opens the daemon's channel into the interactive pi (`tty.ts`).
// Outside a Spinner session (no `SPINNER_SESSION_DIR`) it registers nothing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXTENSION_MANIFEST, type SessionView } from "@spinner/protocol";
import { read_env, type SpinnerEnv } from "./env.js";
import { guard_edit } from "./guard.js";
import type { ExtensionAPI, ToolDefinition } from "./pi-api.js";
import { load_session_files, render_prompt_section } from "./prompt.js";
import { daemon_client, run_tool, schema_of, type DaemonClient, type Fetch } from "./tools.js";
import { register_tty, type TtyChannel } from "./tty.js";

export interface SpinnerExtensionOptions {
    env?: NodeJS.ProcessEnv;
    fetch?: Fetch;
    /** For tests: the tty channel's retry delay and reported pid. */
    tty?: { retry_delay_ms?: number; pid?: number };
}

export interface Registered extends SpinnerEnv {
    /** The tty channel, when `SPINNER_HARNESS=tty`. */
    tty_channel: TtyChannel | null;
}

/** The factory pi calls. `register` is the testable core; this reads the real environment. */
export default function spinner_extension(pi: ExtensionAPI): void {
    register(pi, {});
}

export function register(pi: ExtensionAPI, options: SpinnerExtensionOptions): Registered | null {
    const env = read_env(options.env ?? process.env);
    if (env === null) {
        return null;
    }
    const fetch_ = options.fetch ?? fetch;
    let tty_channel: TtyChannel | null = null;
    if (env.tty && env.daemon_url.length > 0) {
        tty_channel = register_tty(pi, { env, fetch: fetch_, ...options.tty });
    }
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
        if (spec.role === "fixer" && env.role !== "fixer") {
            continue;
        }
        const tool: ToolDefinition = {
            name: spec.name,
            label: spec.name.replace(/_/g, " "),
            description: spec.description,
            promptSnippet: spec.description,
            parameters: schema_of(spec),
            async execute(_id, params) {
                const text = await run_tool(spec, params, env, client_of());
                return { content: [{ type: "text", text }], details: undefined };
            },
        };
        pi.registerTool(tool);
    }

    pi.on("tool_call", (event, ctx) => {
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
    return { ...env, tty_channel };
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
