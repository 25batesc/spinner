// The services view: one row per service with its state and its last usage sample (cpu,
// memory, i/o, process), under a line with the machine totals and this session's share. The
// cells read the latest sample (the `usage` event) on every render, so it updates them in
// place without a `session.updated`.
import type { ServiceUsage, SessionView } from "@spinner/protocol";

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

export function ServiceTable({ view, usage }: { view: SessionView; usage: UsageSample | null }) {
    const { services } = view.stack;
    if (services.length === 0) {
        return <p className="muted">No services: this session has no stack.</p>;
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
        </>
    );
}
