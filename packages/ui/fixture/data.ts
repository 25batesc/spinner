// Canned data for the fixture server. It uses the real protocol types, so a change to
// `@spinner/protocol` that breaks the fixture also breaks `pnpm --filter ui typecheck`.
import type {
    BoardView,
    PrFacts,
    ProjectView,
    ServiceStatus,
    ServiceView,
    Session,
    SessionView,
    StackView,
} from "@spinner/protocol";

export const FIXTURE_PORT = Number(process.env["SPINNER_PORT"] ?? 7777);

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

export function serviceViews(id: string, status: ServiceStatus): ServiceView[] {
    const url = (host: string) => `http://${host}.${id}.localhost:${FIXTURE_PORT}`;
    // `web` keeps its login in cookies (`preview: top-level`), the case the desktop app exists for.
    return [
        { name: "web", where: "host", status, host: `web.${id}.localhost`, url: url("web"),
          process: null, preview: "top-level" },
        { name: "api", where: "container", status, host: `api.${id}.localhost`, url: url("api"),
          process: null, preview: "frame" },
        { name: "db", where: "container", status, host: null, url: null, process: null,
          preview: "frame" },
    ];
}

const STACK_STATUS = { up: "healthy", starting: "starting", down: "stopped" } as const;

export function stackView(id: string, state: "none" | keyof typeof STACK_STATUS): StackView {
    if (state === "none") {
        return { state, project: null, database: null, services: [], observed: null };
    }
    return {
        state,
        project: `spinner-${id}`,
        database: `spinner_${id}`,
        services: serviceViews(id, STACK_STATUS[state]),
        observed: new Date().toISOString(),
    };
}

export function view(
    dir: string,
    base: Session,
    stack: StackView,
    prs: PrFacts[] = [],
    agentsRunning: string[] = [],
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
    };
}

export function initialSessions(): SessionView[] {
    const refund = session({
        id: "s17",
        slug: "refund-flow",
        title: "Refund flow",
        stage: "peer-review",
        needs_human: "Approve the refund copy in PR #412",
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
