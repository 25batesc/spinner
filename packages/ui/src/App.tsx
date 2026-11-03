import { Fragment, useEffect, useRef, useState } from "react";

import type { SessionView } from "@spinner/protocol";

import { AgentsPane } from "./AgentsPane.tsx";
import { fetchThemes, postAction, putSettings } from "./events-client.ts";
import { ActivityDrawer } from "./ActivityDrawer.tsx";
import { isOpen, isStrip, PANES, type PaneName } from "./layout.ts";
import { operatorHidden, operatorNotice, postOperator } from "./operator.ts";
import { OperatorPane } from "./OperatorPane.tsx";
import {
    ActivityBar,
    ContextBar,
    PaneStrip,
    type PanelView,
} from "./PaneHead.tsx";
import {
    popOutPane,
    resumePoppedOut,
    type PoppedOut,
    type PopOutRequest,
} from "./Preview.tsx";
import { gateCard, type StepId } from "./design.ts";
import { stepTab, type WorkspaceTab } from "./design-workspace.ts";
import { diffJob } from "./diff-view.ts";
import {
    focusedDir, loadFocus, NO_FOCUS, pickFocus, saveFocus, type Focus, type FocusPanel,
} from "./focus.ts";
import { PreviewPane } from "./PreviewPane.tsx";
import { deleteVerify, useLoaded } from "./remote.ts";
import { isReview, ordinarySessions, reviewFacts, reviewsByActivity } from "./review.ts";
import { ReviewPane } from "./ReviewPane.tsx";
import { ReviewsPane } from "./ReviewsPane.tsx";
import { SessionsPane } from "./SessionsPane.tsx";
import {
    ComposeForm, EMPTY_DRAFT, type ComposeDraft, type RunAction,
} from "./SessionForms.tsx";
import { SessionToolbar } from "./SessionToolbar.tsx";
import { SettingsPane } from "./SettingsPane.tsx";
import { Sidebar } from "./Sidebar.tsx";
import {
    DEFAULT_SIDEBAR, loadSeen, loadSidebar, markSeen, needsCount, pickView, saveSeen,
    saveSidebar, widthLevel, type Seen,
    type SidebarState,
} from "./sidebar.ts";
import { applyPalette, clearPalette, paletteFor } from "./theme.ts";
import {
    needsHuman, revisionsOf, runningJob, sortedSessions, type UiState,
} from "./state.ts";
import type { Transcript } from "./transcript.ts";
import { useLayout } from "./useResizable.ts";
import { useSpinner } from "./useSpinner.ts";

function transcriptsFor(dir: string | undefined, all: Record<string, Transcript>) {
    const result: Record<string, Transcript> = {};
    if (dir === undefined) {
        return result;
    }
    for (const [key, events] of Object.entries(all)) {
        if (key.startsWith(`${dir}/`)) {
            result[key.slice(dir.length + 1)] = events;
        }
    }
    return result;
}

/** The one action of a review session (s015): the swarm, in the context bar. */
function ReviewToolbar(props: { dir: string; busy: boolean; run: RunAction }) {
    const { dir, busy, run } = props;
    return (
        <div className="actions toolbar rv-toolbar" role="toolbar" aria-label="Review actions">
            <button
                disabled={busy}
                title="Start the review swarm: one reviewer per model"
                onClick={() => void run(`/sessions/${dir}/review`)}
            >
                review
            </button>
        </div>
    );
}

/** True when a PR of the session is open or a draft: what the `review` step needs. */
function hasOpenPr(view: SessionView | undefined): boolean {
    const prs = view?.board?.prs ?? [];
    return prs.some((pr) => pr.state === "open" || pr.state === "draft");
}

export interface PaneRoute {
    pane: PaneName;
    session: string | undefined;
}

/** `?pane=<name>&session=<dir>` renders one pane alone, for a pop-out window. */
export function paneRouteOf(search: string): PaneRoute | undefined {
    const params = new URLSearchParams(search);
    const pane = params.get("pane");
    if (pane === null || !PANES.includes(pane as PaneName)) {
        return undefined;
    }
    return { pane: pane as PaneName, session: params.get("session") ?? undefined };
}

function windowStorage(): Storage | undefined {
    try {
        return window.sessionStorage;
    } catch {
        return undefined;
    }
}

