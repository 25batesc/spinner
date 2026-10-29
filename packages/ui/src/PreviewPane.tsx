import { useState } from "react";

import { preview_key, type ServiceView, type SessionView } from "@spinner/protocol";

import { PaneHead } from "./PaneHead.tsx";
import { Preview, type PopOutRequest } from "./Preview.tsx";
import type { RunAction } from "./SessionsPane.tsx";
import { Tabs } from "./Tabs.tsx";

export interface PreviewPaneProps {
    view: SessionView | undefined;
    busy: boolean;
    run: RunAction;
    /**
     * Hide and pop out; absent when the pane is rendered alone by the `?pane=` route. Pop out
     * names the preview on show, so the desktop app can move that view to the new window.
     */
    controls?:
        | {
              onHide: () => void;
              onPopOut: (preview: PopOutRequest["preview"]) => void;
          }
        | undefined;
}

/** `unknown` is a running service with no healthcheck, so it is as live as the daemon can tell. */
function isLive(service: ServiceView): boolean {
    return service.status === "healthy" || service.status === "unknown";
}

function Verified({ view, busy, run }: PreviewPaneProps & { view: SessionView }) {
    const pipeline = view.summary.session.pipeline;
    const ticked = pipeline?.verified_locally === true;
    // The daemon says when the operator can test: while the stack is up.
    const canVerify = view.can_verify;
    return (
        <label className="verified" title={canVerify ? "" : "Bring the stack up to verify."}>
            <input
                type="checkbox"
                checked={ticked}
                disabled={busy || ticked || !canVerify}
                onChange={() => void run(`/sessions/${view.summary.dir}/verify`)}
            />
            verified
            {ticked && pipeline?.verified_by !== undefined && (
                <span className="muted"> by {pipeline.verified_by}</span>
            )}
        </label>
    );
}

export function PreviewPane({ view, busy, run, controls }: PreviewPaneProps) {
    const [picked, setPicked] = useState<string | undefined>(undefined);
    const [reloads, setReloads] = useState(0);
    const services = (view?.stack.services ?? []).filter((service) => service.url !== null);
    const names = services.map((service) => service.name);
    const selected = picked !== undefined && names.includes(picked) ? picked : names[0];
    const service = services.find((candidate) => candidate.name === selected);
    const grey = services.filter((candidate) => !isLive(candidate)).map((c) => c.name);
    const shown =
        view !== undefined && service?.url != null && isLive(service)
            ? { key: preview_key(view.summary.dir, service.name), url: service.url }
            : undefined;
    const head =
        controls === undefined
            ? undefined
            : { onHide: controls.onHide, onPopOut: () => controls.onPopOut(shown) };

    return (
        <section className="pane preview-pane" aria-label="Previews">
            <PaneHead name="previews" controls={head} />
            {view !== undefined && <Verified view={view} busy={busy} run={run} />}
            <Tabs labels={names} selected={selected} onSelect={setPicked} grey={grey} />
            {view !== undefined && service?.url != null && isLive(service) ? (
                <>
                    <div className="preview-bar">
                        <a href={service.url} target="_blank" rel="noreferrer">open in tab</a>
                        <button onClick={() => setReloads(reloads + 1)}>reload</button>
                    </div>
                    <Preview
                        key={service.url}
                        previewKey={preview_key(view.summary.dir, service.name)}
                        url={service.url}
                        title={service.name}
                        reloads={reloads}
                        topLevel={service.preview === "top-level"}
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
