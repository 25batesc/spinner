// Assembles the `SessionView` the API returns and `session.updated` carries: the session file
// (store), the derived stage and PR facts (tracker), and the stack as the spec describes it
// plus the daemon's last docker observation. Pure apart from reading the session's spec copy,
// so a test builds a view from a summary and an observation.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
    BoardView,
    DesignView,
    DiffView,
    ReviewFields,
    ReviewProgress,
    ServiceStatus,
    ServiceView,
    SessionCost,
    SessionSummary,
    SessionUsage,
    SessionView,
    StackSpec,
    StackView,
    SwarmMember,
} from "@spinner/protocol";
import { LEAD_NAME } from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";
import { derive_stage } from "../pipeline/derive-stage.js";
import { briefing_path, read_draft } from "../pipeline/review-draft.js";
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
    /** The diff viewers of a session (s012); the feature reads as absent when not given. */
    diff?: (summary: SessionSummary) => DiffView;
    /** The session's spend from the cost ledger (s013); absent when not given. */
    cost?: (dir: string) => SessionCost;
    /** The design facts (EGM, 2.19); absent from the view when not given or undefined. */
    design?: (summary: SessionSummary) => DesignView | undefined;
    now: () => Date;
    log: (line: string) => void;
}

const PROXY_PORT_DEFAULT = 80;

export function build_session_view(ctx: ViewContext, summary: SessionSummary): SessionView {
    assert.ok(summary.dir.length > 0);
    const spec = session_spec_or_null(summary);
    const cost = ctx.cost?.(summary.dir);
    const review = build_review(summary, cost ?? null);
    const design = ctx.design?.(summary);
    return {
        summary,
        kind: summary.session.kind ?? "session",
        board: build_board(ctx, summary),
        stack: build_stack(
            summary,
            spec,
            ctx.observation(summary.dir),
            ctx.usage?.(summary.dir) ?? null,
        ),
        agents_running: ctx.agents_running(summary.dir),
        can_verify: summary.session.stack?.state === "up",
        diff: ctx.diff?.(summary) ?? DIFF_ABSENT,
        ...(cost === undefined ? {} : { cost }),
        ...(review === null ? {} : { review }),
        ...(design === undefined ? {} : { design }),
    };
}

/**
 * `SessionView.review` (s015, s016) for a review session, and for an ordinary session once
 * its swarm ran; null otherwise. The PR facts are the first tracked PR's: a review session
 * has one; an ordinary session's chips still show against its first PR. The briefing and
 * the draft are read from the session's artifacts.
 */
export function build_review(
    summary: SessionSummary,
    cost: SessionCost | null,
): ReviewFields | null {
    const session = summary.session;
    if (session.kind !== "review" && session.review === undefined) {
        return null;
    }
    const pr = session_prs(session)[0] ?? null;
    const swarm: SwarmMember[] = Object.entries(session.review?.swarm ?? {}).map(
        ([name, record]) => ({
            name,
            model: record.model,
            state: record.state,
            usd: cost?.agents[name]?.usd ?? 0,
            pr: record.pr,
            error: record.state === "failed" ? (record.error ?? null) : null,
        }),
    );
    const draft = read_draft(summary.path);
    const posted_url = session.review?.posted_url ?? null;
    // The lead's process stays up after the draft and after the post, waiting for the
    // operator; only a running turn (reconciling) counts as reviewing.
    const busy = swarm.some((m) => m.state === "queued" || m.state === "reading");
    const lead_busy = session.agents?.[LEAD_NAME]?.process === "running";
    let state: ReviewProgress = "idle";
    if (draft !== null) {
        state = "drafted";
    } else if (busy || lead_busy) {
        state = "reviewing";
    } else if (posted_url !== null) {
        state = "posted";
    }
    return {
        checks: pr?.checks ?? "pending",
        failing: pr?.checks_failing ?? [],
        review_decision: pr?.review ?? "none",
        threads:
            pr === null ? 0 : pr.threads.bots_open + pr.threads.humans_open + pr.threads.resolved,
        swarm,
        briefing: existsSync(briefing_path(summary.path)),
        draft,
        posted_url,
        state,
        comment_count: draft?.comments.length ?? 0,
        event: draft?.event ?? null,
    };
}

/** `SessionView.diff` for a daemon built without a `DiffManager` (route tests). */
const DIFF_ABSENT: DiffView = { available: false, fetch: "absent", fetch_error: null, repos: {} };

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