/** View state and the action runner, shared by the main layout and a pane route. */
function useAppState(state: UiState, route: PaneRoute | undefined) {
    // The daemon never sends which session or job the operator looks at. The main window
    // remembers it across a reload (`focus.ts`); a pane route takes it from its URL.
    const inRoute = route !== undefined;
    const [focus, setFocus] = useState<Focus>(() =>
        route === undefined
            ? loadFocus(windowStorage())
            : { ...NO_FOCUS, session: route.session },
    );
    useEffect(() => {
        if (!inRoute) {
            saveFocus(windowStorage(), focus);
        }
    }, [focus, inRoute]);
    const pick = (panel: FocusPanel, dir: string) => setFocus((old) => pickFocus(old, panel, dir));
    // The needs-you lines the operator has looked at: the badges count the rest (`sidebar.ts`).
    const [seen, setSeen] = useState<Seen>(() => (inRoute ? {} : loadSeen(windowStorage())));
    useEffect(() => {
        if (!inRoute) {
            saveSeen(windowStorage(), seen);
        }
    }, [seen, inRoute]);
    const [watched, setWatched] = useState<string | undefined>(undefined);
    const [actionError, setActionError] = useState<string | null>(null);
    // The compose box's text, pinned in the sessions section: it lives here, so a fold of the
    // section keeps it; the created session clears it.
    const [draft, setDraft] = useState<ComposeDraft>(EMPTY_DRAFT);

    const sessions = sortedSessions(state);
    const selected = focusedDir(focus, sessions);
    const view = selected === undefined ? undefined : state.sessions[selected];
    // The selected session's needs-you line counts as seen while the operator looks at it.
    useEffect(() => {
        if (selected !== undefined) {
            setSeen((old) => markSeen(old, selected, view));
        }
    }, [selected, view === undefined ? null : needsHuman(view)]);
    const feed = selected === undefined ? [] : state.feed.filter((l) => l.session === selected);
    const busy = selected !== undefined && runningJob(state, selected) !== undefined;
    const job = watched === undefined ? undefined : state.jobs[watched];

    // A finished `new`, `adopt` or `reviews` names its session; show it.
    useEffect(() => {
        const creates = job?.action === "new" || job?.action === "adopt" ||
            job?.action === "reviews";
        const created = job?.state === "ok" && creates;
        if (created && job.session !== null) {
            const review = job.action === "reviews";
            pick(review ? "reviews" : "sessions", job.session);
            if (!review) {
                setDraft(EMPTY_DRAFT);
            }
        }
    }, [job?.state, job?.action, job?.session]);

    const run = (path: string, body?: unknown): Promise<void> => {
        setActionError(null);
        return postAction(path, body).then(
            (accepted) => setWatched(accepted.id),
            (failure: unknown) => setActionError(String(failure)),
        );
    };
    // Not a job: the daemon answers with the view and sends `session.updated`, which moves
    // the checkbox; a failure lands where a job's does.
    const unverify = (dir: string): Promise<void> => {
        setActionError(null);
        return deleteVerify(dir).then(
            () => undefined,
            (failure: unknown) => setActionError(String(failure)),
        );
    };
    const dismiss = () => {
        setWatched(undefined);
        setActionError(null);
    };
    return {
        sessions, selected, view, feed, busy, run, unverify, job, actionError, dismiss,
        focus, pick, setActionError, draft, setDraft, seen,
    };
}

