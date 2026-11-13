import { useMemo, useState, type ReactNode } from "react";

import { preview_key, type Job, type ServiceView, type SessionView } from "@spinner/protocol";

import { CommentStrip } from "./CommentThreads.tsx";
import { diffPreviewService, diffRepos, diffSelected } from "./diff-view.ts";
import { opensOnChanges } from "./changes.ts";
import { useOpenActivity } from "./ActivityDrawer.tsx";
import { ChangesRail, useOpenChange } from "./ChangesRail.tsx";
import { isReview } from "./review.ts";
import { DiffPage } from "./DiffPage.tsx";
import type { IconButtonProps } from "./PaneHead.tsx";
import { Preview, type PopOutRequest } from "./Preview.tsx";
import {
    loadPreviewChoice,
    localChoiceStorage,
    savePreviewChoice,
    type PreviewChoice,
} from "./preview-choice.ts";
import { fetchComments, useLoaded } from "./remote.ts";
import type { RunAction } from "./SessionsPane.tsx";
import { Tabs } from "./Tabs.tsx";
import { ViewTabs } from "./ViewTabs.tsx";

export interface PreviewPaneProps {
    view: SessionView | undefined;
    busy: boolean;
    run: RunAction;
    /** The newest `diff` job of the session: the diff view's progress line. */
    diffJob?: Job | undefined;
    /** Clears the verify tick (`DELETE /sessions/:dir/verify`); errors go where `run`'s go. */
    unverify: (dir: string) => Promise<void>;
    /** Moves on `comment.updated` for the session: the preview comments reload (s054). */
    commentsRevision?: number | undefined;
    /**
     * The activity tab (the operator's request of 2026-11-13): the watched job's log and the
     * event feed, beside the previews and the diff. `label` says when a job runs or failed.
     */
    activity?: { label: string; panel: ReactNode } | undefined;
    /** Moves on pipeline events: the Changes rail's post preview reloads. */
    pipelineRevision?: number | undefined;
    /** Header icons; absent when the pane is rendered alone by the `?pane=` route. */
    controls?:
        | {
              /** Collapses the pane to the edge strip; absent while expanded. */
              onToggle?: (() => void) | undefined;
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
    // The daemon says when the stack is up; the tick is the operator's word either way (a
    // change verified another way, with the stack down, is still verified).
    const stackUp = view.can_verify;
    const dir = view.summary.dir;
    const toggle = async () => {
        setPending(true);
        try {
            await (ticked ? unverify(dir) : run(`/sessions/${dir}/verify`));
        } finally {
            setPending(false);
        }
    };
    const title = ticked || stackUp
        ? ""
        : "The stack is down. Tick when you verified the change another way.";
    return (
        <label className="verified" title={title}>
            <input
                type="checkbox"
                checked={ticked}
                disabled={busy || pending}
                onChange={() => void toggle()}
            />
            verified
            {ticked && pipeline?.verified_by !== undefined && (
                <span className="muted"> by {pipeline.verified_by}</span>
            )}
        </label>
    );
}

/**
 * The pane's views. `diff` is offered once the daemon sends `SessionView.diff`; `changes`
 * (the PR view, talk-change-ship.md 2.9) for an ordinary session whose daemon sends
 * `SessionView.changes`. Its id stays `changes`, the one a saved preview choice holds.
 */
const VIEWS = ["changes", "previews", "diff", "activity"] as const;

const VIEW_LABELS: Record<(typeof VIEWS)[number], string> = {
    changes: "PRs",
    previews: "previews",
    diff: "diff",
    activity: "activity",
};

/** The view tabs a session has. */
function viewTabs(
    view: SessionView | undefined,
    activity: string | undefined,
): { id: string; label: string }[] {
    const has = {
        changes: view !== undefined && !isReview(view) && view.changes !== undefined,
        previews: true,
        diff: view?.diff !== undefined,
        activity: activity !== undefined,
    };
    return VIEWS.filter((id) => has[id]).map((id) => ({
        id,
        // The activity tab's label says when a job runs or failed.
        label: id === "activity" ? (activity ?? VIEW_LABELS.activity) : VIEW_LABELS[id],
    }));
}

/** The preview the pane shows in the browser bar's place: what a pop-out takes along. */
function shownPreview(
    view: SessionView,
    tab: string,
    service: ServiceView | undefined,
    repoPicked: string | undefined,
): PopOutRequest["preview"] {
    const dir = view.summary.dir;
    if (tab === "diff") {
        const repo = diffSelected(diffRepos(view), repoPicked);
        if (repo === undefined || repo[1].state !== "running" || repo[1].url === null) {
            return undefined;
        }
        return { key: preview_key(dir, diffPreviewService(repo[0])), url: repo[1].url };
    }
    if (service?.url != null && isLive(service)) {
        return { key: preview_key(dir, service.name), url: service.url };
    }
    return undefined;
}

export function PreviewPane(props: PreviewPaneProps) {
    const { view, busy, run, unverify, controls, diffJob, commentsRevision = 0 } = props;
    const pipelineRevision = props.pipelineRevision ?? 0;
    // The tabs are remembered per session in localStorage, which a popped-out pane window
    // shares with the main window: the pop-out opens on the tab the operator was on.
    const sessionDir = view?.summary.dir;
    const saved = useMemo(
        () => (sessionDir === undefined ? {} : loadPreviewChoice(localChoiceStorage(), sessionDir)),
        [sessionDir],
    );
    const remember = (patch: PreviewChoice) => {
        if (sessionDir !== undefined) {
            savePreviewChoice(localChoiceStorage(), sessionDir, patch);
        }
    };
    const [pickedState, setPickedState] = useState<string | undefined>(undefined);
    const picked = pickedState ?? saved.service;
    const setPicked = (name: string) => {
        setPickedState(name);
        remember({ service: name });
    };
    // A review session (s015) opens on the diff at the PR head; it has no stack to preview.
    const [tabState, setTabState] = useState<string | undefined>(undefined);
    // With the stack down and a pull request open, the rail says more than an empty preview.
    const opening = view !== undefined && opensOnChanges(view) ? "changes" : "previews";
    const tabs = viewTabs(view, props.activity?.label);
    // A failed job shows the activity tab until the operator picks a tab; the pick he made
    // before is not replaced, so the next session opens where he left it.
    const [peek, setPeek] = useState(false);
    useOpenActivity(() => setPeek(true));
    const chosen = tabState ?? saved.tab ?? (isReview(view) ? "diff" : opening);
    const wanted = peek && props.activity !== undefined ? "activity" : chosen;
    const tab = tabs.some((entry) => entry.id === wanted) ? wanted : "previews";
    const setTab = (name: string) => {
        setPeek(false);
        setTabState(name);
        // The activity is a look, not where a session opens.
        if (name !== "activity") {
            remember({ tab: name });
        }
    };
    // The PR chip of the context bar opens this tab on one change.
    const [focus, setFocus] = useState<{ change: string; seq: number } | undefined>(undefined);
    useOpenChange((detail) => {
        if (detail.dir === sessionDir) {
            setTab("changes");
            setFocus({ change: detail.change, seq: (focus?.seq ?? 0) + 1 });
        }
    });
    const [repoState, setRepoState] = useState<string | undefined>(undefined);
    const repoPicked = repoState ?? saved.repo;
    const setRepoPicked = (name: string) => {
        setRepoState(name);
        remember({ repo: name });
    };
    const services = (view?.stack.services ?? []).filter((service) => service.url !== null);
    const names = services.map((service) => service.name);
    const selected = picked !== undefined && names.includes(picked) ? picked : names[0];
    const service = services.find((candidate) => candidate.name === selected);
    const grey = services.filter((candidate) => !isLive(candidate)).map((c) => c.name);
    const hasDiff = view?.diff !== undefined;
    const shown =
        view === undefined ? undefined : shownPreview(view, tab, service, repoPicked);
    const dir = view?.summary.dir ?? "";
    const loaded = useLoaded(`${dir}#${commentsRevision}`, (signal) =>
        dir === "" ? Promise.resolve({ comments: [] }) : fetchComments(dir, signal),
    );
    const comments = loaded.value?.comments ?? [];
    const agents = Object.keys(view?.summary.session.agents ?? {});
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
                  ...(controls.onToggle === undefined ? [] : [{
                      icon: "panel-right" as const,
                      label: "Collapse previews",
                      onClick: controls.onToggle,
                  }]),
              ];

