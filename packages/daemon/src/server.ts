// The HTTP and WebSocket surface of spinnerd. Routes are the ones listed in
// `@spinner/protocol` `ROUTES`; the WebSocket at `EVENTS_PATH` forwards every bus event as one
// JSON message. Reads return `SessionView`s; writes start a job and answer 202. The server
// binds to loopback only and has no authentication (v1, single user). Route handlers parse,
// look up and answer; the work is in `actions.ts`, which the CLI calls too.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import { homedir } from "node:os";
import type { Duplex } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { WebSocketServer, type WebSocket } from "ws";
import { parse } from "yaml";
import type {
    ProjectCreateResponse,
    ProjectDetailResponse,
    NewSessionRequest,
    PlansResponse,
    GithubAccess,
    AgentCommandResponse,
    AgentEventsResponse,
    CostRow,
    CostsResponse,
    AgentNotRunningResponse,
    AgentResponse,
    BuildInfo,
    ErrorResponse,
    ExtractResponse,
    HealthResponse,
    JobAction,
    JobResponse,
    JobsResponse,
    ModelsResponse,
    ModelView,
    OkResponse,
    ProjectsResponse,
    SessionResponse,
    SessionsResponse,
    SessionSummary,
    Settings,
    SettingsResponse,
    StackLogsResponse,
    StackSpec,
    UsageResponse,
    SessionView,
    ThinkingLevel,
} from "@spinner/protocol";
import {
    DAEMON_HOST,
    DAEMON_PORT,
    EVENTS_CLIENT_DESKTOP,
    EVENTS_CLIENT_PARAM,
    EVENTS_PATH,
    LEAD_NAME,
    SETTINGS_DEFAULT,
    STACK_LOGS_LINES_DEFAULT,
    STACK_LOGS_LINES_MAX,
    USAGE_INTERVAL_MS,
    COSTS_REFOLD_INTERVAL_MS,
    UPLOAD_BYTES_MAX,
} from "@spinner/protocol";
import * as actions from "./actions.js";
import type { ActionContext } from "./actions.js";
import { Deliverer } from "./agents/delivery.js";
import { fixer_driver } from "./agents/fixer.js";
import { PiRpcHarness, type AgentHandle } from "./agents/harness.js";
import { PiTtyHarness } from "./agents/tty-harness.js";
import { mount_tty_routes, tty_upgrader } from "./agents/routes-tty.js";
import { mount_operator_routes } from "./agents/routes-operator.js";
import { mount_comment_routes } from "./agents/routes-comments.js";
import { OperatorHost } from "./agents/operator.js";
import { agent_history, agent_history_stamp } from "./agents/history.js";
import { AgentManager, FIRST_TURN } from "./agents/manager.js";
import { ReviewSwarm } from "./agents/swarm.js";
import { mount_agent_routes } from "./agents/routes.js";
import { ModelCatalog, fetch_models } from "./agents/models.js";
import { PiRefusal, resolve_pi_binary } from "./agents/pi-rpc.js";
import { message_images, parse_upload, save_upload, UPLOAD_BODY_MAX } from "./agents/uploads.js";
import { EventBus } from "./event-bus.js";
import type { SpinnerHome } from "./home.js";
import { JobRunner, type JobWork } from "./jobs/jobs.js";
import { DiffManager } from "./diff/manager.js";
import { mount_diff_routes } from "./diff/routes.js";
import { DesignTracker } from "./egm/design.js";
import { EgmFetcher } from "./egm/fetch.js";
import { clear_gate } from "./egm/gate.js";
import { GoldfishWatcher } from "./egm/goldfish.js";
import { mount_egm_routes } from "./egm/routes.js";
import { gh_runner, type GhRunner } from "./pipeline/github.js";
import { git_runner, type GithubWriter, type GitRunner } from "./pipeline/github-write.js";
import { event_notifier, macos_notifier, type Notifier } from "./pipeline/notify.js";
import { extract_refs } from "./pipeline/extract.js";
import { count_outcome, counts_as_operator_steer } from "./pipeline/outcomes.js";
import { poll_once, start_poller, type Poller, type PollOptions } from "./pipeline/poller.js";
import { start_syncer, SYNC_SECONDS_DEFAULT, type Syncer } from "./pipeline/sync.js";
import { mount_review_routes } from "./pipeline/review-routes.js";
import { start_review_lead } from "./agents/review-lead.js";
import { create_reviews, type CreateReviewsInput } from "./pipeline/reviews.js";
import { mount_pipeline_routes } from "./pipeline/routes.js";
import { watch_stack_jobs } from "./stack/job-record.js";
import { service_log_lines, StackLogsError } from "./stack/logs.js";
import { start_usage_sampler, type UsageSampler } from "./stack/usage.js";
import { start_cost_ledger, type LedgerLoop } from "./costs/ledger.js";
import { parse_span, report } from "./costs/periods.js";
import { list_themes, read_settings, write_settings } from "./settings.js";
import { snapshot_ui } from "./ui-snapshot.js";
import {
    create_project,
    delete_project,
    link_project,
    list_projects,
    project_detail,
    project_help,
    ProjectRefusal,
    save_project_spec,
} from "./projects.js";
import {
    parse_add_agent,
    parse_adopt,
    parse_agent_message,
    parse_agent_model,
    parse_agent_thinking,
    parse_extract,
    parse_new_session,
    parse_plan_implement,
    parse_reviews,
    parse_session_adopt,
    parse_up,
    parse_verify,
} from "./requests.js";
import { start_lead_session, type LeadStartDeps } from "./agents/lead.js";
import {
    attach_plan,
    implement_blocker,
    implement_message,
    plan_to_implement,
    PlanRefusal,
} from "./plans/implement.js";
import { import_designs, plan_doc_path, plan_views, read_plan } from "./plans/library.js";
import { MissionWriter, SPEC_AUTHOR } from "./store/mission-writer.js";
import {
    find_session,
    list_sessions,
    read_session,
    touch_interaction,
} from "./store/session-store.js";
import {
    build_session_view,
    session_spec_or_null,
    type ViewContext,
} from "./views/session-view.js";
import {
    OBSERVE_INTERVAL_MS,
    start_stack_observer,
    type StackObserver,
} from "./views/stack-observer.js";
import { watch_session_files } from "./watch/session-files.js";
import { watch_sessions, type SessionWatcher, type ViewBuilder } from "./watcher.js";

