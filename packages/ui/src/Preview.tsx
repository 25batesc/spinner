// The only component that knows how a preview is shown, and the only file that talks to the
// desktop bridge (`window.spinnerDesktop`, typed in `@spinner/protocol`'s `desktop-bridge.ts`).
// In a browser it is an iframe. In the desktop app the preview is a native top-level view that
// the main process positions over an empty box rendered here; this file measures the box and
// sends the rectangle. Nothing else in the UI changes.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import type {
    FindResult,
    PaneName,
    PoppedPane,
    PreviewKey,
    PreviewNavigation,
    PreviewRect,
    SpinnerDesktop,
    ZoomDirection,
} from "@spinner/protocol";

import { Icon, IconButton } from "./PaneHead.tsx";

export interface PreviewProps {
    /** `<session dir>/<service name>` from `preview_key`: the desktop keeps one view per key. */
    previewKey: PreviewKey;
    url: string;
    title: string;
    /** The service's `preview: top-level` flag: its login lives in cookies, a frame logs it out. */
    topLevel: boolean;
    /**
     * Give the frame the keyboard focus when it mounts, so a page with its own keys (the diff
     * viewer's `j`, `k`, `[`, `]`) gets them without a click. Browser path only: a native view
     * takes focus on its own.
     */
    focus?: boolean | undefined;
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

/** What the browser bar can do; the parts a path cannot offer are left out and not drawn. */
export interface BrowserBarProps {
    nav: PreviewNavigation;
    onNavigate: (url: string) => void;
    onReload: () => void;
    onOpenExternal: () => void;
    onBack?: (() => void) | undefined;
    onForward?: (() => void) | undefined;
    onDevtools?: (() => void) | undefined;
    /** The ellipsis menu: zoom, find in page, clear storage. Desktop only. */
    menu?:
        | {
              onZoom: (direction: ZoomDirection) => void;
              onFind: (text: string | null) => Promise<FindResult | null>;
              onClearStorage: () => void;
          }
        | undefined;
}

/** The inline find field: Enter finds (the same text again: the next match), Escape clears. */
function FindField({
    onFind,
    onClose,
}: {
    onFind: (text: string | null) => Promise<FindResult | null>;
    onClose: () => void;
}) {
    const [text, setText] = useState("");
    const [result, setResult] = useState<FindResult | null>(null);
    const close = () => {
        void onFind(null);
        onClose();
    };
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (text !== "") {
            void onFind(text).then(setResult);
        }
    };
    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Escape") {
            close();
        }
    };
    return (
        <form className="find-field" onSubmit={submit} aria-label="Find in page">
            <input
                autoFocus
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Find in page"
                aria-label="Find text"
            />
            <span className="find-count muted">
                {result === null ? "" : `${result.active}/${result.matches}`}
            </span>
            <IconButton icon="close" label="Close find" onClick={close} />
        </form>
    );
}

/** The ellipsis menu of the browser bar. */
function BrowserMenu({
    menu,
    onFind,
}: {
    menu: NonNullable<BrowserBarProps["menu"]>;
    onFind: () => void;
}) {
    const [open, setOpen] = useState(false);
    const pick = (action: () => void) => () => {
        setOpen(false);
        action();
    };
    const clear = () => {
        if (window.confirm("Clear this app's cookies and storage? The page reloads.")) {
            menu.onClearStorage();
        }
    };
    const items: [string, () => void][] = [
        ["Zoom in", () => menu.onZoom("in")],
        ["Zoom out", () => menu.onZoom("out")],
        ["Reset zoom", () => menu.onZoom("reset")],
        ["Find in page", onFind],
        ["Clear this app's storage", clear],
    ];
    return (
        <span className="browser-menu">
            <IconButton icon="more" label="More" active={open} onClick={() => setOpen(!open)} />
            {open && (
                <div className="menu" role="menu">
                    {items.map(([label, action]) => (
                        <button key={label} role="menuitem" onClick={pick(action)}>
                            {label}
                        </button>
                    ))}
                </div>
            )}
        </span>
    );
}

/**
 * The browser bar above the preview content: back, forward, reload, the URL field (Enter
 * navigates; the page title is its tooltip), open in the external browser, devtools, and the
 * ellipsis menu. A path that cannot do a thing passes no handler and the button is not drawn;
 * back and forward are drawn disabled so the bar keeps its shape.
 */
