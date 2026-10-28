// Every action the daemon runs (`new`, `adopt`, `up`, `down`, `close`, `verify`) is a job:
// one id, one action, one session, a bounded log, and exactly one `job.finished` event. The
// runner serializes jobs per session, bounds how many run at once, and keeps finished jobs in
// memory for `GET /jobs/:id`. Nothing here touches disk; the work function does.
import assert from "node:assert/strict";
import type { Job, JobAction } from "@spinner/protocol";
import { JOBS_RECENT_MAX } from "@spinner/protocol";
import type { EventBus } from "../event-bus.js";

/** Lines a job keeps. A stack `up` with image builds prints a few hundred. */
export const JOB_LOG_LINES_MAX = 2_000;

/** Jobs that may run at the same time, across sessions. Docker and `gh` do not like more. */
export const JOBS_RUNNING_MAX = 8;

/** Finished jobs kept for `GET /jobs/:id`. Older ones are forgotten, oldest first. */
const JOBS_KEPT_MAX = 500;

export type JobLog = (line: string) => void;

/** The work of a job. `set_session` names the session once an `adopt` job created it. */
export type JobWork = (log: JobLog, set_session: (dir: string) => void) => Promise<void>;

export interface JobRunnerOptions {
    now?: () => Date;
}

export class JobRunner {
    private readonly jobs = new Map<string, Job>();
    private readonly running_by_session = new Map<string, string>();
    private running_count = 0;
    private next_id = 1;
    private readonly now: () => Date;

    constructor(
        private readonly bus: EventBus,
        options: JobRunnerOptions = {},
    ) {
        this.now = options.now ?? (() => new Date());
    }

    get(id: string): Job | null {
        return this.jobs.get(id) ?? null;
    }

    /** The running jobs plus the last `JOBS_RECENT_MAX` finished ones, oldest first. */
    recent(): Job[] {
        const all = [...this.jobs.values()];
        const running = all.filter((job) => job.state === "running");
        const finished = all.filter((job) => job.state !== "running").slice(-JOBS_RECENT_MAX);
        return [...finished, ...running].sort((a, b) => job_number(a.id) - job_number(b.id));
    }

    /** The id of the job running on `session`, or null. */
    running_on(session: string): string | null {
        return this.running_by_session.get(session) ?? null;
    }

    /**
     * Starts a job and returns it at once, state `running`. Throws when the session already
     * has a running job or when too many jobs run: the caller turns that into a 409.
     */
    start(action: JobAction, session: string | null, work: JobWork): Job {
        if (session !== null && this.running_by_session.has(session)) {
            const other = this.running_by_session.get(session);
            throw new Error(`session ${session} already has job ${other ?? "?"} running`);
        }
        if (this.running_count >= JOBS_RUNNING_MAX) {
            throw new Error(`${JOBS_RUNNING_MAX} jobs are running; try again later`);
        }
        const job: Job = {
            id: `j-${this.next_id}`,
            action,
            session,
            state: "running",
            started: this.now().toISOString(),
            finished: null,
            log: [],
            error: null,
        };
        this.next_id += 1;
        this.jobs.set(job.id, job);
        this.forget_old();
        this.running_count += 1;
        if (session !== null) {
            this.running_by_session.set(session, job.id);
        }
        this.bus.publish({ type: "job.started", ts: job.started, session, job: job.id, data: job });
        void this.run(job, work);
        return job;
    }

    private async run(job: Job, work: JobWork): Promise<void> {
        const log: JobLog = (line) => this.append(job, line);
        const set_session = (dir: string): void => {
            assert.ok(job.session === null, `job ${job.id} already belongs to ${job.session}`);
            assert.ok(!this.running_by_session.has(dir), `session ${dir} already has a job`);
            job.session = dir;
            this.running_by_session.set(dir, job.id);
        };
        try {
            await work(log, set_session);
            job.state = "ok";
        } catch (error) {
            job.state = "failed";
            job.error = error instanceof Error ? error.message : String(error);
        }
        job.finished = this.now().toISOString();
        this.running_count -= 1;
        if (job.session !== null && this.running_by_session.get(job.session) === job.id) {
            this.running_by_session.delete(job.session);
        }
        const ok = job.state === "ok";
        this.bus.publish({
            type: "job.finished",
            ts: job.finished,
            session: job.session,
            job: job.id,
            ok,
            ...(job.error === null ? {} : { error: job.error }),
            data: job,
        });
    }

    private append(job: Job, line: string): void {
        // A multi-line message (a docker log tail) becomes one event per line, so the UI's
        // drawer and the CLI print the same thing.
        for (const part of line.split("\n")) {
            if (job.log.length < JOB_LOG_LINES_MAX) {
                job.log.push(part);
            } else if (job.log.length === JOB_LOG_LINES_MAX) {
                job.log.push(`... log truncated at ${JOB_LOG_LINES_MAX} lines`);
            }
            this.bus.publish({
                type: "job.log",
                ts: this.now().toISOString(),
                session: job.session,
                job: job.id,
                line: part,
            });
        }
    }

    private forget_old(): void {
        if (this.jobs.size <= JOBS_KEPT_MAX) {
            return;
        }
        for (const [id, job] of this.jobs) {
            if (job.state !== "running") {
                this.jobs.delete(id);
                return;
            }
        }
    }
}

function job_number(id: string): number {
    return Number.parseInt(id.slice(2), 10);
}