export interface DaemonOptions {
    home: SpinnerHome;
    /** TCP port. 0 asks the OS for a free port, which tests use. */
    port?: number;
    host?: string;
    /** Logger for one-line notices. Defaults to console.error so stdout stays clean. */
    log?: (line: string) => void;
    /** Directory `find_spec` searches when a session names no project. Defaults to cwd. */
    cwd?: string;
    /** The `gh` runner and the notifier of the poller; tests pass fakes. */
    gh?: GhRunner;
    /** `gh` and `git` for GitHub writes, behind the allow-list; tests pass fakes. */
    writer?: GithubWriter;
    /** `land`'s wait between looks at the merge queue; tests shorten it. */
    land_poll_ms?: number;
    /**
     * The banner the daemon shows while no desktop app is connected; `macos_notifier` when
     * absent. Every notification is also a `notify` event (`pipeline/notify.ts`).
     */
    notify?: Notifier;
    /** GitHub poll interval. 0 disables the poller. */
    poll_seconds?: number;
    /** Seconds between worktree sync rounds (`pipeline/sync.ts`); 0 is off. Default 15. */
    sync_seconds?: number;
    /** The built UI. Null means none; `GET /` then says how to build it. */
    ui_dir?: string | null;
    observe_interval_ms?: number;
    /** The usage sampler's interval; tests shorten it. */
    usage_interval_ms?: number;
    /** The cost ledger's refold timer; tests shorten it. */
    costs_refold_ms?: number;
    /** The pi executable; `SPINNER_PI` or `pi` on PATH when absent. Tests pass a fake. */
    pi?: string;
    /** The Spinner pi extension entry; the checkout's `packages/pi-extension` when absent. */
    extension?: string | null;
    /** `provider/model` for an agent that names none; pi's own default when absent. */
    default_model?: string;
    /** `config.yaml` `agents.harness`: `tty` (the default) or `rpc`. */
    agents_harness?: "tty" | "rpc";
    /** What `GET /health` reports as the build; `main.ts` reads it from the checkout. */
    build?: BuildInfo;
    /** Start the operator agent at boot when `settings.operator.enabled` allows. Default true. */
    operator?: boolean;
    /** For tests: the operator host's notice batch window. */
    operator_batch_ms?: number;
    /** The diff viewer's executable instead of the fetched checkout's; tests pass a fake. */
    diffview_bin?: string;
    /** The watchers' `diffview comments wait --timeout`; tests shorten it. */
    diff_wait_timeout?: string;
    /** `POST /reviews`: where a repository is cloned from; GitHub when absent. Tests: a path. */
    clone_url?: CreateReviewsInput["clone_url"];
    /** The cap on hosted agents (s015, the swarm queues behind it); tests lower it. */
    agents_running_max?: number;
    /** The review skill when `settings.review.skill` names none; the operator's when absent. */
    review_skill_default?: string;
}

export interface Daemon {
    /** The bound port, which differs from the requested one when 0 was asked for. */
    port: number;
    home: SpinnerHome;
    bus: EventBus;
    jobs: JobRunner;
    agents: AgentManager;
    /** The tty harness, so a test can look at an agent's pty. */
    tty: PiTtyHarness;
    /** The operator agent's host, so a test can look at its pty and its view. */
    operator: OperatorHost;
    watcher: SessionWatcher;
    /**
     * The notifier the poller and `land` call: the `notify` event, and the fallback banner
     * while no desktop app is connected. Exposed so a test can drive the choice.
     */
    notify: Notifier;
    close(): Promise<void>;
}

/** What the routes need. `start_daemon` builds one; a route test builds its own. */
export interface AppDeps {
    home: SpinnerHome;
    started: string;
    build: BuildInfo;
    log: (line: string) => void;
    ctx: ActionContext;
    jobs: JobRunner;
    view: ViewBuilder;
    /** Called after a job on `dir` finished, so the view carries fresh stack facts. */
    refresh: (dir: string) => Promise<void>;
    ui_dir: string | null;
    /** The snapshot's name under `<home>/ui`, for `GET /health`; null without a UI. */
    ui_commit: string | null;
    agents: AgentManager;
    /** The tty harness, for the pty WebSocket and the extension's routes; null without one. */
    tty?: PiTtyHarness | null;
    /** The operator agent's host; its routes mount when given. */
    operator?: OperatorHost;
    /** `GET /usage`; a route test passes a stub. */
    usage?: () => UsageResponse;
    /** `GET /costs`: the ledger's rows; a route test passes a stub. 503 when absent. */
    cost_rows?: () => CostRow[];
    models: () => Promise<ModelView[]>;
    bus: EventBus;
    /** ext: the mission writer and the deliverer; the agent routes mount when both are set. */
    writer?: MissionWriter;
    deliverer?: Deliverer;
    /** The diff viewers (s012); their routes mount when given. */
    diff?: DiffManager;
    /** The operator's settings, for the `review` step. */
    settings?: () => Settings;
    /** The review swarm (s015); `review` answers 503 without it. */
    swarm?: ReviewSwarm;
    /** `POST /reviews`: where a repository is cloned from; GitHub when absent. Tests: a path. */
    clone_url?: CreateReviewsInput["clone_url"];
    /** One GitHub poll round, after a posted review (s016); absent in a route test. */
    poll?: () => Promise<void>;
    /** The EGM fetcher; `/egm` mounts and a lead fetches EGM when given. */
    egm?: EgmFetcher;
    /** The design tracker (EGM, 2.26); the EGM routes mount with `egm` and `writer`. */
    design?: DesignTracker;
    /** The Goldfish watcher (EGM, 4.10); the EGM routes mount only with it. */
    goldfish?: GoldfishWatcher;
}

const POLL_SECONDS_DEFAULT = 60;

/** `packages/ui/dist`, from `packages/daemon/{src,dist}/server.{ts,js}`. */
export function default_ui_dir(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "dist");
}

