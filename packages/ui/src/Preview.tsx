// The only component that knows how a preview is shown, and the only file that talks to the
// desktop bridge (`window.spinnerDesktop`, typed in `@spinner/protocol`'s `desktop-bridge.ts`).
// In a browser it is an iframe. In the desktop app the preview is a native top-level view that
// the main process positions over an empty box rendered here; this file measures the box and
// sends the rectangle. Nothing else in the UI changes.
import { useEffect, useRef } from "react";

import type {
    PaneName,
    PoppedPane,
    PreviewKey,
    PreviewRect,
    SpinnerDesktop,
} from "@spinner/protocol";

export interface PreviewProps {
    /** `<session dir>/<service name>` from `preview_key`: the desktop keeps one view per key. */
    previewKey: PreviewKey;
    url: string;
    title: string;
    /** Incremented by the reload button; the iframe remounts, the bridge reloads its view. */
    reloads: number;
    /** The service's `preview: top-level` flag: its login lives in cookies, a frame logs it out. */
    topLevel: boolean;
}

/** Rounds a DOM rectangle to the integer CSS pixels a native view can be placed at. */
export function previewRect(rect: {
    left: number;
    top: number;
    width: number;
    height: number;
}): PreviewRect {
    return {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
    };
}

/** What a pane pop-out needs: the route for a browser window, the preview key for the bridge. */
export interface PopOutRequest {
    pane: PaneName;
    session: string | undefined;
    /** The preview the previews pane shows, if any; the desktop app pops out that view. */
    preview?: { key: PreviewKey; url: string } | undefined;
}

/** A popped-out pane. `dock` closes its window; `onDocked` fires once, for either close path. */
export interface PoppedOut {
    dock(): void;
}

/** The URL that renders one pane alone, with the same data flow as the main window. */
export function paneRoute(pane: PopOutRequest["pane"], session: string | undefined): string {
    const params = new URLSearchParams({ pane });
    if (session !== undefined) {
        params.set("session", session);
    }
    return `${window.location.pathname}?${params.toString()}`;
}

const POPUP_FEATURES = "popup,width=720,height=800";
/** How often the main window checks whether the operator closed a popped-out window. */
const CLOSED_POLL_MS = 500;

/**
 * The browser path: `window.open` of the `?pane=` route. A same-origin popup has no close
 * event, so a poll notices the close and reports it once.
 */
function popOutInBrowser(request: PopOutRequest, onDocked: () => void): PoppedOut | string {
    // A unique name: reusing a window this document did not open would make `close` a no-op.
    const name = `spinner-${request.pane}-${Date.now()}`;
    const popup = window.open(paneRoute(request.pane, request.session), name, POPUP_FEATURES);
    if (popup === null) {
        return "The browser blocked the pop-out window; allow popups for this site.";
    }
    let done = false;
    const settle = () => {
        if (!done) {
            done = true;
            clearInterval(timer);
            onDocked();
        }
    };
    const timer = setInterval(() => {
        if (popup.closed) {
            settle();
        }
    }, CLOSED_POLL_MS);
    return {
        dock: () => {
            popup.close();
            settle();
        },
    };
}

/** One `pane.docked` listener per pop-out: it fires once for `dockBack` or the close button. */
function watchDocked(
    bridge: SpinnerDesktop,
    popped: PoppedPane,
    dockBack: () => Promise<void>,
    onDocked: () => void,
): PoppedOut {
    let done = false;
    const unsubscribe = bridge.panes.subscribe((event) => {
        const same = event.pane === popped.pane && event.session === popped.session;
        if (same && event.key === popped.key && !done) {
            done = true;
            unsubscribe();
            onDocked();
        }
    });
    return { dock: () => void dockBack() };
}

/**
 * The desktop path. The previews pane pops out the view of the tab on show: the window adopts
 * the existing `WebContentsView`, no reload (contract: `previews.popOut`). The other panes
 * open a `BrowserWindow` on the `?pane=` route (`panes.popOut`).
 */
function popOutInDesktop(
    bridge: SpinnerDesktop,
    request: PopOutRequest,
    onDocked: () => void,
): PoppedOut | string {
    if (request.session === undefined) {
        return "Select a session before popping a pane out.";
    }
    const session = request.session;
    if (request.pane === "previews") {
        const key = request.preview?.key;
        if (key === undefined) {
            return "No live preview to pop out.";
        }
        void bridge.previews.popOut(key);
        const popped = { pane: "previews" as const, session, key };
        return watchDocked(bridge, popped, () => bridge.previews.dockBack(key), onDocked);
    }
    void bridge.panes.popOut(request.pane, session);
    const popped = { pane: request.pane, session };
    const dockBack = () => bridge.panes.dockBack(request.pane, session);
    return watchDocked(bridge, popped, dockBack, onDocked);
}

