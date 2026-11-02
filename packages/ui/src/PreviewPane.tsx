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
    /** Clears the verify tick (`DELETE /sessions/:dir/verify`); errors go where `run`'s go. */
    unverify: (dir: string) => Promise<void>;
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

/**
 * The tick follows the daemon's view: a change arrives as `session.updated`, never from local
 * state. Ticking is a job (`POST .../verify`), unticking is `DELETE .../verify`; a mistaken tick
 * clears whatever the stack's state. `pending` only holds the box until the daemon answers.
 */
function Verified({ view, busy, run, unverify }: PreviewPaneProps & { view: SessionView }) {
    const [pending, setPending] = useState(false);
    const pipeline = view.summary.session.pipeline;
    const ticked = pipeline?.verified_locally === true;
    // The daemon says when the operator can test: while the stack is up.
    const canVerify = view.can_verify;
    const dir = view.summary.dir;
    const toggle = async () => {
        setPending(true);
        try {
            await (ticked ? unverify(dir) : run(`/sessions/${dir}/verify`));
        } finally {
            setPending(false);
        }
    };
    const title = ticked || canVerify ? "" : "Bring the stack up to verify.";
    return (
        <label className="verified" title={title}>
            <input
                type="checkbox"
                checked={ticked}
                disabled={busy || pending || (!ticked && !canVerify)}
                onChange={() => void toggle()}
            />
            verified
            {ticked && pipeline?.verified_by !== undefined && (
                <span className="muted"> by {pipeline.verified_by}</span>
            )}
        </label>
    );
}

export function PreviewPane({ view, busy, run, unverify, controls }: PreviewPaneProps) {
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
            <div className="preview-tabs">
                <Tabs
                    labels={names}
                    selected={selected}
                    onSelect={setPicked}
                    grey={grey}
                    dots={Object.fromEntries(services.map((s) => [s.name, s.status]))}
                />
                {view !== undefined && (
                    <Verified view={view} busy={busy} run={run} unverify={unverify} />
                )}
            </div>
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
