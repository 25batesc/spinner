// The bridge between the web UI and the desktop shell. The desktop app's preload puts a
// `SpinnerDesktop` on `window.spinnerDesktop`; in a browser the property is absent and the UI
// embeds an iframe. `Preview.tsx` is the only file in the UI that reads it. This file holds
// types and two helpers, no runtime dependency, so both packages can import it.

import type { BuildInfo } from "./api.js";

/** Property name of the bridge on `window`. The preload and the UI agree on it here. */
export const DESKTOP_BRIDGE_NAME = "spinnerDesktop";

declare global {
    interface Window {
        spinnerDesktop?: SpinnerDesktop;
    }
}

export interface SpinnerDesktop {
    previews: DesktopPreviews;
    panes: DesktopPanes;
    daemon: DesktopDaemon;
    /** Absent in a desktop build older than #12; the UI checks before it subscribes. */
    sessions?: DesktopSessions;
    /** Absent in a desktop build older than v0.20.1; the UI checks before a drop. */
    files?: DesktopFiles;
}

export interface DesktopFiles {
    /**
     * The path on disk of a file the operator dropped on the page (Electron's
     * `webUtils.getPathForFile`). A web page cannot read it alone, so a drop on the terminal
     * works in the desktop app only; the path is pasted into the pty as iTerm would do.
     */
    pathOf(file: File): string;
}

export interface DesktopSessions {
    /**
     * Main process to renderer: a click on a Spinner notification asks the main window to show
     * this session directory, for example `s046-session-workspace`. Returns the unsubscribe
     * function.
     */
    subscribeFocus(listener: (session: string) => void): () => void;
}

/** `<session dir>/<service name>`, for example `s006-refunds/admin`. One view per key. */
export type PreviewKey = string;

export function preview_key(session_dir: string, service: string): PreviewKey {
    return `${session_dir}/${service}`;
}

/** The session directory of a key, for the views that go when a session closes. */
export function preview_key_session(key: PreviewKey): string {
    const slash = key.indexOf("/");
    return slash === -1 ? key : key.slice(0, slash);
}

/** CSS pixels relative to the page viewport, as `getBoundingClientRect()` gives them. Zoom 1. */
export interface PreviewRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface DesktopPreviews {
    /**
     * Create the view on demand, load `url` when it differs from the last `set`, place it at
     * `rect`, and show it. Every other view is hidden: one preview shows at a time.
     */
    set(key: PreviewKey, url: string, rect: PreviewRect): Promise<void>;
    show(key: PreviewKey): Promise<void>;
    /** Keeps the page alive, so its state survives; call on unmount and on tab switch. */
    hide(key: PreviewKey): Promise<void>;
    reload(key: PreviewKey): Promise<void>;
    /** Opens the view's current URL in the default browser. */
    openExternal(key: PreviewKey): Promise<void>;
    devtools(key: PreviewKey): Promise<void>;
    /**
     * Moves the view into its own native window, no reload: the page and its cookies stay.
     * While the key is popped out, `set` only updates the URL, and `show` and `hide` are
     * ignored, so the main window's pane may keep rendering its box or stop; both are safe.
     * A second call focuses the window. The view must exist (`set` was called once).
     */
    popOut(key: PreviewKey): Promise<void>;
    /**
     * Moves the view back into the main window, hidden, and closes its window. The next
     * `set` from the pane places and shows it. A `pane.docked` event follows, the same one
     * the window's close button sends; a listener treats both alike.
     */
    dockBack(key: PreviewKey): Promise<void>;
    /**
     * The browser bar. Navigation stays inside the view: `navigate` loads an http(s) URL in
     * it, `back` and `forward` walk its history. A `target=_blank` link still goes to the
     * external browser. None of these change the pane's `set` URL: a later `set` with the
     * same URL only moves the view, as after a click inside the page.
     */
    navigate(key: PreviewKey, url: string): Promise<void>;
    back(key: PreviewKey): Promise<void>;
    forward(key: PreviewKey): Promise<void>;
    /**
     * One Chromium zoom level per step (20 %), `reset` is 100 %. Chromium keeps zoom per
     * origin, so the views of one host share it.
     */
    zoom(key: PreviewKey, direction: ZoomDirection): Promise<void>;
    /**
     * `findInPage(text)`; the same text again finds the next match. Resolves with the final
     * count for that search, or null when `text` is null (which clears the search and the
     * selection) or the view does not exist.
     */
    find(key: PreviewKey, text: string | null): Promise<FindResult | null>;
    /**
     * Clears the storage (cookies, local storage, caches, the rest) of the view's current
     * origin only, then reloads the view. The renderer confirms with the user before calling.
     */
    clearStorage(key: PreviewKey): Promise<void>;
    /**
     * Main process to renderer: the load state of a view and, as `navigated`, what a
     * browser bar shows. Returns the unsubscribe function.
     */
    subscribe(listener: (event: PreviewEvent) => void): () => void;
}

export type ZoomDirection = "in" | "out" | "reset";

export interface FindResult {
    matches: number;
    /** 1-based index of the selected match; 0 when there is none. */
    active: number;
}

/** What a browser bar shows for a view; `navigated` carries one per change. */
export interface PreviewNavigation {
    url: string;
    title: string;
    canGoBack: boolean;
    canGoForward: boolean;
    loading: boolean;
}

export type PreviewEvent =
    | { key: PreviewKey; type: "loading"; url: string }
    | { key: PreviewKey; type: "ready"; url: string; title: string }
    | { key: PreviewKey; type: "failed"; url: string; error: string }
    /**
     * On `did-navigate`, `did-navigate-in-page`, `page-title-updated`, `did-start-loading`
     * and `did-stop-loading`. The error page a failed load shows reports the failed URL.
     */
    | ({ key: PreviewKey; type: "navigated" } & PreviewNavigation);

/** The three panes of the workbench. `previews` pops out per key through `DesktopPreviews`. */
export type PaneName = "sessions" | "agents" | "previews";

/** One popped-out window. `key` is set for a preview, absent for a pane page. */
export interface PoppedPane {
    pane: PaneName;
    /** The session directory, for example `s006-refunds`. */
    session: string;
    key?: PreviewKey;
}

export interface DesktopPanes {
    /**
     * Opens a `BrowserWindow` on the UI's `?pane=<pane>&session=<session>` route, with the
     * bridge preloaded, so the page there can call `dockBack` itself. One window per
     * `(pane, session)`; a second call focuses it. `pane` is `sessions` or `agents`: for the
     * previews pane call `previews.popOut(key)` with the selected tab's key instead.
     */
    popOut(pane: PaneName, session: string): Promise<void>;
    /** Closes the window of `(pane, session)`. A `pane.docked` event follows. No-op if absent. */
    dockBack(pane: PaneName, session: string): Promise<void>;
    /** Every popped-out window, previews included, so a reloaded renderer can catch up. */
    list(): Promise<PoppedPane[]>;
    /**
     * Main process to renderer: a pop-out ended, by `dockBack`, by the window's close button,
     * or by the session closing. The main window's page restores the pane in place. Returns
     * the unsubscribe function.
     */
    subscribe(listener: (event: PaneEvent) => void): () => void;
}

export type PaneEvent = { type: "docked" } & PoppedPane;

export interface DesktopDaemon {
    status(): Promise<DaemonStatus>;
    subscribe(listener: (status: DaemonStatus) => void): () => void;
}

export type DaemonState = "connected" | "starting" | "down";

export interface DaemonStatus {
    url: string;
    state: DaemonState;
    /** From `/health` while connected, else null. */
    build: BuildInfo | null;
}
