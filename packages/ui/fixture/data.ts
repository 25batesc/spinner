// Canned data for the fixture server. It uses the real protocol types, so a change to
// `@spinner/protocol` that breaks the fixture also breaks `pnpm --filter ui typecheck`.
import type {
    BoardView,
    DiffRepoView,
    DiffView,
    MachineUsage,
    PrFacts,
    ReviewFields,
    ProjectView,
    ServiceStatus,
    ServiceUsage,
    ServiceView,
    Session,
    SessionView,
    StackUsage,
    StackView,
} from "@spinner/protocol";

import { sessionCost } from "./costs.ts";
import { fixturePort } from "./port.ts";

export const FIXTURE_PORT = fixturePort(process.env);

export const PROJECTS: ProjectView[] = [
    {
        name: "sample-stack",
        path: "/home/fixture/spinner/examples/sample-stack/spinner.yaml",
        source: "examples",
        repos: ["web", "api"],
        services: ["web", "api", "db"],
    },
];

export function session(
    partial: Partial<Session> & Pick<Session, "id" | "slug" | "title">,
): Session {
    return {
        version: 1,
        created: "2026-10-26T17:15:00Z",
        stage: "building",
        needs_human: null,
        branch: `spinner/${partial.id}`,
        base: "main",
        repos: {},
        stack: { state: "none" },
        agents: {},
        pipeline: { verified_locally: false, slack_post: null },
        ...partial,
    };
}

export function pr(number: number, repo: string, partial: Partial<PrFacts> = {}): PrFacts {
    return {
        repo,
        number,
        url: `https://github.com/example/${repo}/pull/${number}`,
        author: "operator",
        state: "open",
        head: "a1b2c3d",
        checks: "green",
        approval_check: "pending",
        approvals: { required: ["peer"], peer: [], owner: false },
        threads: { bots_open: 0, humans_open: 2, resolved: 1 },
        review: "none",
        bot_reviewed_head: null,
        queue: "none",
        last_activity: "2026-10-26T17:40:00Z",
        ...partial,
    };
}

const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** Made-up samples: a host process, a container with a limit, a container without one. */
export function serviceUsages(status: ServiceStatus): Record<string, ServiceUsage | null> {
    if (status !== "healthy") {
        return { web: null, api: null, db: null };
    }
    return {
        web: { cpu_pct: 3.2, mem_bytes: 180 * MB, pid: 44823 },
        api: {
            cpu_pct: 14.4, mem_bytes: 412 * MB, mem_limit_bytes: 2 * GB,
            net_rx_bytes: 12 * 1024, net_tx_bytes: 3.4 * MB, block_read_bytes: 0,
            block_write_bytes: 1.2 * MB, container: "9f3c2a1b7d6e4f5a",
        },
        db: {
            cpu_pct: 1.1, mem_bytes: 640 * MB, net_rx_bytes: 800 * 1024, net_tx_bytes: 2 * MB,
            block_read_bytes: 40 * MB, block_write_bytes: 96 * MB, container: "c1d2e3f4a5b6c7d8",
        },
    };
}

/** The stack's sum over `serviceUsages`, or null when the stack is not up. */
export function stackUsage(status: ServiceStatus): StackUsage | null {
    if (status !== "healthy") {
        return null;
    }
    const usages = Object.values(serviceUsages(status)).filter((u) => u !== null);
    return {
        cpu_pct: usages.reduce((sum, u) => sum + u.cpu_pct, 0),
        mem_bytes: usages.reduce((sum, u) => sum + u.mem_bytes, 0),
        sampled: new Date().toISOString(),
    };
}

/** The fixture machine: 32 GB with 22.2 GB free, so the context bar is not red. */
export function machineUsage(stacksUp: number, sessionsBytes: number): MachineUsage {
    return {
        mem_total_bytes: 32 * GB, mem_free_bytes: 22.2 * GB, cpu_count: 10, load_1m: 2.3,
        stacks_up: stacksUp, mem_sessions_bytes: sessionsBytes,
    };
}

export function serviceViews(id: string, status: ServiceStatus): ServiceView[] {
    const url = (host: string) => `http://${host}.${id}.localhost:${FIXTURE_PORT}`;
    const usage = serviceUsages(status);
    // `web` keeps its login in cookies (`preview: top-level`), the case the desktop app exists for.
    return [
        { name: "web", where: "host", status, host: `web.${id}.localhost`, url: url("web"),
          process: null, preview: "top-level", usage: usage["web"] ?? null },
        { name: "api", where: "container", status, host: `api.${id}.localhost`, url: url("api"),
          process: null, preview: "frame", usage: usage["api"] ?? null },
        { name: "db", where: "container", status, host: null, url: null, process: null,
          preview: "frame", usage: usage["db"] ?? null },
    ];
}

const STACK_STATUS = { up: "healthy", starting: "starting", down: "stopped" } as const;

export function stackView(id: string, state: "none" | keyof typeof STACK_STATUS): StackView {
    if (state === "none") {
        return {
            state, project: null, database: null, services: [], observed: null, last_job: null,
        };
    }
    return {
        state,
        project: `spinner-${id}`,
        database: `spinner_${id}`,
        services: serviceViews(id, STACK_STATUS[state]),
        observed: new Date().toISOString(),
        last_job: null,
        usage: stackUsage(STACK_STATUS[state]),
    };
}

/** A viewer at rest: no process, nothing waiting. */
export function diffRepoStopped(): DiffRepoView {
    return { state: "stopped", url: null, pid: null, error: null, waiting: { agent: 0, human: 0 } };
}

/** The fake viewer page the fixture serves for a repo; the UI embeds it as the daemon's URL. */
export function diffViewerUrl(port: number, repo: string): string {
    return `http://127.0.0.1:${port}/diffview/${repo}/`;
}