export function BrowserBar(props: BrowserBarProps) {
    const { nav, onNavigate, onReload, onOpenExternal, onBack, onForward, onDevtools } = props;
    const { menu } = props;
    const [draft, setDraft] = useState(nav.url);
    const [editing, setEditing] = useState(false);
    const [finding, setFinding] = useState(false);
    // The field follows the page while the operator is not typing in it.
    useEffect(() => {
        if (!editing) {
            setDraft(nav.url);
        }
    }, [nav.url, editing]);
    const submit = (event: FormEvent) => {
        event.preventDefault();
        const url = draft.trim();
        if (url !== "") {
            onNavigate(url);
        }
        setEditing(false);
    };
    return (
        <div className="browser-bar">
            <button
                type="button"
                className="icon-button"
                title="Back"
                aria-label="Back"
                disabled={onBack === undefined || !nav.canGoBack}
                onClick={onBack}
            >
                <Icon name="back" />
            </button>
            <button
                type="button"
                className="icon-button"
                title="Forward"
                aria-label="Forward"
                disabled={onForward === undefined || !nav.canGoForward}
                onClick={onForward}
            >
                <Icon name="forward" />
            </button>
            <IconButton icon="reload" label="Reload" onClick={onReload} />
            <form className="url-form" onSubmit={submit}>
                <input
                    className="url-field"
                    value={draft}
                    title={nav.title}
                    aria-label="Address"
                    spellCheck={false}
                    onFocus={() => setEditing(true)}
                    onBlur={() => setEditing(false)}
                    onChange={(event) => setDraft(event.target.value)}
                />
            </form>
            <IconButton icon="globe" label="Open in the browser" onClick={onOpenExternal} />
            {onDevtools !== undefined && (
                <IconButton icon="devtools" label="Developer tools" onClick={onDevtools} />
            )}
            {menu !== undefined && <BrowserMenu menu={menu} onFind={() => setFinding(true)} />}
            {menu !== undefined && finding && (
                <FindField onFind={menu.onFind} onClose={() => setFinding(false)} />
            )}
        </div>
    );
}

function initialNavigation(url: string): PreviewNavigation {
    return { url, title: "", canGoBack: false, canGoForward: false, loading: false };
}

/**
 * The bridge path: an empty box whose rectangle follows the pane. The box resizes on a window
 * resize and on a drag of the preview pane's handle (the pane is pinned to the window's right
 * edge, so the other handle does not move it); `ResizeObserver` reports both. Scrolling any
 * ancestor moves the box without resizing it, so scroll is observed in the capture phase.
 * `set` shows the view (contract rule 1); `hide` on unmount keeps its page alive for the next
 * tab switch (rule 2). The browser bar follows the view's `navigated` events.
 */
function BridgePreview({
    bridge,
    previewKey,
    url,
}: Pick<PreviewProps, "previewKey" | "url"> & { bridge: SpinnerDesktop }) {
    const box = useRef<HTMLDivElement>(null);
    const [nav, setNav] = useState(() => initialNavigation(url));

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

    useEffect(() => {
        setNav(initialNavigation(url));
        return bridge.previews.subscribe((event) => {
            if (event.key === previewKey && event.type === "navigated") {
                const { url: at, title, canGoBack, canGoForward, loading } = event;
                setNav({ url: at, title, canGoBack, canGoForward, loading });
            }
        });
    }, [bridge, previewKey, url]);

    const call = (method: (key: PreviewKey) => Promise<unknown>) => () => void method(previewKey);
    return (
        <>
            <BrowserBar
                nav={nav}
                onNavigate={(to) => void bridge.previews.navigate(previewKey, to)}
                onReload={call((key) => bridge.previews.reload(key))}
                onOpenExternal={call((key) => bridge.previews.openExternal(key))}
                onBack={call((key) => bridge.previews.back(key))}
                onForward={call((key) => bridge.previews.forward(key))}
                onDevtools={call((key) => bridge.previews.devtools(key))}
                menu={{
                    onZoom: (direction) => void bridge.previews.zoom(previewKey, direction),
                    onFind: (text) => bridge.previews.find(previewKey, text),
                    onClearStorage: call((key) => bridge.previews.clearStorage(key)),
                }}
            />
            <div ref={box} className="preview-frame preview-box" data-preview={previewKey} />
        </>
    );
}

/**
 * The iframe path. The bar's URL field starts at the URL Spinner set; Enter reloads the frame
 * at the typed URL. The frame's own history and title are out of reach across origins, so
 * back and forward stay disabled and the menu is absent.
 */
function FramePreview({ url, title, topLevel, focus }: Omit<PreviewProps, "previewKey">) {
    const [address, setAddress] = useState(url);
    const [reloads, setReloads] = useState(0);
    const frame = useRef<HTMLIFrameElement>(null);
    useEffect(() => setAddress(url), [url]);
    // The frame is keyed on the address, so a navigation mounts a new one and focuses it too.
    useEffect(() => {
        if (focus === true) {
            frame.current?.focus();
        }
    }, [focus, address, reloads]);
    return (
        <>
            <BrowserBar
                nav={initialNavigation(address)}
                onNavigate={(to) => {
                    setAddress(to);
                    setReloads((count) => count + 1);
                }}
                onReload={() => setReloads((count) => count + 1)}
                onOpenExternal={() => window.open(address, "_blank", "noreferrer")}
            />
            {topLevel && <TopLevelNote url={url} />}
            <iframe
                ref={frame}
                className="preview-frame"
                key={`${address}#${reloads}`}
                src={address}
                title={title}
            />
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

export function Preview({ previewKey, url, title, topLevel, focus }: PreviewProps) {
    const bridge = window.spinnerDesktop;
    if (bridge !== undefined) {
        return <BridgePreview bridge={bridge} previewKey={previewKey} url={url} />;
    }
    return <FramePreview url={url} title={title} topLevel={topLevel} focus={focus} />;
}
