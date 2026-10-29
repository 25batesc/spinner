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
    daemon: DesktopDaemon;
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
    /** Main process to renderer: the load state of a view. Returns the unsubscribe function. */
    subscribe(listener: (event: PreviewEvent) => void): () => void;
}

export type PreviewEvent =
    | { key: PreviewKey; type: "loading"; url: string }
    | { key: PreviewKey; type: "ready"; url: string; title: string }
    | { key: PreviewKey; type: "failed"; url: string; error: string };

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
