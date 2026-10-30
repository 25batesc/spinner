// Assembles the `SessionView` the API returns and `session.updated` carries: the session file
// (store), the derived stage and PR facts (tracker), and the stack as the spec describes it
// plus the daemon's last docker observation. Pure apart from reading the session's spec copy,
// so a test builds a view from a summary and an observation.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
    BoardView,
    ServiceStatus,
    ServiceView,
    SessionSummary,
    SessionUsage,
    SessionView,
    StackSpec,
    StackView,
} from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";
import { derive_stage } from "../pipeline/derive-stage.js";
import { config_for } from "../pipeline/poller.js";
import { facts_from_session, session_prs } from "../pipeline/tracker.js";
import { SESSION_SPEC, read_session_spec } from "../stack/runner.js";

/** What the stack observer saw last for one session. */
export interface StackObservation {
    /** ISO 8601 time of the observation. */
    observed: string;
    /** Service name to status, for every service of the spec. */
    statuses: Record<string, ServiceStatus>;
}

export interface ViewContext {
    home: SpinnerHome;
    /** Directory `find_spec` searches when a session names no project. */
    cwd: string;
    /** The last observation per session directory, or none before the first round. */
    observation: (dir: string) => StackObservation | null;
    /** The last usage sample per session directory; none when the stack is down or unsampled. */
    usage?: (dir: string) => SessionUsage | null;
    /** Agents whose pi process the daemon hosts, per session directory. */
    agents_running: (dir: string) => string[];
    now: () => Date;
    log: (line: string) => void;
}

const PROXY_PORT_DEFAULT = 80;

export function build_session_view(ctx: ViewContext, summary: SessionSummary): SessionView {
    assert.ok(summary.dir.length > 0);
    const spec = session_spec_or_null(summary);
    return {
        summary,
        board: build_board(ctx, summary),
        stack: build_stack(
            summary,
            spec,
            ctx.observation(summary.dir),
            ctx.usage?.(summary.dir) ?? null,
        ),
        agents_running: ctx.agents_running(summary.dir),
        can_verify: summary.session.stack?.state === "up",
    };
}

/** The session's spec copy, or null when the session has no stack (adopted, or no project). */
export function session_spec_or_null(summary: SessionSummary): StackSpec | null {
    if (!existsSync(join(summary.path, SESSION_SPEC))) {
        return null;
    }
    return read_session_spec(summary).spec;
}

// A hand-written `session.yaml` may lack `repos` or `stack`; the store's shape check lets it
// through, so the view treats an absent block as empty rather than failing the whole event.
function build_board(ctx: ViewContext, summary: SessionSummary): BoardView | null {
    if (summary.session.repos === undefined) {
        return null;
    }
    const prs = session_prs(summary.session);
    if (prs.length === 0) {
        return null;
    }
    const config = config_for(summary.session, ctx.home, ctx.cwd, ctx.log);
    const result = derive_stage(facts_from_session(summary.session, config, ctx.now()));
    return { ...result, prs };
}

/** Pure: the stack view from the session file, its spec and the last observation. */
export function build_stack(
    summary: SessionSummary,
    spec: StackSpec | null,
    observation: StackObservation | null,
    usage: SessionUsage | null = null,
): StackView {
    const stack: SessionSummary["session"]["stack"] = summary.session.stack ?? { state: "none" };
    if (spec === null) {
        return {
            state: stack.state,
            project: null,
            database: null,
            services: [],
            observed: null,
            last_job: stack.last_job ?? null,
            usage: null,
        };
    }
    const http_port = spec.proxy?.http_port ?? PROXY_PORT_DEFAULT;
    const services: ServiceView[] = [];
    for (const [name, service] of Object.entries(spec.services)) {
        const host = stack.hosts?.[name] ?? null;
        const process = stack.processes?.[name] ?? null;
        services.push({
            name,
            where: service.runtime === "host" ? "host" : "container",
            status: service_status(stack.state, observation?.statuses[name]),
            host,
            url: host === null ? null : service_url(host, http_port),
            process,
            preview: service.preview ?? "frame",
            usage: usage?.services[name] ?? null,
        });
    }
    return {
        state: stack.state,
        project: stack.project ?? null,
        database: stack.db ?? null,
        services,
        observed: observation?.observed ?? null,
        last_job: stack.last_job ?? null,
        usage: usage?.stack ?? null,
    };
}

/**
 * The observation wins while the stack is up or starting; otherwise every service is
 * stopped, since `down` and `close` have run and the containers are gone or paused.
 */
function service_status(
    state: SessionSummary["session"]["stack"]["state"],
    observed: ServiceStatus | undefined,
): ServiceStatus {
    if (state === "up" || state === "starting" || state === "failed") {
        return observed ?? "unknown";
    }
    return "stopped";
}

export function service_url(host: string, http_port: number): string {
    return http_port === 80 ? `http://${host}` : `http://${host}:${http_port}`;
}
