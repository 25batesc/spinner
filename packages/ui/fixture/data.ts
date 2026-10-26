// Canned data for the fixture server. It uses the real protocol types, so a change to
// `@spinner/protocol` that breaks the fixture also breaks `pnpm --filter ui typecheck`.
import type { Session, SessionSummary, SpinnerEvent } from "@spinner/protocol";

export const FIXTURE_PORT = 7777;

function session(partial: Partial<Session> & Pick<Session, "id" | "slug" | "title">): Session {
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
        ...partial,
    };
}

export const SESSIONS: SessionSummary[] = [
    {
        dir: "s17-refund-flow",
        path: "/home/fixture/.spinner/sessions/s17-refund-flow",
        session: session({
            id: "s17",
            slug: "refund-flow",
            title: "Refund flow",
            stage: "peer-review",
            needs_human: "Approve the refund copy in PR #412",
            stack: {
                state: "up",
                project: "spinner-s17",
                hosts: {
                    admin: `admin.s17.localhost:${FIXTURE_PORT}`,
                    api: `api.s17.localhost:${FIXTURE_PORT}`,
                },
            },
            agents: {
                backend: { harness: "pi", model: "anthropic/claude-fable-5-1", process: "running" },
                frontend: { harness: "pi", model: "anthropic/claude-sonnet-5-5", process: "idle" },
            },
        }),
    },
    {
        dir: "s001-bootstrap",
        path: "/home/fixture/.spinner/sessions/s001-bootstrap",
        session: session({
            id: "s001",
            slug: "bootstrap",
            title: "Bootstrap: Spinner builds Spinner",
            agents: {
                engine: { harness: "pi", model: "anthropic/claude-fable-5-1", process: "running" },
                ui: { harness: "pi", model: "anthropic/claude-sonnet-5-5", process: "running" },
            },
        }),
    },
];

/** The events replayed on each connection, in order. Timestamps are set when it is built. */
export function buildScript(now: Date = new Date()): SpinnerEvent[] {
    const ts = now.toISOString();
    const created = session({
        id: "s18",
        slug: "csv-export",
        title: "CSV export",
        stage: "planned",
    });
    return [
        { type: "session.created", ts, session: "s18-csv-export", data: created },
        { type: "agent.spawned", ts, session: "s18-csv-export", agent: "backend", pid: 4242 },
        {
            type: "agent.event",
            ts,
            session: "s17-refund-flow",
            agent: "backend",
            event: { type: "message_update", text: "Reading the refund service." },
        },
        {
            type: "pipeline.transition",
            ts,
            session: "s17-refund-flow",
            from: "peer-review",
            to: "addressing",
            why: "A human left 2 threads",
        },
        { type: "stack.state", ts, session: "s17-refund-flow", state: "up", services: {} },
        { type: "agent.settled", ts, session: "s17-refund-flow", agent: "backend" },
        { type: "session.closed", ts, session: "s18-csv-export" },
    ];
}
