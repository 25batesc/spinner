import { Fragment, useEffect, useRef, useState } from "react";

import { AgentsPane } from "./AgentsPane.tsx";
import { fetchThemes, postAction, putSettings } from "./events-client.ts";
import { ActivityDrawer } from "./ActivityDrawer.tsx";
import { isStrip, PANES, type PaneName } from "./layout.ts";
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
import { PreviewPane } from "./PreviewPane.tsx";
import type { ComposeKind } from "./SessionForms.tsx";
import { useLoaded } from "./remote.ts";
import { SessionsPane } from "./SessionsPane.tsx";
import { SettingsPane } from "./SettingsPane.tsx";
import { applyPalette, clearPalette, paletteFor } from "./theme.ts";
import { revisionsOf, runningJob, sortedSessions, type UiState } from "./state.ts";
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

/** View state and the action runner, shared by the main layout and a pane route. */
function useAppState(state: UiState, initial: string | undefined) {
    // The daemon never sends which session or job the operator looks at.
    const [picked, setPicked] = useState<string | undefined>(initial);
    const [watched, setWatched] = useState<string | undefined>(undefined);
    const [actionError, setActionError] = useState<string | null>(null);
    // The `new` or `adopt` form shown by the middle pane; it closes when the session exists.
    const [compose, setCompose] = useState<ComposeKind | undefined>(undefined);

    const sessions = sortedSessions(state);
    const selected = picked !== undefined && picked in state.sessions ? picked : sessions[0]?.[0];
    const view = selected === undefined ? undefined : state.sessions[selected];
    const feed = selected === undefined ? [] : state.feed.filter((l) => l.session === selected);
    const busy = selected !== undefined && runningJob(state, selected) !== undefined;
    const job = watched === undefined ? undefined : state.jobs[watched];

    // A finished `new` or `adopt` names its session; show it.
    useEffect(() => {
        const created = job?.state === "ok" && (job.action === "new" || job.action === "adopt");
        if (created && job.session !== null) {
            setPicked(job.session);
            setCompose(undefined);
        }
    }, [job?.state, job?.action, job?.session]);

    const run = (path: string, body?: unknown): Promise<void> => {
        setActionError(null);
        return postAction(path, body).then(
            (accepted) => setWatched(accepted.id),
            (failure: unknown) => setActionError(String(failure)),
        );
    };
    const dismiss = () => {
        setWatched(undefined);
        setActionError(null);
    };
    return {
        sessions, selected, view, feed, busy, run, job, actionError, dismiss, setPicked,
        setActionError, compose, setCompose,
    };
}

export function App() {
    const route = paneRouteOf(window.location.search);
    const state = useSpinner();
    const app = useAppState(state, route?.session);
    const { sessions, selected, view, feed, busy, run, setPicked } = app;
    const layout = useLayout();
    // The side panel shows the sessions or, from the gear at the bottom of the bar, settings.
    const [panelView, setPanelView] = useState<PanelView["id"]>("sessions");
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

    const restore = (pane: PaneName) => {
        const handle = popped.current[pane];
        if (handle !== undefined) {
            handle.dock();
        } else {
            layout.restore(pane);
        }
    };
    const inRoute = route !== undefined;
    const sessionsState = layout.layout.panes.sessions;
    const panelShown = !sessionsState.hidden && !sessionsState.popped;
    const togglePanel = () => {
        if (sessionsState.popped) {
            restore("sessions");
        } else if (sessionsState.hidden) {
            layout.restore("sessions");
        } else {
            layout.fold("sessions");
        }
    };
    // The bar: the active view's icon hides the panel; another view's icon shows it on that
    // view, opening the panel when it is hidden.
    const pickPanel = (view: PanelView["id"]) => {
        if (panelShown && view === panelView) {
            togglePanel();
            return;
        }
        setPanelView(view);
        if (!panelShown) {
            togglePanel();
        }
    };
    const sessionsPane = (
        <SessionsPane
            sessions={sessions}
            usage={state.usage}
            selected={selected}
            onSelect={setPicked}
            run={run}
            onCompose={app.setCompose}
            controls={inRoute ? undefined : []}
        />
    );
    const agentsPane = (
        <AgentsPane
            view={view}
            busy={busy}
            run={run}
            transcripts={transcriptsFor(selected, state.transcripts)}
            usage={state.usage}
            revisions={revisionsOf(state, selected)}
            controls={inRoute ? undefined : []}
            compose={
                app.compose === undefined
                    ? undefined
                    : { kind: app.compose, onCancel: () => app.setCompose(undefined) }
            }
        >
            {drawer}
        </AgentsPane>
    );
    const previewsPane = (
        <PreviewPane
            view={view}
            busy={busy}
            run={run}
            controls={
                inRoute
                    ? undefined
                    : {
                          onToggle: () => layout.fold("previews"),
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
            onChange={async (next) => {
                await putSettings(next);
            }}
            controls={inRoute ? undefined : []}
        />
    );
    const sidePanel = panelView === "settings" ? settingsPane : sessionsPane;
    const panes = { sessions: sidePanel, agents: agentsPane, previews: previewsPane };
    const status = <footer className="status">daemon: {state.connection}</footer>;

    if (route !== undefined) {
        return (
            <div className="layout layout-single" data-pane={route.pane}>
                {panes[route.pane]}
                {route.pane !== "agents" && drawer}
                {status}
            </div>
        );
    }

    const slot = (pane: PaneName) =>
        isStrip(layout.layout.panes[pane]) ? (
            <PaneStrip
                name={pane}
                popped={layout.layout.panes[pane].popped}
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
    const agentsOff = expanded || isStrip(layout.layout.panes.agents);
    return (
        <div className={expanded ? "shell shell-expanded" : "shell"}>
            <ContextBar view={view} usage={state.usage} />
            <div className="shell-body">
                <ActivityBar
                    shown={panelShown ? panelView : undefined}
                    popped={sessionsState.popped}
                    onPick={pickPanel}
                />
                <div
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
