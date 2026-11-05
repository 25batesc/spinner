// The operator role's tools (MISSION.md s013, Contracts "operator contract"): each is one or
// two daemon calls with the bodies the UI sends, so the daemon's own validation applies. A
// tool that starts a job (`session_new`, `session_adopt`, `session_attach`) waits for the job
// to finish, bounded, so the model gets the worktrees before it adds an agent. Every answer
// names the session directory, because every later tool takes it.
import type {
    AddAgentRequest,
    AgentBriefResponse,
    AgentCommandResponse,
    AgentResponse,
    InboxMessageResponse,
    Job,
    JobResponse,
    MissionSectionRequest,
    MissionSectionResponse,
    NewSessionRequest,
    OperatorMissionSection,
    ProjectsResponse,
    SessionView,
    SessionsResponse,
} from "@spinner/protocol";
import { OPERATOR_MISSION_SECTIONS } from "@spinner/protocol";
import type { DaemonClient } from "./tools.js";

/** The author every operator-role mission write carries. */
export const OPERATOR_AUTHOR = "operator";

/** One look at a job every `JOB_POLL_MS`, at most `JOB_POLLS_MAX` times (2 minutes). */
export const JOB_POLL_MS = 500;
export const JOB_POLLS_MAX = 240;

/** Upper bound on Log lines `session_show` prints from the mission. */
const MISSION_CHARS_MAX = 60_000;

export interface OperatorToolDeps {
    client: DaemonClient;
    /** For tests: a shorter wait between job polls. */
    poll_ms?: number;
}

/** Runs one operator tool. `name` is one of the manifest's operator-only tools. */
export async function run_operator_tool(
    name: string,
    args: Record<string, unknown>,
    deps: OperatorToolDeps,
): Promise<string> {
    const text = (key: string): string => String(args[key] ?? "");
    /** An identifier: a name, a directory, a section. */
    const id = (key: string): string => text(key).trim();
    const optional = (key: string): string | undefined => {
        const value = id(key);
        return value.length === 0 ? undefined : value;
    };
    const client = deps.client;
    switch (name) {
        case "session_new": {
            const body: NewSessionRequest = { title: id("title") };
            const project = optional("project");
            const slug = optional("slug");
            if (project !== undefined) {
                body.project = project;
            }
            if (slug !== undefined) {
                body.slug = slug;
            }
            let started: JobResponse;
            try {
                started = await client.send<JobResponse>("POST", "/sessions", body);
            } catch (error) {
                throw await with_project_names(client, error);
            }
            const job = await wait_job(client, started.job, deps.poll_ms);
            return describe_job(job, "created");
        }
        case "session_adopt": {
            const urls = id("urls")
                .split(/[\s,]+/)
                .filter((url) => url.length > 0);
            const body: Record<string, unknown> = { urls };
            const project = optional("project");
            const title = optional("title");
            if (project !== undefined) {
                body["project"] = project;
            }
            if (title !== undefined) {
                body["title"] = title;
            }
            const started = await client.send<JobResponse>("POST", "/sessions/adopt", body);
            const job = await wait_job(client, started.job, deps.poll_ms);
            return describe_job(job, "adopted");
        }
        case "session_attach": {
            const session = session_path(id("session"));
            const started = await client.send<JobResponse>("POST", `${session}/attach`, {
                project: id("project"),
            });
            const job = await wait_job(client, started.job, deps.poll_ms);
            return describe_job(job, "attached");
        }
        case "session_list": {
            const response = await client.get<SessionsResponse>("/sessions");
            return render_sessions(response.sessions);
        }
        case "session_show": {
            const session = session_path(id("session"));
            const response = await client.get<{ session: SessionView }>(session);
            const mission = await client.get_text(`${session}/mission`);
            return [render_session(response.session), "", mission.slice(0, MISSION_CHARS_MAX)]
                .join("\n")
                .trim();
        }
        case "mission_write": {
            const section = id("section");
            if (!is_operator_section(section)) {
                throw new Error(
                    `section must be one of ${OPERATOR_MISSION_SECTIONS.join(", ")}, ` +
                        `not "${section}"`,
                );
            }
            const request: MissionSectionRequest = {
                section,
                mode: section === "goal" || section === "done_when" ? "replace" : "append",
                text: text("text"),
                author: OPERATOR_AUTHOR,
            };
            const response = await client.send<MissionSectionResponse>(
                "PUT",
                `${session_path(id("session"))}/mission/section`,
                request,
            );
            return `MISSION.md of ${id("session")} updated: ${response.sections.join(", ")}.`;
        }
        case "brief_write": {
            const agent = encodeURIComponent(id("agent"));
            const response = await client.send<AgentBriefResponse>(
                "PUT",
                `${session_path(id("session"))}/agents/${agent}/brief`,
                { brief: text("text") },
            );
            return `Brief written: ${response.path}.`;
        }
        case "agent_add": {
            const body: AddAgentRequest = { name: id("name") };
            const brief = text("brief").trim().length === 0 ? undefined : text("brief");
            const repo = optional("repo");
            const model = optional("model");
            if (brief !== undefined) {
                body.brief = brief;
            }
            if (repo !== undefined) {
                body.repo = repo;
            }
            if (model !== undefined) {
                body.model = model;
            }
            const message = text("message").trim().length === 0 ? undefined : text("message");
            if (message !== undefined) {
                body.message = message;
            }
            const response = await client.send<AgentResponse>(
                "POST",
                `${session_path(id("session"))}/agents`,
                body,
            );
            return (
                `Agent ${response.name} started in ${id("session")}` +
                (repo === undefined ? "." : ` on repo ${repo}.`) +
                ` ${first_turn_line(response.first_turn, message !== undefined)}`
            );
        }
        case "agent_steer": {
            const agent = encodeURIComponent(id("agent"));
            const response = await client.send<AgentCommandResponse>(
                "POST",
                `${session_path(id("session"))}/agents/${agent}/steer`,
                { text: text("text") },
            );
            const disposition = response.disposition ?? "accepted";
            return `Steer to ${id("agent")} in ${id("session")}: ${disposition}.`;
        }
        case "inbox_send": {
            const response = await client.send<InboxMessageResponse>(
                "POST",
                `${session_path(id("session"))}/inbox`,
                {
                    from: OPERATOR_AUTHOR,
                    to: id("to"),
                    subject: text("subject"),
                    text: text("text"),
                },
            );
            return `Sent inbox/${response.file} to ${id("to")} in ${id("session")}.`;
        }
        default:
            throw new Error(`${name} is not an operator tool`);
    }
}

