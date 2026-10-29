// What a stack job leaves behind for an agent to read. The operator's first real session
// showed the gap: `up` failed, the reason sat in the UI's job drawer, and the agent's
// `stack show` said only "failed". So, when an `up`, `down` or `reset` job ends, the daemon
// writes `stack.last_job` (action, state, error, finished, the last `STACK_JOB_TAIL_LINES`
// log lines) into `session.yaml`, which the view carries and the extension's `stack show`
// prints. When the job failed and the session has a running tty agent, the daemon also pushes
// one notice through the extension channel, so the agent reacts without being asked. One
// notice per failed job, however many agents receive it.
import assert from "node:assert/strict";
import type { Job, SpinnerEvent, StackLastJob } from "@spinner/protocol";
import { STACK_JOB_TAIL_LINES } from "@spinner/protocol";
import type { AgentManager } from "../agents/manager.js";
import type { EventBus } from "../event-bus.js";
import type { SpinnerHome } from "../home.js";
import { read_session, write_session } from "../store/session-store.js";

const STACK_ACTIONS = new Set<Job["action"]>(["up", "down", "reset"]);

export interface StackJobDeps {
    home: SpinnerHome;
    bus: EventBus;
    agents: AgentManager;
    log?: (line: string) => void;
}

/** Subscribes to `job.finished`; returns the unsubscribe. */
export function watch_stack_jobs(deps: StackJobDeps): () => void {
    const log = deps.log ?? (() => undefined);
    return deps.bus.subscribe((event: SpinnerEvent) => {
        if (event.type !== "job.finished") {
            return;
        }
        const job = event.data;
        if (!is_stack_action(job.action) || job.session === null) {
            return;
        }
        const record = last_job_of(job);
        const written = write_last_job(deps.home, job.session, record);
        if (!written) {
            return;
        }
        if (record.state === "failed") {
            void deps.agents.notify_all(job.session, render_notice(record)).then((reached) => {
                if (reached.length > 0) {
                    const names = reached.join(", ");
                    log(`stack ${record.action} failed in ${job.session}; told ${names}`);
                }
            });
        }
    });
}

function is_stack_action(action: Job["action"]): action is StackLastJob["action"] {
    return STACK_ACTIONS.has(action);
}

/** Pure: the record from a finished job. */
export function last_job_of(job: Job): StackLastJob {
    assert.ok(job.finished !== null, "a finished job has a finish time");
    assert.ok(job.state !== "running", "a finished job is not running");
    assert.ok(is_stack_action(job.action), `${job.action} is not a stack action`);
    return {
        action: job.action,
        state: job.state === "ok" ? "ok" : "failed",
        error: job.error,
        finished: job.finished,
        tail: job.log.slice(-STACK_JOB_TAIL_LINES),
    };
}

/** Merges the record into `session.yaml`'s stack block. False when the session is gone. */
function write_last_job(home: SpinnerHome, dir: string, record: StackLastJob): boolean {
    const read = read_session(home, dir);
    if (!read.ok) {
        return false;
    }
    const session = read.summary.session;
    session.stack = { ...(session.stack ?? { state: "none" }), last_job: record };
    write_session(read.summary);
    return true;
}

/**
 * Pure: the notice an agent receives. The first error line comes first, because a compose
 * failure's message carries a log tail of its own; the job tail follows in a fence.
 */
export function render_notice(record: StackLastJob): string {
    assert.ok(record.state === "failed", "only a failed job makes a notice");
    const first_line = (record.error ?? "").split("\n").find((line) => line.trim().length > 0);
    const lines = [
        `Spinner: the stack job \`${record.action}\` failed at ${record.finished}.`,
        `Error: ${first_line ?? "(no message)"}`,
        "",
        `Last ${record.tail.length} lines of the job log:`,
        "```",
        ...record.tail,
        "```",
        "The `stack` tool shows the state (`show`) and a service's log (`logs`, with `service`).",
    ];
    return lines.join("\n");
}
