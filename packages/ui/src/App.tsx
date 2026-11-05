import { Fragment, useEffect, useRef, useState } from "react";

import type { SessionView } from "@spinner/protocol";

import { AgentsPane } from "./AgentsPane.tsx";
import { fetchThemes, postAction, putSettings } from "./events-client.ts";
import { ActivityDrawer, drawerOpens, type DrawerWatch } from "./ActivityDrawer.tsx";
import { ComposerPane } from "./Composer.tsx";
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
import { gateCard } from "./design.ts";
import { defaultView, type ViewId } from "./design-workspace.ts";
import { diffJob } from "./diff-view.ts";
import {
    activatePanel, focusedDir, loadFocus, nextAfter, NO_FOCUS, pickFocus, saveFocus, type Focus,
    type FocusPanel,
} from "./focus.ts";
import { PreviewPane } from "./PreviewPane.tsx";
import { deleteVerify, useLoaded } from "./remote.ts";
import { isReview, ordinarySessions, reviewFacts, reviewsByActivity } from "./review.ts";
import { ReviewPane } from "./ReviewPane.tsx";
import { ReviewsPane } from "./ReviewsPane.tsx";
import { SessionsPane } from "./SessionsPane.tsx";
import {
    ComposeForm, EMPTY_DRAFT, ReviewComposeForm, type ComposeDraft, type RunAction,
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

/**
 * What the middle pane shows: the selected session, the operator agent, or the composer that
 * `+ New session` or `+ New review` opens (s038).
 */
type Middle = "agents" | "operator" | "new-session" | "new-review";

function isComposer(middle: Middle): boolean {
    return middle === "new-session" || middle === "new-review";
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
    const [middle, setMiddle] = useState<Middle>("agents");
    // A pick in a list and a rail switch leave the composer; the draft stays for the way back.
    const leaveComposer = () => setMiddle((old) => (isComposer(old) ? "agents" : old));
    // The agents pane's view and picked agent live here (entry 3.22), so the `needs you` pill
    // can open a gate card and a created session can open on its lead: the `agents` view
    // with `lead` picked. The view is held per session (session-workspace.md 2.8): a session
    // nobody picked a view for opens on its track's default view.
    const [viewPicks, setViewPicks] = useState<Record<string, string>>({});
    const [agentPicked, setAgentPicked] = useState<string | undefined>(undefined);
    const pick = (panel: FocusPanel, dir: string) => {
        setFocus((old) => pickFocus(old, panel, dir));
        leaveComposer();
    };
    const activate = (panel: FocusPanel) => {
        setFocus((old) => activatePanel(old, panel));
        leaveComposer();
    };
    // The needs-you lines the operator has looked at: the badges count the rest (`sidebar.ts`).
    const [seen, setSeen] = useState<Seen>(() => (inRoute ? {} : loadSeen(windowStorage())));
    useEffect(() => {
        if (!inRoute) {
            saveSeen(windowStorage(), seen);
        }
    }, [seen, inRoute]);
    const [watched, setWatched] = useState<string | undefined>(undefined);
    const [actionError, setActionError] = useState<string | null>(null);
    // The composer's text: it lives here, so a look at a session and back keeps it; the
    // created session clears it.
    const [draft, setDraft] = useState<ComposeDraft>(EMPTY_DRAFT);
    const [reviewText, setReviewText] = useState("");

    const sessions = sortedSessions(state);
    // The composer stands in for a selection: the context bar, the cards and the previews
    // show none while it is open.
    const selected = isComposer(middle) ? undefined : focusedDir(focus, sessions);
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

    // The kind of composer whose `Start` job runs now: its button waits.
    const creates = job?.action === "new" || job?.action === "adopt" ||
        job?.action === "reviews";
    let starting: "session" | "review" | null = null;
    if (creates && job.state === "running") {
        starting = job.action === "reviews" ? "review" : "session";
    }
    // A finished `new`, `adopt` or `reviews` names its session; show it. A session opens on
    // its lead, the agent in charge; a review opens on its pane. The composer's draft clears.
    useEffect(() => {
        const dir = job?.session ?? null;
        if (!creates || job?.state !== "ok" || dir === null) {
            return;
        }
        const review = job.action === "reviews";
        setFocus((old) => pickFocus(old, review ? "reviews" : "sessions", dir));
        setMiddle("agents");
        if (review) {
            setReviewText("");
        } else {
            setDraft(EMPTY_DRAFT);
            setViewPicks((old) => ({ ...old, [dir]: "agents" }));
            setAgentPicked("lead");
        }
    }, [job?.state, job?.action, job?.session]);
    const agentsShown = selected === undefined
        ? defaultView(view)
        : viewPicks[selected] ?? defaultView(view);
    const setAgentsShown = (next: string) => {
        if (selected !== undefined) {
            setViewPicks((old) => ({ ...old, [selected]: next }));
        }
    };

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
    // The confirmed `archive` (s038) runs the `close` job. When the archived row is the one
    // shown, the selection moves to the next row of its list at once, so the operator never
    // looks at a session that is going away.
    const archive = (panel: FocusPanel, dir: string) => {
        if (dir === selected) {
            const rows = panel === "reviews"
                ? reviewsByActivity(sessions).map((facts) => facts.dir)
                : ordinarySessions(sessions).map(([row]) => row);
            const next = nextAfter(rows, dir);
            if (next !== undefined) {
                pick(panel, next);
            }
        }
        void run(`/sessions/${dir}/close`);
    };
    return {
        sessions, selected, view, feed, busy, run, unverify, job, actionError, dismiss,
        focus, pick, activate, setActionError, draft, setDraft, seen, middle, setMiddle,
        agentsShown, setAgentsShown, agentPicked, setAgentPicked, reviewText, setReviewText,
        starting, archive,
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
    const { middle, setMiddle, agentsShown, setAgentsShown, agentPicked, setAgentPicked } = app;
    const card = view === undefined ? null : gateCard(view.design, needsHuman(view));
    const openCard = card === null ? undefined : () => {
        setMiddle("agents");
        setAgentsShown("agents");
        setAgentPicked("lead");
    };
    // A view opened from elsewhere: the round badge opens History; `open in Draft` on
    // Implement opens Draft; the compact gate line and a rail chip open Agents on an agent.
    const openView = (id: ViewId) => {
        setMiddle("agents");
        setAgentsShown(id);
    };
    const openAgent = (name: string) => {
        openView("agents");
        setAgentPicked(name);
    };
    const onRound = view?.design === undefined ? undefined : () => openView("history");
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
    // The drawer opens itself for a failed job, a failed action or a new needs-you on the shown
    // session (row 4); the previous read lives in a ref, so a render compares against it.
    const watchNow: DrawerWatch = {
        jobId: app.job?.id ?? null,
        jobState: app.job?.state ?? null,
        error: app.actionError,
        dir: selected ?? null,
        needs: view === undefined ? null : needsHuman(view),
    };
    const watchBefore = useRef<DrawerWatch>(watchNow);
    useEffect(() => {
        if (drawerOpens(watchBefore.current, watchNow) && layout.layout.drawer.collapsed) {
            layout.setDrawerCollapsed(false);
        }
        watchBefore.current = watchNow;
    }, [watchNow.jobId, watchNow.jobState, watchNow.error, watchNow.dir, watchNow.needs]);
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
    // A click on a Spinner notification (#12): the desktop main process shows the window and
    // sends the session's dir; the main window opens that session's agents pane. A pane route
    // and a desktop build without the channel do not subscribe.
    useEffect(() => {
        if (route !== undefined) {
            return;
        }
        return window.spinnerDesktop?.sessions?.subscribeFocus((dir) => {
            app.pick("sessions", dir);
            setMiddle("agents");
        });
        // Once, on mount: `pick` and `setMiddle` only call state setters.
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
        // The list shown is the list the middle pane follows (`focus.ts` `activatePanel`).
        if (next.view === "sessions" || next.view === "reviews") {
            app.activate(next.view);
        }
        if (next.view === null) {
            layout.fold("sessions");
        } else {
            openColumn();
        }
    };
    const review = view === undefined ? null : reviewFacts(view);
    // The composer is the empty state too: a home with no sessions opens on it.
    let composer: "session" | "review" | null = null;
    if (middle === "new-review") {
        composer = "review";
    } else if (middle === "new-session" || (middle === "agents" && selected === undefined)) {
        composer = "session";
    }
    const reviewsPane = (
        <ReviewsPane
            reviews={reviewsByActivity(sessions)}
            selected={selected}
            busy={busy}
            onSelect={(dir) => app.pick("reviews", dir)}
            onArchive={(dir) => app.archive("reviews", dir)}
            run={run}
            onNew={() => setMiddle("new-review")}
            composing={composer === "review"}
        />
    );
    const sessionsPane = (
        <SessionsPane
            sessions={ordinarySessions(sessions)}
            usage={state.usage}
            selected={selected}
            onSelect={(dir) => app.pick("sessions", dir)}
            onArchive={(dir) => app.archive("sessions", dir)}
            run={run}
            onNew={() => setMiddle("new-session")}
            composing={composer === "session"}
        />
    );
    const composerForm = composer === "review" ? (
        <ReviewComposeForm
            run={run}
            text={app.reviewText}
            onText={app.setReviewText}
            starting={app.starting === "review"}
        />
    ) : (
        <ComposeForm
            run={run}
            draft={app.draft}
            onDraft={app.setDraft}
            starting={app.starting === "session"}
        />
    );
    const composerPane = (
        <ComposerPane label="Composer" form={composerForm}>
            {drawer}
        </ComposerPane>
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
            onOpenAgent={openAgent}
            onOpenView={openView}
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
        sessions: { facts: { count: ordinary.length }, pane: sessionsPane },
        reviews: { facts: { count: reviewRows.length }, pane: reviewsPane },
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
    let middlePane = agentsPane;
    if (operatorOn) {
        middlePane = operatorPane;
    } else if (composer !== null) {
        middlePane = composerPane;
    }
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
                            onArchive={(dir) => app.archive("sessions", dir)}
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
