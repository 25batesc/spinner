// The lead's tools on the agents of its own session (MISSION.md s014): `agent_add` and
// `agent_steer`. Each is one daemon call with the body the UI sends, so the daemon's own
// validation applies. `wait_job` is for a tool that starts a daemon job and must have its
// result before it answers.
import type {
    AddAgentRequest,
    AgentCommandResponse,
    AgentResponse,
    Job,
    JobResponse,
} from "@spinner/protocol";
import type { DaemonClient } from "./tools.js";

/** One look at a job every `JOB_POLL_MS`, at most `JOB_POLLS_MAX` times (2 minutes). */
export const JOB_POLL_MS = 500;
export const JOB_POLLS_MAX = 240;

/** Runs `agent_add` or `agent_steer` on the session `dir`. */
export async function run_agent_tool(
    name: string,
    args: Record<string, unknown>,
    dir: string,
    client: DaemonClient,
): Promise<string> {
    const text = (key: string): string => String(args[key] ?? "");
    /** An identifier: an agent name, a repo key, a model. */
    const id = (key: string): string => text(key).trim();
    const optional = (key: string): string | undefined => {
        const value = id(key);
        return value.length === 0 ? undefined : value;
    };
    const session = `/sessions/${encodeURIComponent(dir)}`;
    if (name === "agent_add") {
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
        const response = await client.send<AgentResponse>("POST", `${session}/agents`, body);
        return (
            `Agent ${response.name} started in ${dir}` +
            (repo === undefined ? "." : ` on repo ${repo}.`) +
            ` ${first_turn_line(response.first_turn, message !== undefined)}`
        );
    }
    if (name === "agent_steer") {
        const agent = encodeURIComponent(id("agent"));
        const response = await client.send<AgentCommandResponse>(
            "POST",
            `${session}/agents/${agent}/steer`,
            { text: text("text") },
        );
        const disposition = response.disposition ?? "accepted";
        return `Steer to ${id("agent")} in ${dir}: ${disposition}.`;
    }
    throw new Error(`${name} is not an agent tool`);
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
