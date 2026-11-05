// Canned data for the fixture server. It uses the real protocol types, so a change to
// `@spinner/protocol` that breaks the fixture also breaks `pnpm --filter ui typecheck`.
import {
    EGM_ADAPTER_VERSION,
    EGM_LICENSE,
    EGM_NOTICE,
    EGM_SOURCE_URL,
    REVIEW_DRAFT_NEEDS_HUMAN,
    type BoardView,
    type DesignStage,
    type DesignView,
    type DiffRepoView,
    type DiffView,
    type EgmStatus,
    type MachineUsage,
    type PrFacts,
    type ProjectView,
    type ReviewDraft,
    type ReviewFields,
    type RoundView,
    type ServiceStatus,
    type ServiceUsage,
    type ServiceView,
    type Session,
    type SessionView,
    type StackUsage,
    type StackView,
    type SwarmMember,
} from "@spinner/protocol";

import { sessionCost } from "./costs.ts";
import { withGoldfish } from "./goldfish.ts";
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

/** The EGM commit the daemon pins (`packages/daemon/src/egm/pins.ts`), for `GET /egm`. */
export const EGM_PINNED_SHA = "a119668d7dc5d558664ba711d4671d11fb7270a8";

/**
 * `GET /egm` at the fixture's start: fetched at the pin, pi-subagents installed. The fetch
 * date is a past day, so a driver sees the line change after `POST /egm/fetch`.
 */