/**
 * `SessionView.diff` as the daemon sends it before any start: the sources are not fetched
 * and every repo of `session.yaml` is `stopped`.
 */
export function diffView(base: Session): DiffView {
    const repos = Object.fromEntries(
        Object.keys(base.repos).map((name) => [name, diffRepoStopped()]),
    );
    return { available: false, fetch: "absent", fetch_error: null, repos };
}

export function view(
    dir: string,
    base: Session,
    stack: StackView,
    prs: PrFacts[] = [],
    agentsRunning: string[] = [],
    diff: DiffView = diffView(base),
): SessionView {
    const board: BoardView | null =
        prs.length === 0
            ? null
            : { stage: base.stage, needs_human: base.needs_human, stale: false, prs };
    return {
        summary: { dir, path: `/home/fixture/.spinner/sessions/${dir}`, session: base },
        board,
        stack,
        can_verify: stack.state === "up",
        agents_running: agentsRunning,
        diff,
        cost: sessionCost(base),
    };
}

/**
 * A review session (s015): `kind: review`, one PR, no stack, the branch and base of the PR,
 * and the review fields. The swarm's reviewers are tty agents of the session, so a chip
 * click opens a terminal on the fixture's echo pty.
 */
export function reviewView(
    dir: string,
    base: Session,
    prFacts: PrFacts,
    review: ReviewFields,
    agentsRunning: string[] = [],
): SessionView {
    // One repo keyed by the GitHub repo name, as the contract has it: the diff tab has a repo.
    const repos = {
        [prFacts.repo]: {
            path: `/home/fixture/.spinner/reviews/example-${prFacts.repo}`,
            worktree: `worktrees/${prFacts.repo}`, changed: false,
        },
    };
    const withRepo = { ...base, repos };
    const plain = view(dir, withRepo, stackView(base.id, "none"), [prFacts], agentsRunning);
    return { ...plain, kind: "review", review };
}

const REVIEW_MODELS = ["anthropic/claude-opus-5-5", "openai/gpt-6-luna", "x-ai/grok-4.6"];

/** `review-<model-slug>`, as the daemon names a reviewer. */
export function reviewerName(model: string): string {
    return `review-${model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

/** The two reviews at the fixture's start: one swarm mid-flight, one not started. */
export function initialReviews(): SessionView[] {
    const upload = session({
        id: "r51", slug: "peanut-51", title: "Retry the upload on 5xx", kind: "review",
        created: "2026-11-02T09:30:00Z", stage: "peer-review",
        branch: "fix/retry-upload", base: "main",
        agents: Object.fromEntries(REVIEW_MODELS.map((model) => [
            reviewerName(model), { harness: "tty" as const, model, process: "running" as const },
        ])),
    });
    const uploadPr = pr(51, "peanut", {
        author: "casey", checks: "red", review: "changes_requested",
        threads: { bots_open: 3, humans_open: 1, resolved: 0 },
        last_activity: "2026-11-02T10:05:00Z", title: "Retry the upload on 5xx",
    });
    const swarm = [
        { name: reviewerName(REVIEW_MODELS[0] ?? ""), model: REVIEW_MODELS[0] ?? "",
          state: "posted" as const, usd: 0.42, pr: "peanut" },
        { name: reviewerName(REVIEW_MODELS[1] ?? ""), model: REVIEW_MODELS[1] ?? "",
          state: "reading" as const, usd: 0.11, pr: "peanut" },
        { name: reviewerName(REVIEW_MODELS[2] ?? ""), model: REVIEW_MODELS[2] ?? "",
          state: "queued" as const, usd: 0, pr: "peanut" },
    ];
    const dark = session({
        id: "r77", slug: "web-77", title: "Dark mode for the settings page", kind: "review",
        created: "2026-11-01T16:00:00Z", stage: "peer-review",
        branch: "feat/dark-settings", base: "main",
    });
    const darkPr = pr(77, "web", {
        author: "sam", checks: "green", review: "none",
        threads: { bots_open: 0, humans_open: 0, resolved: 0 },
        last_activity: "2026-11-01T16:20:00Z", title: "Dark mode for the settings page",
    });
    return [
        reviewView("r51-peanut-51", upload, uploadPr, {
            checks: "red", failing: ["lint", "e2e (chromium)"],
            review_decision: "changes_requested", threads: 4, swarm,
        }, swarm.filter((member) => member.state !== "queued").map((member) => member.name)),
        reviewView("r77-web-77", dark, darkPr, {
            checks: "green", failing: [], review_decision: "none", threads: 0, swarm: [],
        }),
    ];
}

export function initialSessions(): SessionView[] {
    const refund = session({
        id: "s17",
        slug: "refund-flow",
        title: "Refund flow",
        stage: "peer-review",
        needs_human: "Approve the refund copy in PR #412",
        repos: {
            web: { path: "~/code/web", worktree: "repos/web", changed: true },
            api: { path: "~/code/api", worktree: "repos/api", changed: false },
        },
        agents: {
            backend: { harness: "tty", model: "anthropic/claude-fable-5-1", process: "running" },
            frontend: { harness: "rpc", model: "anthropic/claude-sonnet-5-5", process: "idle" },
        },
    });
    const boot = session({
        id: "s001",
        slug: "bootstrap",
        title: "Bootstrap: Spinner builds Spinner",
        created: "2026-10-27T09:00:00Z",
    });
    return [
        view("s001-bootstrap", boot, stackView("s001", "none")),
        view("s17-refund-flow", refund, stackView("s17", "up"), [pr(412, "web"), pr(87, "api")], [
            "backend",
        ]),
    ];
}