/** Builds the Hono app alone, without sockets, so route tests can call `app.request()`. */
export function create_app(deps: AppDeps): Hono {
    const app = new Hono();
    // The Vite dev server proxies REST calls, but a built UI served from another origin or a
    // curl from a browser extension still benefits from permissive CORS on a loopback daemon.
    app.use("*", cors());

    app.get("/health", (c) => {
        const body: HealthResponse = {
            ok: true,
            home: deps.home.root,
            home_default: deps.home.root === join(homedir(), ".spinner"),
            started: deps.started,
            build: deps.build,
            ui_commit: deps.ui_commit,
        };
        return c.json(body);
    });

    app.get("/projects", (c) => {
        const body: ProjectsResponse = { projects: list_projects(deps.home, deps.log) };
        return c.json(body);
    });

    app.get("/projects/help", (c) => c.json(project_help()));

    // A project made from inside a session (the lead's `project` tool).
    app.post("/projects", async (c) => {
        const input = (await json_body(c)) as Record<string, unknown> | null;
        const spec = input?.["spec"];
        if (typeof spec !== "string" || spec.trim().length === 0) {
            return c.json(error_body("`spec` is required: the spinner.yaml as text"), 400);
        }
        try {
            const project = create_project(deps.home, spec, input?.["replace"] === true, deps.log);
            const body: ProjectCreateResponse = { project };
            return c.json(body, 201);
        } catch (error) {
            const status = error instanceof ProjectRefusal ? error.status : 400;
            return c.json(error_body(describe_error(error)), status);
        }
    });

    // The Projects view of the UI: a project's page, the operator's edit of its file, its
    // removal, and the registration of a spec kept elsewhere.
    const project_route = (c: Context, answer: (sessions: SessionSummary[]) => Response) => {
        try {
            return answer(list_sessions(deps.home).sessions);
        } catch (error) {
            if (error instanceof ProjectRefusal) {
                return c.json(error_body(error.message), error.status);
            }
            throw error;
        }
    };

    app.post("/projects/link", async (c) => {
        const input = (await json_body(c)) as Record<string, unknown> | null;
        const path = input?.["path"];
        if (typeof path !== "string" || path.length === 0) {
            return c.json(error_body("`path` is required: a spinner.yaml or its directory"), 400);
        }
        return project_route(c, (sessions) => {
            const body: ProjectDetailResponse = link_project(deps.home, path, sessions, deps.log);
            return c.json(body, 201);
        });
    });

    app.get("/projects/:name", (c) =>
        project_route(c, (sessions) => {
            const name = c.req.param("name");
            const body: ProjectDetailResponse = project_detail(deps.home, name, sessions, deps.log);
            return c.json(body);
        }),
    );

    app.put("/projects/:name/spec", async (c) => {
        const input = (await json_body(c)) as Record<string, unknown> | null;
        const spec = input?.["spec"];
        if (typeof spec !== "string" || spec.trim().length === 0) {
            return c.json(error_body("`spec` is required: the spinner.yaml as text"), 400);
        }
        return project_route(c, (sessions) => {
            const name = c.req.param("name");
            const body: ProjectDetailResponse =
                save_project_spec(deps.home, name, spec, sessions, deps.log);
            return c.json(body);
        });
    });

    app.delete("/projects/:name", (c) =>
        project_route(c, (sessions) => {
            delete_project(deps.home, c.req.param("name"), sessions, deps.log);
            const body: OkResponse = { ok: true };
            return c.json(body);
        }),
    );

    app.get("/sessions", (c) => {
        const result = list_sessions(deps.home);
        const body: SessionsResponse = { sessions: result.sessions.map(deps.view) };
        return c.json(body);
    });

    app.post("/sessions", async (c) => {
        const input = await json_body(c);
        const request = parse_new_session(input);
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        let summary;
        try {
            summary = actions.new_session(deps.ctx, request);
        } catch (error) {
            return c.json(error_body(describe_error(error)), 409);
        }
        const dir = summary.dir;
        if (request.text !== undefined) {
            // s014, chat first: attach, adopt, start the lead, send the paste as its message.
            return start_job(c, deps, "new", dir, (log) =>
                start_lead_session(lead_deps_of(deps), summary, request, log).then(() => {}),
            );
        }
        return start_job(c, deps, "new", dir, (log) =>
            actions.attach_new_session(deps.ctx, summary, request.project, log).then(() => {}),
        );
    });

    // A planning session (docs/designs/talk-change-ship.md, 4.2): `POST /sessions` with `plan`.
    app.post("/plans", async (c) => {
        const request = parse_new_session(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        if (request.text === undefined) {
            return c.json(error_body("`text` is required: what the plan is about"), 400);
        }
        const planned = { ...request, plan: true, track: "design" as const };
        let summary: SessionSummary;
        try {
            summary = actions.new_session(deps.ctx, planned);
        } catch (error) {
            return c.json(error_body(describe_error(error)), 409);
        }
        return start_job(c, deps, "new", summary.dir, (log) =>
            start_lead_session(lead_deps_of(deps), summary, planned, log).then(() => {}),
        );
    });

    app.get("/plans", (c) => {
        const body: PlansResponse = {
            plans: plan_views(deps.home, list_sessions(deps.home).sessions),
        };
        return c.json(body);
    });

    app.get("/plans/:id/doc", (c) => {
        const record = read_plan(deps.home, c.req.param("id"));
        const path = record === null ? null : plan_doc_path(deps.home, record);
        if (path === null) {
            return c.json(error_body(`no document for plan ${c.req.param("id")}`), 404);
        }
        return c.body(readFileSync(path, "utf8"), 200, { "content-type": "text/markdown" });
    });

    app.post("/plans/:id/implement", async (c) => {
        const request = parse_plan_implement(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const writer = deps.writer;
        if (writer === undefined) {
            return c.json(error_body("the mission writer is not available"), 503);
        }
        const implement = { home: deps.home, writer };
        try {
            const plan = plan_to_implement(deps.home, c.req.param("id"));
            if (request.session !== undefined) {
                const target = find_session(deps.home, request.session);
                if (target === null) {
                    return c.json(error_body(`no session ${request.session}`), 404);
                }
                const blocker = implement_blocker(target, plan);
                if (blocker !== null) {
                    return c.json(error_body(blocker), 409);
                }
                return start_job(c, deps, "plan", target.dir, async (log) => {
                    const seed = await attach_plan(implement, target, plan);
                    log(`plan ${plan.record.id} attached: ${seed.added} items added`);
                    await deps.design?.refresh(target.dir);
                    const text = implement_message(plan, seed);
                    const told = await tell_lead(deps.agents, target.dir, text, log);
                    log(told ? "the lead was told to implement it" : "the lead was not reached");
                });
            }
            // A new session for the plan: the plan is attached before its lead starts, so
            // the lead's first message is the plan and its board is seeded.
            const project = request.project ?? plan.record.project ?? undefined;
            const created = actions.new_session(deps.ctx, {
                title: plan.record.title,
                text: plan.record.title,
                ...(project === undefined ? {} : { project }),
            });
            return start_job(c, deps, "plan", created.dir, async (log) => {
                const seed = await attach_plan(implement, created, plan);
                log(`plan ${plan.record.id} attached: ${seed.added} items added`);
                const fresh = read_session(deps.home, created.dir);
                assert.ok(fresh.ok, fresh.ok ? "" : fresh.error);
                const start: NewSessionRequest = {
                    title: plan.record.title,
                    text: implement_message(plan, seed),
                    track: "direct",
                    ...(project === undefined ? {} : { project }),
                };
                await start_lead_session(lead_deps_of(deps), fresh.summary, start, log);
            });
        } catch (error) {
            const status = error instanceof PlanRefusal ? error.status : 409;
            return c.json(error_body(describe_error(error)), status);
        }
    });

    app.post("/sessions/extract", async (c) => {
        const request = parse_extract(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        try {
            const body: ExtractResponse = await actions.extract(deps.ctx, request);
            return c.json(body);
        } catch (error) {
            // A project that does not resolve is the caller's; GitHub trouble is a reason
            // on each entry, so what reaches here is the daemon's own fault.
            const message = describe_error(error);
            const status = message.includes("not found") || message.includes("no ") ? 400 : 500;
            return c.json(error_body(message), status);
        }
    });

    app.post("/sessions/:dir/adopt", async (c) => {
        const request = parse_session_adopt(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        if (summary.session.project === undefined) {
            return c.json(error_body(`${summary.dir} has no project; attach one first`), 409);
        }
        return start_job(c, deps, "adopt", summary.dir, async (log) => {
            const urls = await actions.adopt_refs(deps.ctx, summary, request, log);
            log(`adopted ${urls.length} PR${urls.length === 1 ? "" : "s"} into ${summary.dir}`);
        });
    });

    app.post("/sessions/adopt", async (c) => {
        const request = parse_adopt(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        return start_job(c, deps, "adopt", null, async (log, set_session) => {
            const summary = await actions.adopt(deps.ctx, request, log);
            set_session(summary.dir);
        });
    });

    app.post("/reviews", async (c) => {
        const request = parse_reviews(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        // The cheap half of the extractor runs here, so a paste without a PR is a 409 at
        // once; the job does the GitHub lookups, the clone and the worktree.
        if (extract_refs(request.text, []).refs.every((ref) => ref.owner === null)) {
            return c.json(error_body("no PR reference in the text"), 409);
        }
        return start_job(c, deps, "reviews", null, async (log, set_session) => {
            const result = await create_reviews(deps.home, {
                text: request.text,
                gh: deps.ctx.gh,
                log,
                ...(deps.clone_url === undefined ? {} : { clone_url: deps.clone_url }),
            });
            const first = result.sessions[0];
            assert.ok(first !== undefined, "create_reviews returns at least one session");
            set_session(first.dir);
            for (const summary of result.sessions) {
                await deps.refresh(summary.dir);
                // s016: the lead and the swarm start on the paste; the paste is the request.
                if (deps.swarm !== undefined) {
                    const lead_deps = { agents: deps.agents, swarm: deps.swarm };
                    await start_review_lead(lead_deps, summary, log);
                    await deps.refresh(summary.dir);
                }
            }
        });
    });

    app.get("/sessions/:dir", (c) => {
        const read = read_session(deps.home, c.req.param("dir"));
        if (!read.ok) {
            return c.json(error_body(read.error), 404);
        }
        const body: SessionResponse = { session: deps.view(read.summary) };
        return c.json(body);
    });

    app.get("/sessions/:dir/mission", (c) => {
        const file = join(deps.home.sessions, c.req.param("dir"), "MISSION.md");
        if (!existsSync(file)) {
            return c.json(error_body(`${file} does not exist`), 404);
        }
        return c.body(readFileSync(file, "utf8"), 200, { "content-type": "text/markdown" });
    });

    app.post("/sessions/:dir/up", async (c) => {
        const request = parse_up(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        return start_job(c, deps, "up", summary.dir, (log) =>
            actions.up(deps.ctx, summary, request, log).then(() => {}),
        );
    });

    app.post("/sessions/:dir/down", (c) => {
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        return start_job(c, deps, "down", summary.dir, (log) =>
            actions.down(deps.ctx, summary, log),
        );
    });

    app.post("/sessions/:dir/close", (c) => {
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        return start_job(c, deps, "close", summary.dir, (log) =>
            actions.close(deps.ctx, summary, log).then(() => {}),
        );
    });

    app.post("/sessions/:dir/verify", async (c) => {
        const request = parse_verify(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        return start_job(c, deps, "verify", summary.dir, async (log) => {
            actions.verify(deps.ctx, summary, request, log);
        });
    });

    // Untick is synchronous, not a job: it only rewrites `session.yaml`, and the checkbox
    // wants the new view in the answer. The watcher publishes `session.updated` too.
    app.delete("/sessions/:dir/verify", async (c) => {
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        let cleared;
        try {
            cleared = actions.unverify(deps.ctx, summary);
        } catch (error) {
            return c.json(error_body(describe_error(error)), 500);
        }
        await deps.refresh(summary.dir);
        const body: SessionResponse = { session: deps.view(cleared) };
        return c.json(body);
    });

    app.post("/sessions/:dir/agents", async (c) => {
        const request = parse_add_agent(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        // A listed agent is a resume: pi continues its transcript, so only an explicit
        // `message` is sent. A new agent gets the go signal, else it sits idle until the
        // operator types (dogfood row 37).
        const resumed = summary.session.agents?.[request.name] !== undefined;
        const text = request.message ?? (resumed ? null : FIRST_TURN);
        try {
            const handle = await deps.agents.add(summary, request);
            const first_turn =
                text === null
                    ? "none"
                    : await deps.agents.first_turn(summary.dir, request.name, handle, text);
            const body: AgentResponse = {
                name: request.name,
                pi_session_id: handle.pi_session_id,
                first_turn,
            };
            return c.json(body, 201);
        } catch (error) {
            // An agent that runs already, or a repo without a worktree, is the caller's
            // conflict; a pi that fails to start is the daemon's fault.
            const message = describe_error(error);
            const conflict = message.includes("already running") || message.includes("no worktree");
            const status = conflict ? 409 : 500;
            return c.json(error_body(message), status);
        }
    });

    for (const command of ["prompt", "steer"] as const) {
        app.post(`/sessions/:dir/agents/:name/${command}`, async (c) => {
            const request = parse_agent_message(await json_body(c));
            if (typeof request === "string") {
                return c.json(error_body(request), 400);
            }
            const name = c.req.param("name");
            const summary = find_session(deps.home, c.req.param("dir"));
            if (summary === null) {
                return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
            }
            const images = message_images(summary.path, request.images ?? []);
            if (typeof images === "string") {
                return c.json(error_body(images), 400);
            }
            let handle = deps.agents.get(summary.dir, name);
            let resumed = false;
            if (handle === null) {
                // An agent the session never had is a 404. A listed but stopped agent is
                // resumed for a message from the UI's box (dogfood #57); for any other
                // sender it is a 409 with its state.
                const listed = summary.session.agents?.[name];
                if (listed === undefined) {
                    return c.json(error_body(`agent ${name} is not in ${summary.dir}`), 404);
                }
                if (request.source !== "operator") {
                    const body: AgentNotRunningResponse = {
                        error: `agent ${name} is not running (${listed.process})`,
                        process: listed.process,
                    };
                    return c.json(body, 409);
                }
                try {
                    handle = await deps.agents.ensure_running(summary.dir, name);
                    resumed = true;
                } catch (error) {
                    return c.json(error_body(describe_error(error)), 500);
                }
            }
            // A prompt or steer to the lead answers its open EGM gate (T8, 3.10).
            if (name === LEAD_NAME && deps.design !== undefined) {
                if (clear_gate(deps.home, summary.dir)) {
                    await deps.design.refresh(summary.dir);
                }
            }
            if (request.source === "operator") {
                touch_interaction(deps.home, summary.dir, new Date());
            }
            try {
                // An agent resumed a moment ago has no turn to steer: the message starts one.
                const disposition = await handle[resumed ? "prompt" : command](
                    request.text,
                    images,
                );
                // The outcome counter (6.20, review v2 M-5): only a steer to the lead that
                // the UI's message box marked with `source: "operator"`.
                if (counts_as_operator_steer(command, name, request)) {
                    count_outcome(deps.home, summary.dir, "operator_steers");
                }
                const body: AgentCommandResponse = { ok: true, disposition };
                return c.json(body);
            } catch (error) {
                return c.json(error_body(describe_error(error)), 500);
            }
        });
    }

    app.post("/sessions/:dir/agents/:name/abort", async (c) => {
        const handle = running_agent(deps, c.req.param("dir"), c.req.param("name"));
        if (handle === null) {
            return c.json(error_body(`agent ${c.req.param("name")} is not running`), 404);
        }
        await handle.abort();
        const body: AgentCommandResponse = { ok: true };
        return c.json(body);
    });

    app.post("/sessions/:dir/agents/:name/compact", (c) => compact_agent(c, deps));

    app.post("/sessions/:dir/agents/:name/model", async (c) => {
        const request = parse_agent_model(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        return apply_agent_setting(c, deps, { model: request.model });
    });

    app.post("/sessions/:dir/agents/:name/thinking", async (c) => {
        const request = parse_agent_thinking(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        return apply_agent_setting(c, deps, { thinking: request.level });
    });

    app.post("/sessions/:dir/uploads", async (c) => {
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const too_large = error_body(`the file is larger than ${UPLOAD_BYTES_MAX} bytes`);
        if (Number(c.req.header("content-length") ?? "0") > UPLOAD_BODY_MAX) {
            return c.json(too_large, 413);
        }
        const text = await c.req.text();
        if (text.length > UPLOAD_BODY_MAX) {
            return c.json(too_large, 413);
        }
        const upload = parse_upload(parse_json_text(text));
        if ("error" in upload) {
            return c.json(error_body(upload.error), upload.status);
        }
        return c.json(save_upload(summary.path, upload, new Date()), 201);
    });

    app.post("/sessions/:dir/agents/:name/stop", async (c) => {
        try {
            const summary = find_session(deps.home, c.req.param("dir"));
            await deps.agents.stop(summary?.dir ?? c.req.param("dir"), c.req.param("name"));
        } catch (error) {
            return c.json(error_body(describe_error(error)), 404);
        }
        const body: AgentCommandResponse = { ok: true };
        return c.json(body);
    });

    app.get("/sessions/:dir/agents/:name/events", (c) => {
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const body: AgentEventsResponse = {
            events: agent_history(summary.path, c.req.param("name")),
        };
        return c.json(body);
    });

    app.get("/sessions/:dir/agents/:name/events/stamp", (c) => {
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const name = c.req.param("name");
        const active = deps.agents.last_event(summary.dir, name);
        return c.json(agent_history_stamp(summary.path, name, active));
    });

    app.get("/sessions/:dir/stack/logs/:service", async (c) => {
        const summary = find_session(deps.home, c.req.param("dir"));
        if (summary === null) {
            return c.json(error_body(`no session ${c.req.param("dir")}`), 404);
        }
        const lines = parse_lines(c.req.query("lines"));
        if (typeof lines === "string") {
            return c.json(error_body(lines), 400);
        }
        const service = c.req.param("service");
        if (!/^[a-z0-9][a-z0-9_-]*$/i.test(service)) {
            return c.json(error_body(`service name "${service}" is not valid`), 400);
        }
        try {
            const body: StackLogsResponse = await service_log_lines(summary, service, lines);
            return c.json(body);
        } catch (error) {
            const status = error instanceof StackLogsError ? error.status : 500;
            return c.json(error_body(describe_error(error)), status);
        }
    });

    app.get("/settings", (c) => {
        try {
            const body: SettingsResponse = read_settings(deps.home);
            return c.json(body);
        } catch (error) {
            return c.json(error_body(describe_error(error)), 500);
        }
    });

    app.put("/settings", async (c) => {
        const input = await json_body(c);
        if (input === undefined || input === null) {
            return c.json(error_body("request body must be the settings document"), 400);
        }
        const written = write_settings(deps.home, input);
        if (typeof written === "string") {
            return c.json(error_body(written), 400);
        }
        deps.bus.publish({
            type: "settings",
            ts: new Date().toISOString(),
            session: null,
            settings: written.settings,
        });
        return c.json(written);
    });

    app.get("/themes", (c) => {
        return c.json(list_themes(deps.home));
    });

    app.get("/costs", (c) => {
        if (deps.cost_rows === undefined) {
            return c.json(error_body("the cost ledger is not available"), 503);
        }
        const from = c.req.query("from");
        const to = c.req.query("to");
        const group = c.req.query("group");
        const span = parse_span(
            {
                ...(from === undefined ? {} : { from }),
                ...(to === undefined ? {} : { to }),
                ...(group === undefined ? {} : { group }),
            },
            { now: () => new Date() },
        );
        if (typeof span === "string") {
            return c.json(error_body(span), 400);
        }
        const title_of = (dir: string): string => session_title(deps.home, dir);
        const body: CostsResponse = report(deps.cost_rows(), span, title_of);
        return c.json(body);
    });

    app.get("/usage", (c) => {
        if (deps.usage === undefined) {
            return c.json(error_body("usage sampling is not available"), 503);
        }
        const body: UsageResponse = deps.usage();
        return c.json(body);
    });

    app.get("/models", async (c) => {
        try {
            const body: ModelsResponse = { models: await deps.models() };
            return c.json(body);
        } catch (error) {
            return c.json(error_body(describe_error(error)), 503);
        }
    });

    app.get("/jobs", (c) => {
        const body: JobsResponse = { jobs: deps.jobs.recent() };
        return c.json(body);
    });

    app.get("/jobs/:id", (c) => {
        const job = deps.jobs.get(c.req.param("id"));
        if (job === null) {
            return c.json(error_body(`no job ${c.req.param("id")}`), 404);
        }
        const body: JobResponse = { job };
        return c.json(body);
    });

    // engine: pr, fix, review, threads, post, approve, land, reset
    mount_pipeline_routes(app, deps);
    // engine (s016): the review lead's briefing, draft and post
    mount_review_routes(app, {
        home: deps.home,
        ctx: deps.ctx,
        refresh: deps.refresh,
        log: deps.log,
        ...(deps.writer === undefined ? {} : { writer: deps.writer }),
        ...(deps.poll === undefined ? {} : { poll: deps.poll }),
        ...(deps.swarm === undefined ? {} : { swarm: deps.swarm }),
        agents: deps.agents,
    });
    if (deps.diff !== undefined) {
        mount_diff_routes(app, { ...deps, diff: deps.diff });
    }
    if (
        deps.egm !== undefined &&
        deps.design !== undefined &&
        deps.writer !== undefined &&
        deps.goldfish !== undefined
    ) {
        mount_egm_routes(app, {
            fetcher: deps.egm,
            jobs: deps.jobs,
            design: deps.design,
            ctx: deps.ctx,
            view: deps.view,
            writer: deps.writer,
            agents: deps.agents,
            home: deps.home,
            goldfish: deps.goldfish,
        });
    }
    if (deps.writer !== undefined && deps.deliverer !== undefined) {
        // ext: mission section, inbox, context
        mount_agent_routes(app, { ...deps, writer: deps.writer, deliverer: deps.deliverer });
    }
    // s054: attachments and preview comments, delivered to the agents
    mount_comment_routes(app, {
        home: deps.home,
        agents: deps.agents,
        bus: deps.bus,
        refresh: deps.refresh,
        log: deps.log,
        cwd: deps.ctx.cwd,
        ...(deps.ctx.env === undefined ? {} : { env: deps.ctx.env }),
    });
    if (deps.tty !== undefined && deps.tty !== null) {
        mount_tty_routes(app, {
            home: deps.home,
            agents: deps.agents,
            tty: deps.tty,
            ...(deps.operator === undefined ? {} : { operator: deps.operator }),
        });
    }
    if (deps.operator !== undefined) {
        mount_operator_routes(app, { home: deps.home, operator: deps.operator });
    }
    mount_ui(app, deps.ui_dir);
    return app;
}

/** The agent of `:dir/:name`; `:dir` is a directory name or a session id. */
/**
 * `POST …/agents/:name/compact` (dogfood #45): starts pi's compaction in a hosted agent and
 * writes `compacted <agent> at NN %` as `spinner`, with the figure the board showed (`?`
 * while the window is unknown). A listed but stopped agent is a 409 with its state.
 */
async function compact_agent(c: Context, deps: AppDeps): Promise<Response> {
    const name = c.req.param("name") ?? "";
    const dir = c.req.param("dir") ?? "";
    const summary = find_session(deps.home, dir);
    if (summary === null) {
        return c.json(error_body(`no session ${dir}`), 404);
    }
    const handle = deps.agents.get(summary.dir, name);
    if (handle === null) {
        const listed = summary.session.agents?.[name];
        if (listed === undefined) {
            return c.json(error_body(`agent ${name} is not in ${summary.dir}`), 404);
        }
        const body: AgentNotRunningResponse = {
            error: `agent ${name} is not running (${listed.process})`,
            process: listed.process,
        };
        return c.json(body, 409);
    }
    const pct = deps.view(summary).cost?.agents[name]?.context?.pct;
    let disposition: string;
    try {
        disposition = await handle.compact();
    } catch (error) {
        return c.json(error_body(describe_error(error)), 500);
    }
    await deps.writer?.write(summary.dir, {
        section: "log",
        mode: "append",
        author: SPEC_AUTHOR,
        text: `compacted ${name} at ${pct === undefined ? "?" : String(pct)} %`,
    });
    const body: AgentCommandResponse = { ok: true, disposition };
    return c.json(body);
}

/**
 * `POST …/agents/:name/model` and `…/thinking`: the hosted agent's pi takes the setting, then
 * `session.yaml` records it and the view refreshes. 400 with pi's error when pi refuses it; a
 * listed but stopped agent is a 409 with its state.
 */
async function apply_agent_setting(
    c: Context,
    deps: AppDeps,
    setting: { model: string } | { thinking: ThinkingLevel },
): Promise<Response> {
    const name = c.req.param("name") ?? "";
    const dir = c.req.param("dir") ?? "";
    const summary = find_session(deps.home, dir);
    if (summary === null) {
        return c.json(error_body(`no session ${dir}`), 404);
    }
    const handle = deps.agents.get(summary.dir, name);
    if (handle === null) {
        const listed = summary.session.agents?.[name];
        if (listed === undefined) {
            return c.json(error_body(`agent ${name} is not in ${summary.dir}`), 404);
        }
        const body: AgentNotRunningResponse = {
            error: `agent ${name} is not running (${listed.process})`,
            process: listed.process,
        };
        return c.json(body, 409);
    }
    try {
        if ("model" in setting) {
            await handle.set_model(setting.model);
        } else {
            await handle.set_thinking(setting.thinking);
        }
    } catch (error) {
        return c.json(error_body(describe_error(error)), error instanceof PiRefusal ? 400 : 500);
    }
    deps.agents.record_setting(summary.dir, name, setting);
    await deps.refresh(summary.dir);
    const body: OkResponse = { ok: true };
    return c.json(body);
}

function running_agent(deps: AppDeps, dir: string, name: string): AgentHandle | null {
    const summary = find_session(deps.home, dir);
    if (summary === null) {
        return null;
    }
    return deps.agents.get(summary.dir, name);
}

/** Starts the job and answers 202, or 409 when the session is busy. */
function start_job(
    c: Context,
    deps: AppDeps,
    action: JobAction,
    session: string | null,
    work: JobWork,
): Response {
    const refreshed: JobWork = async (log, set_session) => {
        let dir = session;
        try {
            await work(log, (created) => {
                dir = created;
                set_session(created);
            });
        } finally {
            if (dir !== null) {
                await deps.refresh(dir);
            }
        }
    };
    try {
        const job = deps.jobs.start(action, session, refreshed);
        const body: JobResponse = { job };
        return c.json(body, 202);
    } catch (error) {
        return c.json(error_body(describe_error(error)), 409);
    }
}

/** The built UI at `/`. Without a build, `/` says what to run; the API stays up. */
function mount_ui(app: Hono, ui_dir: string | null): void {
    const index = ui_dir === null ? null : join(ui_dir, "index.html");
    if (index !== null && existsSync(index)) {
        app.use("/*", serveStatic({ root: ui_dir ?? "" }));
        app.get("/", (c) => c.html(readFileSync(index, "utf8")));
        return;
    }
    app.get("/", (c) =>
        c.text(
            [
                "spinnerd is running, but the UI is not built.",
                "Run `pnpm --filter @spinner/ui build` in the Spinner checkout, then reload.",
                ui_dir === null ? "" : `Looked for ${index ?? ""}.`,
                "Set SPINNER_UI_DIR to serve a build from another directory.",
            ].join("\n"),
            503,
        ),
    );
}

/** Starts the HTTP server, the WebSocket endpoint, the watcher, the observer and the poller. */
export async function start_daemon(options: DaemonOptions): Promise<Daemon> {
    const port = options.port ?? DAEMON_PORT;
    const host = options.host ?? DAEMON_HOST;
    const log = options.log ?? ((line) => console.error(line));
    assert.ok(port >= 0 && port <= 65535, `port ${port} out of range`);
    const home = options.home;
    const cwd = options.cwd ?? process.cwd();
    const started = new Date().toISOString();
    const bus = new EventBus();
    const jobs = new JobRunner(bus);
    // The open `/events` sockets of the desktop app; the notifier asks it on every call.
    const desktop: DesktopClients = { count: 0 };
    const notify = event_notifier({
        publish: (event) => bus.publish(event),
        desktop_clients: () => desktop.count,
        fallback: options.notify ?? macos_notifier,
    });
    const ctx: ActionContext = {
        home,
        cwd,
        gh: options.gh ?? gh_runner,
        ...(options.writer === undefined ? {} : { writer: options.writer }),
        notify,
        ...(options.land_poll_ms === undefined ? {} : { land_poll_ms: options.land_poll_ms }),
    };

    const pi = (): string => options.pi ?? resolve_pi_binary();
    let bound_port = port;
    const harness_options = {
        pi,
        on_stderr: (agent: string, line: string) => log(`pi ${agent}: ${line}`),
        daemon_url: () => `http://${host}:${bound_port}`,
        github_access: () => github_access_of(home),
        ...(options.extension === undefined ? {} : { extension: options.extension }),
        ...(options.default_model === undefined ? {} : { default_model: options.default_model }),
    };
    const tty = new PiTtyHarness(harness_options);
    const agents = new AgentManager(
        home,
        { default: options.agents_harness ?? "tty", tty, rpc: new PiRpcHarness(harness_options) },
        bus,
        {
            log,
            ...(options.agents_running_max === undefined
                ? {}
                : { running_max: options.agents_running_max }),
        },
    );
    const writer = new MissionWriter(home, bus);
    const deliverer = new Deliverer(home, agents, writer, bus, { log });
    const operator = new OperatorHost({
        home,
        tty,
        harness_options,
        bus,
        settings: () => read_settings_or_default(home, log),
        log,
        ...(options.operator_batch_ms === undefined ? {} : { batch_ms: options.operator_batch_ms }),
        cost: () => costs?.ledger.operator_cost() ?? { usd: 0, tokens_in: 0, tokens_out: 0 },
    });
    ctx.fixer = fixer_driver({ home, agents, cwd });

    const diff = new DiffManager({
        home,
        cwd,
        log,
        notify: (dir, text) => agents.notify_all(dir, text),
        ...(options.diffview_bin === undefined ? {} : { bin: options.diffview_bin }),
        ...(options.diff_wait_timeout === undefined
            ? {}
            : { wait_timeout: options.diff_wait_timeout }),
    });
    let observer: StackObserver | null = null;
    let usage: UsageSampler | null = null;
    let costs: LedgerLoop | null = null;
    // Late-bound: `view_ctx` is built before `refresh`, which the tracker needs.
    let design: DesignTracker | null = null;
    // The model list gives each agent's context window (#45); once it loads, every session
    // republishes so the chips show the figure without waiting for the next event.
    const catalog = new ModelCatalog(() => fetch_models(pi(), home.root), {
        log,
        on_loaded: () => {
            for (const summary of list_sessions(home).sessions) {
                publish_view(summary.dir);
            }
        },
    });
    const view_ctx: ViewContext = {
        home,
        cwd,
        observation: (dir) => observer?.get(dir) ?? null,
        usage: (dir) => usage?.get(dir) ?? null,
        cost: (dir) =>
            costs?.ledger.session_cost(dir, (model) => catalog.window_of(model)) ?? {
                usd: 0,
                tokens_in: 0,
                tokens_out: 0,
                agents: {},
            },
        agents_running: (dir) => agents.running(dir),
        diff: (summary) => diff.view(summary),
        design: (summary) => design?.view(summary),
        now: () => new Date(),
        log,
    };
    const view: ViewBuilder = (summary) => build_session_view(view_ctx, summary);
    // `review.updated` (s015) rides on `session.updated`: every path that changes the
    // review facts (a poll, a swarm step, a thread write) publishes the view, and the
    // facts are compared here, so one place emits the event and the UI's chips never miss
    // a change that came through the file watcher.
    const review_last = new Map<string, string>();
    bus.subscribe((event) => {
        if (event.type === "session.closed") {
            review_last.delete(event.session);
            return;
        }
        if (event.type !== "session.updated" && event.type !== "session.created") {
            return;
        }
        const fields = event.data.review;
        if (fields === undefined) {
            return;
        }
        const encoded = JSON.stringify(fields);
        if (review_last.get(event.session) === encoded) {
            return;
        }
        review_last.set(event.session, encoded);
        bus.publish({ type: "review.updated", ts: event.ts, session: event.session, data: fields });
    });
    const publish_view = (dir: string): void => {
        const read = read_session(home, dir);
        if (read.ok) {
            const ts = new Date().toISOString();
            bus.publish({ type: "session.updated", ts, session: dir, data: view(read.summary) });
        }
    };
    const sessions_with_specs = (): { summary: SessionSummary; spec: StackSpec | null }[] =>
        list_sessions(home).sessions.map((summary) => ({
            summary,
            spec: session_spec_or_null(summary),
        }));
    observer = start_stack_observer(
        {
            sessions: sessions_with_specs,
            on_change: (dir) => {
                usage?.wake();
                publish_view(dir);
            },
            on_error: (dir, error) => {
                const reason = error instanceof Error ? error.message : String(error);
                log(`stack observer ${dir}: ${reason.split("\n")[0]}`);
            },
        },
        options.observe_interval_ms ?? OBSERVE_INTERVAL_MS,
    );
    usage = start_usage_sampler(
        { sessions: sessions_with_specs, bus, log },
        options.usage_interval_ms ?? USAGE_INTERVAL_MS,
    );
    const sampler = usage;
    costs = start_cost_ledger(
        { home, bus, log, on_session_changed: (dir) => publish_view(dir) },
        options.costs_refold_ms ?? COSTS_REFOLD_INTERVAL_MS,
    );
    const refresh = async (dir: string): Promise<void> => {
        await observer?.round();
        sampler.wake();
        publish_view(dir);
    };
    // The watcher comes before the tracker: the tracker reads the watcher, and the watcher's
    // `on_change` reads the late-bound `design` (4.10).
    const goldfish = new GoldfishWatcher({
        home,
        agents,
        bus,
        log,
        on_change: async (dir) => {
            await design?.refresh(dir);
            publish_view(dir);
        },
    });
    design = new DesignTracker({
        home,
        cwd,
        agents,
        bus,
        writer,
        refresh,
        log,
        goldfish,
        cost: (dir) => view_ctx.cost?.(dir) ?? { usd: 0, tokens_in: 0, tokens_out: 0, agents: {} },
    });
    const designs = design;

    const build = options.build ?? { version: "0.0.0", commit: null, built: null };
    // The poller starts after the port opens; a posted review asks it for a round through
    // this closure, or runs one round itself when polling is off.
    let poller: Poller | null = null;
    let syncer: Syncer | null = null;
    const poll_options: PollOptions = {
        ...poll_options_for(ctx, notify, log),
        autopilot: {
            enabled: () => github_access_of(home) === "full",
            tell: (dir, text) => tell_lead(agents, dir, text, log),
        },
    };
    const poll = async (): Promise<void> => {
        if (poller !== null) {
            await poller.round();
            return;
        }
        await poll_once(home, poll_options);
    };
    const swarm = new ReviewSwarm({
        home,
        agents,
        bus,
        settings: () => read_settings_or_default(home, log),
        log,
        refresh,
        ...(options.review_skill_default === undefined
            ? {}
            : { skill_default: options.review_skill_default }),
    });
    const ui_source = options.ui_dir === undefined ? default_ui_dir() : options.ui_dir;
    const ui = ui_source === null ? null : snapshot_ui(home, ui_source, build.commit, log);
    const app = create_app({
        home,
        started,
        build,
        log,
        ctx,
        jobs,
        view,
        refresh,
        ui_dir: ui === null ? ui_source : ui.dir,
        ui_commit: ui === null ? null : ui.commit,
        agents,
        tty,
        operator,
        usage: () => sampler.response(),
        cost_rows: () => costs?.ledger.rows() ?? [],
        models: () => catalog.list(),
        bus,
        writer,
        deliverer,
        diff,
        settings: () => read_settings_or_default(home, log),
        swarm,
        poll,
        egm: new EgmFetcher(home, process.env),
        design: designs,
        goldfish,
        ...(options.clone_url === undefined ? {} : { clone_url: options.clone_url }),
    });
    // Viewers outlive the daemon; the record is validated by pid identity before any view.
    await diff.reattach_all(list_sessions(home).sessions);
    // The watchers come up before the port opens: a client that sees `/health` answer must
    // find the daemon whole, so a session it creates at once is watched, and `main.ts`
    // writes `daemon.pid` right after this returns (the CLI's `daemon start` reads it).
    const unwatch_stack_jobs = watch_stack_jobs({ home, bus, agents, log });
    const watcher = watch_sessions(home, bus, view, { on_error: log });
    await watcher.ready;
    deliverer.prime(list_sessions(home).sessions.map((summary) => summary.dir));
    const files = watch_session_files(home, {
        on_mission: (dir) => deliverer.on_mission_change(dir),
        on_notes: (dir, agent) => deliverer.on_notes_change(dir, agent),
        on_inbox: (dir, file) => void deliverer.deliver_inbox(dir, file),
        on_design: (dir) => void designs.refresh(dir),
        on_error: log,
    });
    await files.ready;

    const server = await listen(app, host, port);
    const address = server.address();
    assert.ok(address !== null && typeof address === "object", "server must have a TCP address");
    bound_port = address.port;
    const ttys = tty_upgrader({ home, agents, tty, operator, log });
    const sockets = attach_events_socket(server, bus, desktop, log, ttys.handle);
    poller = start_github_poller(options, poll_options, log);
    syncer = start_worktree_syncer(options, options.writer?.git ?? git_runner, log);
    log(`spinnerd listening on http://${host}:${bound_port}, home ${home.root}`);
    for (const resumed of await agents.adopt_all()) {
        log(`adopt: resumed tty agent ${resumed} on its transcript`);
    }
    // The approved design of an older session becomes a plan of the library (4.4).
    for (const id of import_designs(home, new Date())) {
        log(`plans: imported the approved design of ${id}`);
    }
    await swarm.prime();
    await designs.prime();
    // The operator agent comes last: a session agent's adoption must not wait on it, and its
    // first notices (an agent that settled during adoption) are queued, not lost.
    if (options.operator !== false) {
        await operator.start_if_enabled();
    }

    return {
        port: bound_port,
        home,
        bus,
        jobs,
        agents,
        tty,
        operator,
        watcher,
        notify,
        close: async () => {
            unwatch_stack_jobs();
            swarm.close();
            await designs.close();
            await diff.close();
            await operator.close();
            goldfish.close();
            await agents.stop_all();
            poller?.stop();
            syncer?.stop();
            observer?.stop();
            sampler.stop();
            costs?.stop();
            deliverer.close();
            await files.close();
            await watcher.close();
            for (const socket of sockets.clients) {
                socket.terminate();
            }
            sockets.close();
            ttys.close();
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
                // Keep-alive connections from fetch would hold `close` for their idle timeout.
                server.closeAllConnections();
            });
        },
    };
}

/**
 * The GitHub poller as a daemon loop. A transition writes `session.yaml`, which the watcher
 * turns into `session.updated`; the notifier publishes `notify`. `poll_seconds: 0` is
 * off, for tests and for a machine without `gh`.
 */
/** What `start_lead_session` needs of the daemon: the agents, and EGM when it is wired. */
function lead_deps_of(deps: AppDeps): LeadStartDeps {
    return {
        home: deps.home,
        ctx: deps.ctx,
        agents: deps.agents,
        ...(deps.egm === undefined ? {} : { egm: deps.egm }),
        ...(deps.design === undefined ? {} : { design: deps.design }),
        ...(deps.writer === undefined ? {} : { writer: deps.writer }),
    };
}

/**
 * The autopilot's message to a session's lead (docs/designs/talk-change-ship.md, 1.5): a
 * stopped lead is resumed for it. False when the session has no lead or pi does not start;
 * the poller then tells the same facts at its next round.
 */
async function tell_lead(
    agents: AgentManager,
    dir: string,
    text: string,
    log: (line: string) => void,
): Promise<boolean> {
    try {
        await agents.ensure_running(dir, LEAD_NAME);
    } catch (error) {
        log(`autopilot ${dir}: the lead was not reached: ${describe_error(error)}`);
        return false;
    }
    const delivered = await agents.deliver_message(dir, LEAD_NAME, text, []);
    log(`autopilot ${dir}: told the lead (${delivered})`);
    return true;
}

/** `settings.agents.github`; `guarded` when absent or when the file does not parse. */
function github_access_of(home: SpinnerHome): GithubAccess {
    try {
        return read_settings(home).settings.agents?.github ?? "guarded";
    } catch {
        return "guarded";
    }
}

/**
 * The worktree sync (`pipeline/sync.ts`): pushes each session branch that has a remote and
 * records what is not on the remote. Off with `sync_seconds: 0`, and off, like the GitHub
 * poller, when `poll_seconds` is 0 (tests, a machine without a remote).
 */
function start_worktree_syncer(
    options: DaemonOptions,
    git: GitRunner,
    log: (line: string) => void,
): Syncer | null {
    const seconds = options.sync_seconds ?? SYNC_SECONDS_DEFAULT;
    if (seconds === 0 || options.poll_seconds === 0) {
        return null;
    }
    // `sync_worktree` logs each push and each refusal itself.
    return start_syncer(options.home, { git, push: true, log }, seconds * 1000, () => {});
}

function start_github_poller(
    options: DaemonOptions,
    poll_options: PollOptions,
    log: (line: string) => void,
): Poller | null {
    const seconds = options.poll_seconds ?? POLL_SECONDS_DEFAULT;
    if (seconds === 0) {
        return null;
    }
    return start_poller(
        options.home,
        poll_options,
        seconds * 1000,
        (report) => {
            for (const failure of report.errors) {
                log(`poll ${failure.dir}: ${failure.error}`);
            }
            for (const { dir, transition } of report.transitions) {
                log(`poll ${dir}: ${transition.from} → ${transition.to}`);
            }
        },
    );
}

/** What one poll round needs: the read-only `gh`, the notifier and the Slack client. */
function poll_options_for(
    ctx: ActionContext,
    notify: Notifier,
    log: (line: string) => void,
): PollOptions {
    return {
        gh: ctx.gh,
        notify,
        cwd: ctx.cwd,
        log,
        slack: (summary) => actions.slack_of(ctx, summary),
    };
}

function listen(app: Hono, hostname: string, port: number): Promise<Server> {
    return new Promise((resolve) => {
        const server = serve({ fetch: app.fetch, hostname, port }, () => {
            resolve(server as Server);
        });
    });
}

/** The daemon's second WebSocket path: a tty agent's pty. True when `other` took the upgrade. */
type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;

/** The count of open `/events` sockets that the desktop app's main process holds. */
interface DesktopClients {
    count: number;
}

/**
 * Upgrades requests for `EVENTS_PATH` to WebSockets and forwards bus events to each client.
 * Any `Origin` is accepted: the UI dev server and the built UI run on different origins and
 * the daemon only listens on loopback. A socket opened with `?client=desktop` counts in
 * `desktop` until it closes, so a notification skips the `osascript` banner meanwhile. Every
 * other path is offered to `other` (the tty route) and is a 404 when it declines.
 */
function attach_events_socket(
    server: Server,
    bus: EventBus,
    desktop: DesktopClients,
    log: (line: string) => void,
    other: UpgradeHandler,
): WebSocketServer {
    const sockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
        const path = new URL(request.url ?? "/", "http://localhost").pathname;
        if (path !== EVENTS_PATH) {
            if (!other(request, socket, head)) {
                socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
                socket.destroy();
            }
            return;
        }
        sockets.handleUpgrade(request, socket, head, (client) => {
            sockets.emit("connection", client, request);
        });
    });
    sockets.on("connection", (client: WebSocket, request: IncomingMessage) => {
        const unsubscribe = bus.subscribe((event) => {
            if (client.readyState === client.OPEN) {
                client.send(JSON.stringify(event));
            }
        });
        const query = new URL(request.url ?? "/", "http://localhost").searchParams;
        const is_desktop = query.get(EVENTS_CLIENT_PARAM) === EVENTS_CLIENT_DESKTOP;
        if (is_desktop) {
            desktop.count += 1;
        }
        client.on("close", () => {
            unsubscribe();
            if (is_desktop) {
                desktop.count -= 1;
                assert.ok(desktop.count >= 0, "desktop client count went negative");
            }
        });
        client.on("error", (error) => log(`ws client error: ${error.message}`));
    });
    return sockets;
}

/** The settings, or the defaults when the file does not parse; the problem is logged. */
function read_settings_or_default(home: SpinnerHome, log: (line: string) => void): Settings {
    try {
        return read_settings(home).settings;
    } catch (error) {
        log(`settings: ${describe_error(error)}`);
        return SETTINGS_DEFAULT;
    }
}

/** The session's title from `session.yaml`, live or archived; the directory name without one. */
function session_title(home: SpinnerHome, dir: string): string {
    const live = read_session(home, dir);
    if (live.ok) {
        return live.summary.session.title;
    }
    const archived = join(home.archive, dir, "session.yaml");
    if (existsSync(archived)) {
        try {
            const parsed = parse(readFileSync(archived, "utf8")) as { title?: unknown };
            if (typeof parsed.title === "string" && parsed.title.length > 0) {
                return parsed.title;
            }
        } catch {
            // An unreadable archived file: the directory name stands in.
        }
    }
    return dir;
}

/** `?lines=` of the stack logs route: 1 to `STACK_LOGS_LINES_MAX`, default 100. */
function parse_lines(text: string | undefined): number | string {
    if (text === undefined || text === "") {
        return STACK_LOGS_LINES_DEFAULT;
    }
    const value = Number(text);
    if (!Number.isInteger(value) || value < 1 || value > STACK_LOGS_LINES_MAX) {
        return `\`lines\` must be an integer from 1 to ${STACK_LOGS_LINES_MAX}`;
    }
    return value;
}

/** The parsed JSON body, `undefined` for an empty body, or `null` for unparsable text. */
async function json_body(c: Context): Promise<unknown> {
    return parse_json_text(await c.req.text());
}

/** The parsed JSON, `undefined` for an empty body, null for one that does not parse. */
function parse_json_text(text: string): unknown {
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

export type { SessionView };