/** A "project not found" error, with the names `GET /projects` lists, so the next try lands. */
async function with_project_names(client: DaemonClient, error: unknown): Promise<Error> {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("not found")) {
        return error instanceof Error ? error : new Error(message);
    }
    try {
        const response = await client.get<ProjectsResponse>("/projects");
        const names = response.projects.map((project) => project.name);
        return new Error(`${message}. Projects: ${names.join(", ") || "(none)"}`);
    } catch {
        return new Error(message);
    }
}

/** `/sessions/<dir>`; refuses an empty name before the daemon answers 404 on `/sessions/`. */
export function session_path(dir: string): string {
    if (dir.length === 0) {
        throw new Error("`session` must name a session directory; run session_list");
    }
    return `/sessions/${encodeURIComponent(dir)}`;
}

function is_operator_section(section: string): section is OperatorMissionSection {
    return (OPERATOR_MISSION_SECTIONS as readonly string[]).includes(section);
}

/** Polls `GET /jobs/:id` until the job is not running; throws when it failed. */
export async function wait_job(
    client: DaemonClient,
    job: Job,
    poll_ms = JOB_POLL_MS,
): Promise<Job> {
    let current = job;
    for (let polls = 0; polls < JOB_POLLS_MAX && current.state === "running"; polls += 1) {
        await new Promise((resolve) => setTimeout(resolve, poll_ms));
        const response = await client.get<JobResponse>(`/jobs/${encodeURIComponent(job.id)}`);
        current = response.job;
    }
    if (current.state === "running") {
        throw new Error(
            `job ${current.action} ${current.id} is still running after ${
                (JOB_POLLS_MAX * poll_ms) / 1000
            } s; session ${current.session ?? "(none yet)"}`,
        );
    }
    if (current.state === "failed") {
        throw new Error(
            `job ${current.action} failed: ${current.error ?? "no message"}` +
                (current.session === null ? "" : ` (session ${current.session})`),
        );
    }
    return current;
}

/**
 * What `agent_add` says about the first turn, so the lead knows whether to steer: `none` is a
 * resume (pi continues the transcript), `queued` means pi refused the prompt and the text
 * goes with the next one.
 */
export function first_turn_line(first_turn: string, custom: boolean): string {
    const what = custom ? "Your message" : "The go signal (read the mission and brief, start)";
    if (first_turn === "none") {
        return "Resumed on its transcript; no first turn sent.";
    }
    if (first_turn === "queued") {
        return `${what} waits for its next prompt: pi did not take it yet.`;
    }
    return `${what} is its first turn (${first_turn}).`;
}

function describe_job(job: Job, verb: string): string {
    const tail = job.log.slice(-5).map((line) => `  ${line}`);
    const head = `Session ${job.session ?? "?"} ${verb}. Use this directory in the other tools.`;
    return [head, ...tail].join("\n");
}

export function render_sessions(sessions: readonly SessionView[]): string {
    if (sessions.length === 0) {
        return "No live session. session_new creates one.";
    }
    return sessions.map((view) => render_session(view)).join("\n");
}

/** One line: dir, title, stage, needs-human, repos, stack state, agents and what they do. */
export function render_session(view: SessionView): string {
    const session = view.summary.session;
    const repos = Object.keys(session.repos);
    const agents = Object.entries(session.agents ?? {}).map(([name, spec]) => {
        const running = view.agents_running.includes(name);
        return `${name} (${running ? spec.process : "stopped"})`;
    });
    const parts = [
        `${view.summary.dir} · ${session.title} · stage ${session.stage}`,
        session.needs_human === null ? "" : `needs a human: ${session.needs_human}`,
        repos.length === 0 ? "no repo" : `repos ${repos.join(", ")}`,
        `stack ${view.stack.state}`,
        agents.length === 0 ? "no agents" : `agents ${agents.join(", ")}`,
    ].filter((part) => part.length > 0);
    return `- ${parts.join(" · ")}`;
}