export function egmStatus(): EgmStatus {
    return {
        state: "ready",
        pinned_sha: EGM_PINNED_SHA,
        fetched_sha: EGM_PINNED_SHA,
        fetched_at: "2026-10-30T09:00:00Z",
        adapter_version: EGM_ADAPTER_VERSION,
        error: null,
        source: EGM_SOURCE_URL,
        license: EGM_LICENSE,
        notice: EGM_NOTICE,
        subagents: true,
    };
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

/** The window every fixture model has: 1M tokens, as the Opus and Sonnet models of pi. */
export const FIXTURE_CONTEXT_WINDOW = 1_000_000;

/**
 * The view with a context figure per agent (dogfood row 45), as the daemon reads it from the
 * agent's last assistant message: `pct` of the fixture window, or null for an unknown one.
 * An agent the record does not name keeps the figure it had.
 */
export function withContext(
    current: SessionView,
    figures: Readonly<Record<string, number | null>>,
): SessionView {
    const cost = current.cost;
    if (cost === undefined) {
        return current;
    }
    const agents = { ...cost.agents };
    for (const [name, pct] of Object.entries(figures)) {
        const agent = agents[name];
        if (agent === undefined) {
            continue;
        }
        const context = pct === null ? null : {
            tokens: Math.floor((FIXTURE_CONTEXT_WINDOW * pct) / 100),
            window: FIXTURE_CONTEXT_WINDOW,
            pct,
        };
        agents[name] = { ...agent, context };
    }
    return { ...current, cost: { ...cost, agents } };
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

/** The lead's briefing (s016), `artifacts/briefing.md`: plain words for the operator. */
export const BRIEFING_MD = [
    "# Retry the upload on 5xx",
    "",
    "Casey makes the upload client try again when the server answers 5xx. Three tries, with",
    "a pause that doubles each time.",
    "",
    "## What to look at",
    "",
    "- `src/upload.ts`: the retry loop. The pause is `attempt * 500` ms, not doubled.",
    "- `src/upload.test.ts`: the tests fake the clock, so the pauses are checked.",
    "",
    "## Risk",
    "",
    "A 5xx from a full disk retries three times and takes 3 seconds longer to fail. Low.",
].join("\n");

/** The briefing of the fixture's second review, the one with nothing to fix. */
export const DARK_BRIEFING_MD = [
    "# Dark mode for the settings page",
    "",
    "Sam adds a theme toggle to the settings page and stores the choice in `localStorage`.",
    "",
    "## What to look at",
    "",
    "- `src/settings/theme.ts`: the toggle and the stored preference.",
    "- `src/settings/theme.css`: the dark palette; every pair passes 4.5:1.",
    "",
    "## Risk",
    "",
    "None found. The reviewers agree.",
].join("\n");

/** The canned briefings by session directory, for the fixture's seed. */
export const BRIEFINGS: Record<string, string> = {
    "r51-peanut-51": BRIEFING_MD,
    "r77-web-77": DARK_BRIEFING_MD,
};

/** The lead's draft (s016), `artifacts/review-draft.json`: one review in one voice. */
export const DRAFT: ReviewDraft = {
    event: "COMMENT",
    body: [
        "Thanks, the retry is the right fix for the flaky uploads. Two things before merge:",
        "the pause does not double as the PR description says, and the test for the third",
        "failure asserts the wrong error.",
    ].join(" "),
    comments: [
        {
            path: "src/upload.ts", line: 42,
            body: "BUG: `attempt * 500` grows linearly; the description says the pause doubles. "
                + "`500 * 2 ** attempt`?",
        },
        {
            path: "src/upload.test.ts", line: 88,
            body: "NIT: This asserts `UploadError`; the third failure throws `RetryExhausted`.",
        },
    ],
};

/** `review-<model-slug>`, as the daemon names a reviewer. */
export function reviewerName(model: string): string {
    return `review-${model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

/** The lead's draft for a PR with nothing to fix (s018): `APPROVE`, no line comment. */
export const APPROVE_DRAFT: ReviewDraft = {
    event: "APPROVE",
    body: "The toggle, the stored preference and the contrast pass all read right. Nothing to fix.",
    comments: [],
};

/** The verdict a failed reviewer leaves (s018): the daemon's reason, for the chip's tooltip. */
export const REVIEWER_ERROR =
    "pi exited with code 1 before a VERDICT: model x-ai/grok-4.6 is not configured";

/**
 * The two reviews at the fixture's start (s018): one with a COMMENT draft of two comments
 * and one failed reviewer, one with an APPROVE draft of no comments. The agents are headless
 * (`harness: rpc`), so the pane has no terminal for them.
 */
export function initialReviews(): SessionView[] {
    const reviewerAgents = () => Object.fromEntries(REVIEW_MODELS.map((model) => [
        reviewerName(model), { harness: "rpc" as const, model, process: "idle" as const },
    ]));
    const upload = session({
        id: "r51", slug: "peanut-51", title: "Retry the upload on 5xx", kind: "review",
        created: "2026-11-02T09:30:00Z", stage: "peer-review",
        branch: "fix/retry-upload", base: "main",
        agents: reviewerAgents(),
    });
    const uploadPr = pr(51, "peanut", {
        author: "casey", checks: "red", review: "changes_requested",
        threads: { bots_open: 3, humans_open: 1, resolved: 0 },
        last_activity: "2026-11-02T10:05:00Z", title: "Retry the upload on 5xx",
    });
    // Two verdicts in and one reviewer failed, the briefing written, the draft waiting.
    const swarm: SwarmMember[] = REVIEW_MODELS.map((model, index) => ({
        name: reviewerName(model), model, state: "done", usd: 0.3 + index * 0.1,
        pr: "peanut", error: null,
    }));
    swarm[2] = { ...swarm[2]!, state: "failed", usd: 0, error: REVIEWER_ERROR };
    const lead = {
        harness: "rpc" as const, model: "anthropic/claude-opus-5-5", process: "idle" as const,
    };
    upload.agents["lead"] = lead;
    upload.needs_human = REVIEW_DRAFT_NEEDS_HUMAN;
    const dark = session({
        id: "r77", slug: "web-77", title: "Dark mode for the settings page", kind: "review",
        created: "2026-11-01T16:00:00Z", stage: "peer-review",
        branch: "feat/dark-settings", base: "main",
        agents: { ...reviewerAgents(), lead },
        needs_human: REVIEW_DRAFT_NEEDS_HUMAN,
    });
    const darkSwarm: SwarmMember[] = REVIEW_MODELS.map((model) => ({
        name: reviewerName(model), model, state: "done", usd: 0.2, pr: "web", error: null,
    }));
    const darkPr = pr(77, "web", {
        author: "sam", checks: "green", review: "none",
        threads: { bots_open: 0, humans_open: 0, resolved: 0 },
        last_activity: "2026-11-01T16:20:00Z", title: "Dark mode for the settings page",
    });
    return [
        reviewView("r51-peanut-51", upload, uploadPr, {
            checks: "red", failing: ["lint", "e2e (chromium)"],
            review_decision: "changes_requested", threads: 4, swarm,
            briefing: true, draft: DRAFT, posted_url: null,
            state: "drafted", comment_count: DRAFT.comments.length, event: DRAFT.event,
        }, ["lead"]),
        reviewView("r77-web-77", dark, darkPr, {
            checks: "green", failing: [], review_decision: "none", threads: 0, swarm: darkSwarm,
            briefing: true, draft: APPROVE_DRAFT, posted_url: null,
            state: "drafted", comment_count: 0, event: "APPROVE",
        }, ["lead"]),
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
    const refundView = view(
        "s17-refund-flow", refund, stackView("s17", "up"), [pr(412, "web"), pr(87, "api")],
        ["backend"],
    );
    return [
        view("s001-bootstrap", boot, stackView("s001", "none")),
        // The hosted backend's figure shows plain; the stopped frontend's is unknown.
        withContext(refundView, { backend: 45, frontend: null }),
    ];
}

/** The doc every fixture design session names once it is drafted. */
export const DESIGN_DOC = "docs/designs/csv-export.md";

/**
 * The plan section of the fixture doc (session-workspace.md, T2): three phases and seven
 * entries, in the layout Spinner's docs use, so the seed and the Implement view have phases.
 */
export const PLAN_SECTION = [
    "## Detailed Implementation Plan",
    "",
    "#### Build session 1: the route",
    "",
    "##### 1.1 `api/src/exports.ts` (Create)",
    "",
    "*   **Proposed Changes**: The streaming route.",
    "",
    "##### 1.2 `api/src/exports.test.ts` (Create)",
    "",
    "##### 1.3 `api/src/filters.ts` (Modify)",
    "",
    "#### Build session 2: the button",
    "",
    "##### 2.1 `web/src/ExportButton.tsx` (Create)",
    "",
    "##### 2.2 `web/src/list.ts` (Modify)",
    "",
    "#### Build session 3: the docs",
    "",
    "##### 3.1 `docs/exports.md` (Create)",
    "",
    "##### 3.2 `CHANGELOG.md` (Modify)",
    "",
].join("\n");

/** The seeded session of the Implement flows (entry 2.30). */
export const SEEDED_DIR = "s213-csv-seeded";

/**
 * The MISSION.md of the seeded session: two free items, then one item per entry with the
 * `[n.n]` token, one stale (`[2.2]` carries another title) and one orphan (`[4.1]` is not in
 * the doc); `engine` is on item 5 through its Roster cell, `ui` is blocked.
 */
export const SEEDED_MISSION = [
    "# s213 \u00b7 CSV export \u00b7 seeded", "",
    "## Goal", "The design doc holds the goal: `docs/designs/csv-export.md`.", "",
    "## Done when", "- [ ] The design is approved and every Plan item is ticked.", "",
    "## Plan",
    "- [x] 1. pin the row cap (lead, 10:05)",
    "- [ ] 2. write the e2e row (lead)",
    "- [x] 3. [1.1] `api/src/exports.ts` (engine, 10:20)",
    "- [x] 4. [1.2] `api/src/exports.test.ts` (engine, 10:30)",
    "- [ ] 5. [1.3] `api/src/filters.ts` (engine)",
    "- [ ] 6. [2.1] `web/src/ExportButton.tsx` (ui)",
    "- [ ] 7. [2.2] `web/src/list-old.ts` (ui)",
    "- [ ] 8. [3.1] `docs/exports.md`",
    "- [ ] 9. [3.2] `CHANGELOG.md`",
    "- [ ] 10. [4.1] `web/src/gone.ts`",
    "",
    "## Roster", "| Agent | Owns | Doing | Blocked? | Updated |",
    "|-------|------|-------|----------|---------|",
    "| lead | docs/designs/** | coordinating | no | 10:00 |",
    "| engine | api/** | #5 filters.ts | no | 10:31 |",
    "| ui | web/** | #6 ExportButton.tsx | yes: waiting for 1.3 | 10:32 |", "",
    "## Contracts & decisions", "- 10:00 lead: the row cap is 50,000", "",
    "## Open questions", "- ui: does the button show on an empty list?", "",
    "## Log", "- 10:00 operator: session created",
    "- 10:01 spinner: plan seeded from docs/designs/csv-export.md (9f2c4be1d0a7): " +
        "7 added, 2 kept, 0 stale, 0 orphaned",
    "- 10:20 engine: 1.1 done", "",
].join("\n");

/** The MISSION.md of each design session that has its own; the others take the default. */
export const DESIGN_MISSIONS: Record<string, string> = { [SEEDED_DIR]: SEEDED_MISSION };

/** A file of `<session>/design/`, as `DesignView.files` lists it. */
function designFile(name: string, mtime: string) {
    return { name, bytes: 4096, mtime };
}

/**
 * `SessionView.design` of a design-track session at a stage (entry 2.37), with the files and
 * the report flags that the daemon's rule table would read for it (Technical Plan T7).
 */
export function designView(
    stage: DesignStage | null,
    partial: Partial<DesignView> = {},
): DesignView {
    const at = "2026-10-20T10:00:00Z";
    const order: (DesignStage | null)[] = [
        "intake", "brainstorm", "drafting", "drafted", "design-review", "resolving",
        "design-ready", "approved",
    ];
    const reached = (from: DesignStage) =>
        stage !== null && order.indexOf(stage) >= order.indexOf(from);
    const reviewed = reached("design-review");
    const files = [
        ...(reached("brainstorm") ? [designFile("concepts_brief.md", at)] : []),
        ...(reached("drafting") ? [designFile("design_draft.md", at)] : []),
        ...(reviewed ? [
            designFile("zoom_out_report.md", at), designFile("comprehension_report.md", at),
            designFile("critic_report.md", at),
        ] : []),
        ...(reached("resolving") ? [designFile("consolidated_review_report.md", at),
            designFile("goldfish_review_report.md", at)] : []),
    ];
    const approval = {
        path: DESIGN_DOC, repo: "web", sha256: "9f2c4be1d0a7", at: "2026-10-20T11:40:00Z",
        blockers: 0, round: 1,
    };
    return {
        track: "design", stage, files,
        reviews: { "5": reviewed, "6": reviewed, "7": reviewed, "8": false, "9": false },
        consolidated: reached("resolving"),
        resolve: stage === "resolving" ? "open" : reached("design-ready") ? "resolved" : "none",
        review_run: reviewed ? { id: "r1", preset: "uninterrupted", started: at } : null,
        doc: reached("drafted") ? DESIGN_DOC : null, doc_missing: false,
        approved: stage === "approved" ? approval : null,
        approvals: stage === "approved" ? [approval] : [],
        changed_after_approval: false, gate: null, goldfish: [], goldfish_live: 0,
        cost_by_stage: reviewed ? { brainstorm: 0.42, draft: 0.18, review: 1.2 } : {},
        ...partial,
    };
}

/** The `needs_human` the daemon derives per design stage (Technical Plan T7, lines 2 to 7). */
const DESIGN_NEEDS: Partial<Record<DesignStage, string>> = {
    drafted: "review the design",
    resolving: "resolve the review findings",
    "design-ready": "approve the design",
};

/** The gate the fixture's gate session waits on: a question with a list, and 3 options. */
export const FIXTURE_GATE = {
    question: "Which export shape should the brief carry forward?\n\n" +
        "- **Streamed CSV**: rows go out as the query reads them.\n" +
        "- **Background job**: a file is built, then linked by mail.",
    options: [
        "Streamed CSV from the list page",
        "Background job with a mailed link",
        "Both, picked by row count",
    ],
    asked: "2026-10-20T10:12:00Z",
};

/** `needs_human` for an open gate (Technical Plan T7, line 1): the first 80 characters. */
export function gateNeeds(question: string): string {
    return `answer the lead: ${question.slice(0, 80)}`;
}

/**
 * The blockers the newest review report lists, per session (entry 6.18): the design-ready
 * session's report lists 1, so its approval goes through the blocker confirmation.
 */
export const LISTED_BLOCKERS: Record<string, number> = { "s207-csv-design-ready": 1 };

/** The session whose doc changed after its approval (entry 6.18, CUJ 7). */
export const CHANGED_DIR = "s212-csv-changed";

/** `needs_human` after an edit invalidated the approval (Technical Plan T7, line 5). */
export const REAPPROVE_NEEDS = "re-approve the design (changed since approval)";

/** `DesignView.repo` and `designs_dir` as the daemon sets them for a `web` worktree. */
function designsOf(dir: string): Pick<DesignView, "repo" | "designs_dir"> {
    return { repo: "web", designs_dir: `/home/fixture/.spinner/sessions/${dir}/web/docs/designs` };
}

/** The two earlier rounds of the round-3 session: one merged PR, then one closed and one open. */
export const ROUNDS_OF_R3: RoundView[] = [
    {
        round: 1, branch: "feat/csv-export", source: "record",
        started: "2026-10-12T09:30:00Z", ended: "2026-10-14T17:10:00Z",
        prs: [{
            repo: "web", number: 41, url: "https://github.com/example/web/pull/41",
            state: "merged", merged_at: "2026-10-14T16:02:00Z",
        }],
    },
    {
        round: 2, branch: "feat/csv-export-r2", source: "record",
        started: "2026-10-14T17:10:00Z", ended: "2026-10-18T12:00:00Z",
        prs: [
            {
                repo: "web", number: 57, url: "https://github.com/example/web/pull/57",
                state: "merged", merged_at: "2026-10-18T11:20:00Z",
            },
            {
                repo: "api", number: 9, url: "https://github.com/example/api/pull/9",
                state: "closed", merged_at: null,
            },
        ],
    },
];

/**
 * The EGM sessions of the fixture (entries 2.37, 2.47 and 3.24): one design-track session per
 * design stage, one direct-track session, one session at round 3 with two round records, and
 * one session whose lead waits on an open gate. The design sessions have a `web` worktree, so
 * the `EGM \u25be` dialogs prefill absolute paths.
 * They were created before the Refund flow, so the cards that the older flows read first stay
 * first.
 */
export function initialDesignSessions(): SessionView[] {
    const stages: DesignStage[] = [
        "intake", "brainstorm", "drafting", "drafted", "design-review", "resolving",
        "design-ready", "approved",
    ];
    const lead = {
        lead: {
            harness: "tty" as const, model: "anthropic/claude-opus-5-5", process: "idle" as const,
        },
    };
    const designs = stages.map((stage, index) => {
        const id = `s${201 + index}`;
        const slug = `csv-${stage}`;
        const base = session({
            id, slug, title: `CSV export · ${stage}`,
            created: `2026-10-20T10:0${index}:00Z`,
            stage: stage === "approved" ? "building" : "planned",
            needs_human: DESIGN_NEEDS[stage] ?? null,
            agents: lead,
            repos: { web: { path: "~/src/web", worktree: "web", changed: false } },
        });
        const dir = `${id}-${slug}`;
        const plain = view(dir, base, stackView(id, "none"), [], ["lead"]);
        return { ...plain, design: designView(stage, designsOf(dir)), round: 1, rounds: [] };
    });
    const direct = session({
        id: "s209", slug: "csv-direct", title: "CSV export · direct track",
        created: "2026-10-19T10:00:00Z", stage: "planned",
    });
    const directView = {
        ...view("s209-csv-direct", direct, stackView("s209", "none")),
        design: designView(null, { track: "direct" }), round: 1, rounds: [],
    };
    const third = session({
        id: "s210", slug: "csv-round-3", title: "CSV export · round 3",
        created: "2026-10-18T12:00:00Z", stage: "planned", round: 3,
        branch: "feat/csv-export-r3",
    });
    const thirdView = {
        ...view("s210-csv-round-3", third, stackView("s210", "none")),
        round: 3, rounds: ROUNDS_OF_R3,
    };
    const gated = session({
        id: "s211", slug: "csv-gate", title: "CSV export · gate",
        created: "2026-10-20T10:09:00Z", stage: "planned",
        needs_human: gateNeeds(FIXTURE_GATE.question), agents: lead,
        repos: { web: { path: "~/src/web", worktree: "web", changed: false } },
    });
    const gatedView = {
        ...view("s211-csv-gate", gated, stackView("s211", "none"), [], ["lead"]),
        design: designView("brainstorm", { gate: FIXTURE_GATE, ...designsOf("s211-csv-gate") }),
        round: 1, rounds: [],
    };
    return [
        ...designs, directView, thirdView, gatedView, changedView(lead), seededView(),
    ].map(withGoldfish);
}

/**
 * The approved session whose Plan is seeded (entry 2.30): three agents, `engine` in a turn,
 * `ui` idle, so the Implement rail shows working, idle and blocked.
 */
function seededView(): SessionView {
    const agents: Session["agents"] = {
        lead: { harness: "tty", model: "anthropic/claude-opus-5-5", process: "idle" },
        engine: { harness: "tty", model: "anthropic/claude-opus-5-5", process: "running" },
        ui: { harness: "tty", model: "anthropic/claude-opus-5-5", process: "idle" },
    };
    const base = session({
        id: "s213", slug: "csv-seeded", title: "CSV export \u00b7 seeded",
        created: "2026-10-20T10:11:00Z", stage: "building", agents,
        repos: { web: { path: "~/src/web", worktree: "web", changed: true } },
    });
    const hosted = view(SEEDED_DIR, base, stackView("s213", "none"), [], ["lead", "engine", "ui"]);
    // The three bands past the quiet one: lead hides its figure, engine amber, ui red.
    const plain = withContext(hosted, { lead: 30, engine: 52, ui: 81 });
    const design = designView("approved", designsOf(SEEDED_DIR));
    return { ...plain, design, round: 1, rounds: [] };
}

/**
 * The session whose doc changed after its approval (entry 6.18): stage `design-ready`, the
 * approval record kept, `changed_after_approval` set, and the re-approve needs line.
 */
function changedView(agents: Session["agents"]): SessionView {
    const base = session({
        id: "s212", slug: "csv-changed", title: "CSV export · changed",
        created: "2026-10-20T10:10:00Z", stage: "planned", needs_human: REAPPROVE_NEEDS, agents,
        repos: { web: { path: "~/src/web", worktree: "web", changed: false } },
    });
    const approved = designView("approved", designsOf(CHANGED_DIR)).approved;
    const design = designView("design-ready", {
        ...designsOf(CHANGED_DIR), approved, approvals: approved === null ? [] : [approved],
        changed_after_approval: true,
    });
    const plain = view(CHANGED_DIR, base, stackView("s212", "none"), [], ["lead"]);
    return { ...plain, design, round: 1, rounds: [] };
}
