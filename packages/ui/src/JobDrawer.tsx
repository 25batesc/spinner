import type { Job } from "@spinner/protocol";

export interface JobDrawerProps {
    job: Job | undefined;
    error: string | null;
    onDismiss: () => void;
}

/** Shows the `job.log` lines of the job the operator started, until they dismiss it. */
export function JobDrawer({ job, error, onDismiss }: JobDrawerProps) {
    if (job === undefined && error === null) {
        return null;
    }
    return (
        <div className="drawer" aria-label="Job log">
            <div className="drawer-head">
                <strong>
                    {job === undefined ? "action failed" : `${job.action} · ${job.state}`}
                </strong>
                <button onClick={onDismiss} disabled={job?.state === "running"}>
                    close
                </button>
            </div>
            {error !== null && <p className="needs-human">{error}</p>}
            {job?.error != null && <p className="needs-human">{job.error}</p>}
            <pre className="drawer-log">{job?.log.join("\n")}</pre>
        </div>
    );
}