    if (tab === "activity" && props.activity !== undefined) {
        return (
            <section className="pane preview-pane" aria-label="Previews">
                <ViewTabs
                    tabs={tabs}
                    shown={tab}
                    onSelect={setTab}
                    controls={head}
                    label="Preview views"
                />
                {props.activity.panel}
            </section>
        );
    }
    if (tab === "changes" && view !== undefined) {
        return (
            <section className="pane preview-pane" aria-label="Previews">
                <ViewTabs
                    tabs={tabs}
                    shown={tab}
                    onSelect={setTab}
                    controls={head}
                    label="Preview views"
                />
                <ChangesRail
                    view={view}
                    busy={busy}
                    run={run}
                    revision={pipelineRevision}
                    focus={focus}
                />
            </section>
        );
    }
    if (hasDiff && tab === "diff" && view !== undefined) {
        return (
            <section className="pane preview-pane" aria-label="Previews">
                <ViewTabs
                    tabs={tabs}
                    shown={tab}
                    onSelect={setTab}
                    controls={head}
                    label="Preview views"
                />
                <DiffPage
                    view={view}
                    busy={busy}
                    run={run}
                    job={diffJob}
                    picked={repoPicked}
                    onPick={setRepoPicked}
                />
            </section>
        );
    }
    return (
        <section className="pane preview-pane" aria-label="Previews">
            <ViewTabs
                tabs={tabs}
                shown="previews"
                onSelect={setTab}
                controls={head}
                label="Preview views"
            />
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
                    <CommentStrip dir={dir} service={service.name} comments={comments} />
                    <Preview
                        key={service.url}
                        previewKey={preview_key(view.summary.dir, service.name)}
                        url={service.url}
                        title={service.name}
                        topLevel={service.preview === "top-level"}
                        comments={{ dir, service: service.name, agents, comments }}
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
