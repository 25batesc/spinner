import { useState } from "react";

import type { ServiceView, SessionView } from "@spinner/protocol";

import { Preview } from "./Preview.tsx";
import type { RunAction } from "./SessionsPane.tsx";
import { Tabs } from "./Tabs.tsx";

export interface PreviewPaneProps {
    view: SessionView | undefined;
    busy: boolean;
    run: RunAction;
}

/** `unknown` is a running service with no healthcheck, so it is as live as the daemon can tell. */
function isLive(service: ServiceView): boolean {
    return service.status === "healthy" || service.status === "unknown";
}

function Verified({ view, busy, run }: PreviewPaneProps & { view: SessionView }) {
    const pipeline = view.summary.session.pipeline;
    const ticked = pipeline?.verified_locally === true;
    return (
        <label className="verified">
            <input
                type="checkbox"
                checked={ticked}
                disabled={busy || ticked}
                onChange={() => void run(`/sessions/${view.summary.dir}/verify`)}
            />
            verified
            {ticked && pipeline?.verified_by !== undefined && (
                <span className="muted"> by {pipeline.verified_by}</span>
            )}
        </label>
    );
}

export function PreviewPane({ view, busy, run }: PreviewPaneProps) {
    const [picked, setPicked] = useState<string | undefined>(undefined);
    const [reloads, setReloads] = useState(0);
    const services = (view?.stack.services ?? []).filter((service) => service.url !== null);
    const names = services.map((service) => service.name);
    const selected = picked !== undefined && names.includes(picked) ? picked : names[0];
    const service = services.find((candidate) => candidate.name === selected);
    const grey = services.filter((candidate) => !isLive(candidate)).map((c) => c.name);

    return (
        <section className="pane preview-pane" aria-label="Previews">
            {view !== undefined && <Verified view={view} busy={busy} run={run} />}
            <Tabs labels={names} selected={selected} onSelect={setPicked} grey={grey} />
            {service?.url != null && isLive(service) ? (
                <>
                    <div className="preview-bar">
                        <a href={service.url} target="_blank" rel="noreferrer">open in tab</a>
                        <button onClick={() => setReloads(reloads + 1)}>reload</button>
                    </div>
                    <Preview
                        key={`${service.url}#${reloads}`}
                        url={service.url}
                        title={service.name}
                    />
                </>
            ) : (
                <p className="muted">
                    {view === undefined
                        ? "No session selected."
                        : service === undefined
                          ? `Stack ${view.stack.state}: no previews.`
                          : `${service.name} is ${service.status}.`}
                </p>
            )}
        </section>
    );
}
