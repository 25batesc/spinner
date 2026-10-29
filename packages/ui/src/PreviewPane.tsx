import { useState } from "react";

import { preview_key, type ServiceView, type SessionView } from "@spinner/protocol";

import { PaneHead, type IconButtonProps } from "./PaneHead.tsx";
import { Preview, type PopOutRequest } from "./Preview.tsx";
import type { RunAction } from "./SessionsPane.tsx";
import { Tabs } from "./Tabs.tsx";

export interface PreviewPaneProps {
    view: SessionView | undefined;
    busy: boolean;
    run: RunAction;
    /** Header icons; absent when the pane is rendered alone by the `?pane=` route. */
    controls?:
        | {
              /** Collapses the pane to the edge strip. */
              onToggle: () => void;
              expanded: boolean;
              onExpand: (expanded: boolean) => void;
              /** Pops the pane out; names the preview on show so the desktop moves that view. */
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
    const services = (view?.stack.services ?? []).filter((service) => service.url !== null);
    const names = services.map((service) => service.name);
    const selected = picked !== undefined && names.includes(picked) ? picked : names[0];
    const service = services.find((candidate) => candidate.name === selected);
    const grey = services.filter((candidate) => !isLive(candidate)).map((c) => c.name);
    const shown =
        view !== undefined && service?.url != null && isLive(service)
            ? { key: preview_key(view.summary.dir, service.name), url: service.url }
            : undefined;
    const head: IconButtonProps[] | undefined =
        controls === undefined
            ? undefined
            : [
                  {
                      icon: controls.expanded ? "shrink" : "expand",
                      label: controls.expanded ? "Restore layout" : "Expand previews",
                      active: controls.expanded,
                      onClick: () => controls.onExpand(!controls.expanded),
                  },
                  {
                      icon: "pop-out",
                      label: "Pop out previews",
                      onClick: () => controls.onPopOut(shown),
                  },
                  { icon: "panel-right", label: "Collapse previews", onClick: controls.onToggle },
              ];

    return (
        <section className="pane preview-pane" aria-label="Previews">
            <PaneHead name="previews" controls={head} />
            {view !== undefined && <Verified view={view} busy={busy} run={run} />}
            <Tabs
                labels={names}
                selected={selected}
                onSelect={setPicked}
                grey={grey}
                dots={Object.fromEntries(services.map((s) => [s.name, s.status]))}
            />
            {view !== undefined && service?.url != null && isLive(service) ? (
                <>
                    <Preview
                        key={service.url}
                        previewKey={preview_key(view.summary.dir, service.name)}
                        url={service.url}
                        title={service.name}
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