export function App() {
    const route = paneRouteOf(window.location.search);
    const state = useSpinner();
    const app = useAppState(state, route);
    const { sessions, selected, view, feed, busy, run, seen } = app;
    const layout = useLayout();
    // The side panel's view, or none, remembered per window (`sidebar.ts`).
    const inRoute = route !== undefined;
    const [sidebar, setSidebar] = useState<SidebarState>(() =>
        inRoute ? DEFAULT_SIDEBAR : loadSidebar(windowStorage()),
    );
    useEffect(() => {
        if (!inRoute) {
            saveSidebar(windowStorage(), sidebar);
        }
    }, [sidebar, inRoute]);
    // The middle pane shows the selected session or, from the headset icon, the operator agent.
    const [middle, setMiddle] = useState<"agents" | "operator">("agents");
    // The agents pane's view and picked agent live here (entry 3.22), so the `needs you` pill
    // can open a gate card: the `agents` view with `lead` picked.
    const [agentsShown, setAgentsShown] = useState("agents");
    const [agentPicked, setAgentPicked] = useState<string | undefined>(undefined);
    const card = view === undefined ? null : gateCard(view.design, needsHuman(view));
    const openCard = card === null ? undefined : () => {
        setMiddle("agents");
        setAgentsShown("agents");
        setAgentPicked("lead");
    };
    // The design workspace's tab per session (entry 5.11): another session opens on its
    // track's default tab. A stepper step or the round badge opens the workspace on a tab.
    const [designPick, setDesignPick] = useState<{ dir: string; tab: WorkspaceTab } | null>(
        null,
    );
    const designTab = designPick !== null && designPick.dir === selected ? designPick.tab : null;
    const openDesign = (tab: WorkspaceTab) => {
        if (selected === undefined) {
            return;
        }
        setMiddle("agents");
        setAgentsShown("design");
        setDesignPick({ dir: selected, tab });
    };
    const hasDesign = view?.design !== undefined;
    const onStep = hasDesign ? (step: StepId) => openDesign(stepTab(step)) : undefined;
    const onRound = hasDesign ? () => openDesign("history") : undefined;
    const notice = operatorNotice(state.operator);
    // The link's failure lands where a job's does, in the drawer.
    const operatorBar =
        notice === null
            ? undefined
            : {
                  notice,
                  onResume: () =>
                      void postOperator("start").catch((failure: unknown) =>
                          app.setActionError(String(failure)),
                      ),
              };
    // The themes list follows the settings: a change may name a file written since the load.
    const settingsKey = JSON.stringify(state.settings);
    const themes = useLoaded(`themes#${settingsKey}`, fetchThemes).value ?? null;
    // The page's palette follows `settings.theme` in every window; `system` is the stylesheet.
    const themeName = state.settings?.theme;
    useEffect(() => {
        const palette =
            themeName === undefined ? null : paletteFor(themeName, themes?.themes ?? []);
        if (palette === null) {
            clearPalette();
        } else {
            applyPalette(palette, document.documentElement, themeName);
        }
    }, [themeName, themes]);
    const drawer = (
        <ActivityDrawer
            feed={feed}
            job={app.job}
            error={app.actionError}
            onDismiss={app.dismiss}
            drawer={layout.layout.drawer}
            onResize={layout.setDrawerHeight}
            onCollapse={layout.setDrawerCollapsed}
        />
    );
    const popped = useRef<Partial<Record<PaneName, PoppedOut>>>({});

    const docked = (pane: PaneName) => () => {
        delete popped.current[pane];
        layout.setPopped(pane, false);
    };
    // The previews header pops its pane out: the desktop app moves the current tab's view
    // into a window, a browser opens the `?pane=previews` route. The strip docks it back.
    const popOut = (pane: PaneName, preview?: PopOutRequest["preview"]) => {
        const handle = popOutPane({ pane, session: selected, preview }, docked(pane));
        if (typeof handle === "string") {
            app.setActionError(handle);
            return;
        }
        popped.current[pane] = handle;
        layout.setPopped(pane, true);
    };
    // A popped-out window outlives a reload of this page (the desktop app also opens one from
    // its tray), so the strips come back and dock the pane on a click.
    useEffect(() => {
        if (route !== undefined) {
            return;
        }
        resumePoppedOut((pane, attach) => {
            popped.current[pane] = attach(docked(pane));
            layout.setPopped(pane, true);
        });
        // Once, on mount: the handles live in a ref and `setPopped` is stable.
    }, []);
    // Escape leaves the expanded previews.
    const expanded = layout.layout.expanded;
    useEffect(() => {
        if (!expanded) {
            return;
        }
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                layout.setExpanded(false);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [expanded, layout.setExpanded]);

    // A strip the window's width made (the stored pane is open) has nothing to restore: the
    // click folds the side panel instead, which is the room the previews need.
    const restore = (pane: PaneName) => {
        const handle = popped.current[pane];
        if (handle !== undefined) {
            handle.dock();
        } else if (isStrip(layout.fitted.panes[pane]) && isOpen(layout.layout.panes[pane])) {
            layout.fold("sessions");
        } else {
            layout.restore(pane);
        }
    };
    const sessionsState = layout.layout.panes.sessions;
    // The panel is on screen when the fitted layout gives it an open column: not collapsed,
    // not folded by a drag or by the window's width, not popped out, not under expanded.
    const columnShown =
        !expanded && layout.visible.includes("sessions") && isOpen(layout.fitted.panes.sessions);
    // The view and the column's fold agree: a drag past the snap folds the column, so the
    // view goes to none; a view of none folds the column (a record from another window).
    const folded = sessionsState.hidden;
    useEffect(() => {
        if (inRoute) {
            return;
        }
        if (folded && sidebar.view !== null) {
            setSidebar({ view: null });
        } else if (!folded && sidebar.view === null) {
            layout.fold("sessions");
        }
    }, [folded, sidebar.view, inRoute]);
    const openColumn = () => {
        if (sessionsState.popped) {
            restore("sessions");
        } else if (sessionsState.hidden) {
            layout.restore("sessions");
        } else if (layout.fitted.panes.sessions.hidden) {
            // The width folded the column: collapse the previews so it has room.
            layout.fold("previews");
        }
    };
    // A rail icon opens its view in the panel; the lit icon collapses the panel.
    const pickRail = (id: PanelView["id"]) => {
        if (expanded) {
            return;
        }
        const next = pickView(sidebar, id, columnShown);
        setSidebar(next);
        if (next.view === null) {
            layout.fold("sessions");
        } else {
            openColumn();
        }
    };
    const review = view === undefined ? null : reviewFacts(view);
    const reviewsPane = (
        <ReviewsPane
            reviews={reviewsByActivity(sessions)}
            selected={selected}
            busy={busy}
            onSelect={(dir) => app.pick("reviews", dir)}
            run={run}
        />
    );
    const sessionsPane = (
        <SessionsPane
            sessions={ordinarySessions(sessions)}
            usage={state.usage}
            selected={selected}
            onSelect={(dir) => app.pick("sessions", dir)}
            run={run}
            compose={(close) => (
                <ComposeForm run={run} draft={app.draft} onDraft={app.setDraft} onStarted={close} />
            )}
        />
    );
    const agentsPane = review !== null && view !== undefined ? (
        <ReviewPane
            view={view}
            facts={review}
            busy={busy}
            run={run}
            revisions={revisionsOf(state, selected)}
            controls={inRoute ? undefined : []}
        >
            {drawer}
        </ReviewPane>
    ) : (
        <AgentsPane
            view={view}
            busy={busy}
            run={run}
            transcripts={transcriptsFor(selected, state.transcripts)}
            usage={state.usage}
            revisions={revisionsOf(state, selected)}
            mission={selected === undefined ? undefined : state.missions[selected]}
            controls={inRoute ? undefined : []}
            shown={agentsShown}
            onShown={setAgentsShown}
            picked={agentPicked}
            onPicked={setAgentPicked}
            designTab={designTab}
            onDesignTab={(tab) => {
                if (selected !== undefined) {
                    setDesignPick({ dir: selected, tab });
                }
            }}
            onError={app.setActionError}
        >
            {drawer}
        </AgentsPane>
    );
    const previewsPane = (
        <PreviewPane
            view={view}
            busy={busy}
            run={run}
            unverify={app.unverify}
            diffJob={selected === undefined ? undefined : diffJob(state, selected)}
            controls={
                inRoute
                    ? undefined
                    : {
                          // Hidden while expanded: the expand icon is the one exit.
                          onToggle: expanded ? undefined : () => layout.fold("previews"),
                          expanded,
                          onExpand: layout.setExpanded,
                          onPopOut: (preview) => popOut("previews", preview),
                      }
            }
        />
    );
    const settingsPane = (
        <SettingsPane
            settings={state.settings}
            themes={themes}
            costs={state.costs}
            jobs={Object.values(state.jobs)}
            onChange={async (next) => {
                await putSettings(next);
            }}
            controls={inRoute ? undefined : []}
        />
    );
    const operatorPane = (
        <OperatorPane view={state.operator} controls={inRoute ? undefined : []} />
    );
    // The operator tab goes when the agent is off and stopped: back to the session.
    const operatorOn = middle === "operator" && !operatorHidden(state.operator);
    const toggleOperator = () => setMiddle(middle === "operator" ? "agents" : "operator");
    const ordinary = ordinarySessions(sessions);
    const reviewRows = sessions.filter(([, row]) => isReview(row));
    const needs = { sessions: needsCount(ordinary, seen), reviews: needsCount(reviewRows, seen) };
    // A collapsed panel keeps its column out of the grid; the last view stands in for none,
    // so the cell is never empty while the fold catches up.
    const sideView = sidebar.view ?? "sessions";
    const sideViews = {
        sessions: { facts: { count: ordinary.length, needs: needs.sessions }, pane: sessionsPane },
        reviews: { facts: { count: reviewRows.length, needs: needs.reviews }, pane: reviewsPane },
        settings: { facts: undefined, pane: settingsPane },
    };
    const sidePanel = (
        <Sidebar
            view={sideView}
            level={inRoute ? "full" : widthLevel(layout.fitted.panes.sessions.width)}
            facts={sideViews[sideView].facts}
        >
            {sideViews[sideView].pane}
        </Sidebar>
    );
    const middlePane = operatorOn ? operatorPane : agentsPane;
    const panes = { sessions: sidePanel, agents: middlePane, previews: previewsPane };
    const status = (
        <footer className="status" data-connection={state.connection}>
            daemon: {state.connection}
        </footer>
    );

    if (route !== undefined) {
        return (
            <div className="layout layout-single" data-pane={route.pane}>
                {panes[route.pane]}
                {route.pane !== "agents" && drawer}
                {status}
            </div>
        );
    }

    // The fitted layout draws: a narrow window shows strips the stored layout does not have.
    const slot = (pane: PaneName) =>
        isStrip(layout.fitted.panes[pane]) ? (
            <PaneStrip
                name={pane}
                popped={layout.fitted.panes[pane].popped}
                onRestore={() => restore(pane)}
            />
        ) : (
            panes[pane]
        );
    // One cell per visible pane, a divider between two neighbours.
    const cells = layout.visible.flatMap((pane, index) => {
        const before = layout.visible[index - 1];
        const cell = <Fragment key={pane}>{slot(pane)}</Fragment>;
        if (before === undefined) {
            return [cell];
        }
        const props = layout.handle(before, pane);
        return [<div key={`${before}|${pane}`} className="handle" {...props} />, cell];
    });
    // The drawer sits under the agents pane; with the pane folded or swapped for the operator
    // tab, it takes a row of its own. Expanded, only the previews show: no drawer at all.
    const agentsOff = !expanded && (isStrip(layout.fitted.panes.agents) || operatorOn);
    return (
        <div className={expanded ? "shell shell-expanded" : "shell"}>
            <ContextBar
                view={view}
                usage={state.usage}
                operator={operatorBar}
                onError={app.setActionError}
                onNeeds={openCard}
                onStep={onStep}
                onRound={onRound}
                toolbar={
                    review !== null && selected !== undefined ? (
                        <ReviewToolbar dir={selected} busy={busy} run={run} />
                    ) : (
                        <SessionToolbar
                            dir={selected}
                            openPr={hasOpenPr(view)}
                            busy={busy}
                            run={run}
                            revision={revisionsOf(state, selected).pipeline}
                            view={view}
                            onError={app.setActionError}
                        />
                    )
                }
            />
            <div className="shell-body">
                <ActivityBar
                    shown={columnShown && sidebar.view !== null ? sidebar.view : undefined}
                    popped={sessionsState.popped}
                    onPick={pickRail}
                    needs={needs}
                    operatorShown={operatorOn}
                    operatorAvailable={!operatorHidden(state.operator)}
                    onOperator={toggleOperator}
                />
                <div
                    ref={layout.container}
                    className={layout.dragging ? "layout layout-dragging" : "layout"}
                    style={{ gridTemplateColumns: layout.columns }}
                    data-armed={layout.armed ?? undefined}
                >
                    {cells}
                    {agentsOff && <div className="drawer-row">{drawer}</div>}
                    {status}
                </div>
            </div>
        </div>
    );
}