/**
 * Opens a pane in its own window. Returns the handle, or the reason it could not, as a
 * sentence for the operator.
 */
export function popOutPane(request: PopOutRequest, onDocked: () => void): PoppedOut | string {
    const bridge = window.spinnerDesktop;
    if (bridge !== undefined) {
        return popOutInDesktop(bridge, request, onDocked);
    }
    return popOutInBrowser(request, onDocked);
}

/**
 * The windows already popped out when this page loaded: a reloaded main window in the desktop
 * app shows their strips again. `adopt` is called once per window with an `attach` that takes
 * the page's docked callback and returns the handle. A browser has nothing to resume.
 */
export function resumePoppedOut(
    adopt: (pane: PaneName, attach: (onDocked: () => void) => PoppedOut) => void,
): void {
    const bridge = window.spinnerDesktop;
    if (bridge === undefined) {
        return;
    }
    void bridge.panes.list().then((popped) => {
        for (const entry of popped) {
            const key = entry.key;
            const dockBack =
                key === undefined
                    ? () => bridge.panes.dockBack(entry.pane, entry.session)
                    : () => bridge.previews.dockBack(key);
            adopt(entry.pane, (onDocked) => watchDocked(bridge, entry, dockBack, onDocked));
        }
    });
}

function sameRect(a: PreviewRect | null, b: PreviewRect): boolean {
    return a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * The bridge path: an empty box whose rectangle follows the pane. The box resizes on a window
 * resize and on a drag of the preview pane's handle (the pane is pinned to the window's right
 * edge, so the other handle does not move it); `ResizeObserver` reports both. Scrolling any
 * ancestor moves the box without resizing it, so scroll is observed in the capture phase.
 * `set` shows the view (contract rule 1); `hide` on unmount keeps its page alive for the next
 * tab switch (rule 2).
 */
function BridgePreview({
    bridge,
    previewKey,
    url,
    reloads,
}: Pick<PreviewProps, "previewKey" | "url" | "reloads"> & { bridge: SpinnerDesktop }) {
    const box = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const element = box.current;
        if (element === null) {
            return;
        }
        let last: PreviewRect | null = null;
        let frame = 0;
        const measure = () => {
            frame = 0;
            const rect = previewRect(element.getBoundingClientRect());
            if (sameRect(last, rect)) {
                return;
            }
            last = rect;
            void bridge.previews.set(previewKey, url, rect);
        };
        // Many events arrive per frame during a drag; one measurement per frame is enough.
        const schedule = () => {
            if (frame === 0) {
                frame = requestAnimationFrame(measure);
            }
        };
        measure();
        const observer = new ResizeObserver(schedule);
        observer.observe(element);
        window.addEventListener("resize", schedule);
        document.addEventListener("scroll", schedule, true);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", schedule);
            document.removeEventListener("scroll", schedule, true);
            if (frame !== 0) {
                cancelAnimationFrame(frame);
            }
            void bridge.previews.hide(previewKey);
        };
    }, [bridge, previewKey, url]);

    // The counter is pane state shared by all tabs, so a tab mounted after a reload click sees a
    // count above zero; only a change after mount is a reload of this view.
    const seen = useRef(reloads);
    useEffect(() => {
        if (reloads !== seen.current) {
            seen.current = reloads;
            void bridge.previews.reload(previewKey);
        }
    }, [bridge, previewKey, reloads]);

    return (
        <>
            <div className="preview-bar">
                <button onClick={() => void bridge.previews.openExternal(previewKey)}>
                    open in browser
                </button>
                <button onClick={() => void bridge.previews.devtools(previewKey)}>devtools</button>
            </div>
            <div ref={box} className="preview-frame preview-box" data-preview={previewKey} />
        </>
    );
}

function TopLevelNote({ url }: Pick<PreviewProps, "url">) {
    return (
        <p className="preview-note">
            This app keeps its login in cookies and needs a top-level page; inside this frame it
            logs out again. <a href={url} target="_blank" rel="noreferrer">Open it in a tab</a>{" "}
            or use the desktop app. The frame below is for a look only.
        </p>
    );
}

export function Preview({ previewKey, url, title, reloads, topLevel }: PreviewProps) {
    const bridge = window.spinnerDesktop;
    if (bridge !== undefined) {
        return (
            <BridgePreview bridge={bridge} previewKey={previewKey} url={url} reloads={reloads} />
        );
    }
    return (
        <>
            {topLevel && <TopLevelNote url={url} />}
            <iframe className="preview-frame" key={reloads} src={url} title={title} />
        </>
    );
}
