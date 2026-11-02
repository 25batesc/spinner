// The services view: one row per service with its state and its last usage sample (cpu,
// memory, i/o, process), under a line with the machine totals and this session's share. The
// cells read the latest sample (the `usage` event) on every render, so it updates them in
// place without a `session.updated`. Under the services, a `diff` heading lists the session's
// diff viewers (`SessionView.diff.repos`) with stop and restart.
import { useState } from "react";

import type { DiffRepoView, ServiceUsage, SessionView } from "@spinner/protocol";

import { diffRepos } from "./diff-view.ts";
import { postDiffStop } from "./remote.ts";
import type { RunAction } from "./SessionForms.tsx";
import {
    formatPercent,
    ioCell,
    memoryCell,
    processCell,
    serviceUsageOf,
    shareLine,
    stackUsageOf,
    type UsageSample,
} from "./usage.ts";

function UsageCells({ usage }: { usage: ServiceUsage | null | undefined }) {
    if (usage === null || usage === undefined) {
        return (
            <>
                <td className="muted">—</td>
                <td className="muted">—</td>
                <td className="muted">—</td>
                <td className="muted">—</td>
            </>
        );
    }
    return (
        <>
            <td>{formatPercent(usage.cpu_pct)}</td>
            <td>{memoryCell(usage)}</td>
            <td className="muted">{ioCell(usage)}</td>
            <td className="muted">{processCell(usage)}</td>
        </>
    );
}

/**
 * One row per repo's viewer. `stop` is synchronous and the `session.updated` that follows
 * moves the row; `restart` stops, then posts the `diff` job for that repo, so the drawer shows
 * the start. A failure of the stop shows under the table, where there is no job to carry it.
 */
function DiffRows({ view, run }: { view: SessionView; run: RunAction }) {
    const [error, setError] = useState<string | null>(null);
    const repos = diffRepos(view);
    if (repos.length === 0) {
        return null;
    }
    const dir = view.summary.dir;
    const stop = (name: string) =>
        postDiffStop(dir, name).then(
            () => setError(null),
            (failure: unknown) => setError(String(failure)),
        );
    const restart = (name: string) =>
        stop(name).then(() => run(`/sessions/${dir}/diff/start`, { repo: name }));
    const running = (repo: DiffRepoView) => repo.state === "running" || repo.state === "starting";
    return (
        <>
            <h3 className="diff-heading">diff</h3>
            <table className="services diff-table" aria-label="Diff viewers">
                <thead>
                    <tr>
                        <th>repo</th>
                        <th>state</th>
                        <th>process</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    {repos.map(([name, repo]) => (
                        <tr key={name} data-repo={name}>
                            <td>
                                {name}
                                {repo.url !== null && (
                                    <span className="muted service-url"> {repo.url}</span>
                                )}
                            </td>
                            <td title={repo.error ?? ""}>
                                <span className={`dot dot-${repo.state}`} /> {repo.state}
                            </td>
                            <td className="muted">{repo.pid === null ? "—" : `pid ${repo.pid}`}</td>
                            <td className="diff-actions">
                                <button
                                    type="button"
                                    disabled={!running(repo)}
                                    onClick={() => void stop(name)}
                                >
                                    stop
                                </button>
                                <button
                                    type="button"
                                    disabled={repo.state === "starting"}
                                    onClick={() => void restart(name)}
                                >
                                    restart
                                </button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {error !== null && <p className="needs-human">{error}</p>}
        </>
    );
}

export function ServiceTable({
    view,
    usage,
    run,
}: {
    view: SessionView;
    usage: UsageSample | null;
    run: RunAction;
}) {
    const { services } = view.stack;
    if (services.length === 0) {
        return (
            <>
                <p className="muted">No services: this session has no stack.</p>
                <DiffRows view={view} run={run} />
            </>
        );
    }
    const stack = stackUsageOf(view, usage);
    return (
        <>
            {usage !== null && stack !== null && (
                <p className="muted usage-share" aria-label="Usage">
                    {shareLine(usage.machine, stack)}
                </p>
            )}
            <table className="services" aria-label="Services">
                <thead>
                    <tr>
                        <th>service</th>
                        <th>state</th>
                        <th>cpu</th>
                        <th>memory</th>
                        <th>i/o</th>
                        <th>process</th>
                    </tr>
                </thead>
                <tbody>
                    {services.map((service) => (
                        <tr key={service.name}>
                            <td>
                                {service.name}
                                {service.url !== null && (
                                    <span className="muted service-url"> {service.url}</span>
                                )}
                            </td>
                            <td>
                                <span className={`dot dot-${service.status}`} /> {service.status}
                            </td>
                            <UsageCells usage={serviceUsageOf(view, service, usage)} />
                        </tr>
                    ))}
                </tbody>
            </table>
            <DiffRows view={view} run={run} />
        </>
    );
}
