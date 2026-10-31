// The Electron `PreviewHost`: one `WebContentsView` per key, a child of the main window's
// content view. A failed load renders the error inside the view with a retry link, so the
// app stays usable; the renderer only gets the `failed` event. Links a page opens in a new
// window go to the default browser. Each view takes the Electron session of its Spinner
// session (`preview_partition`): the services of one session share one cookie jar, like
// tabs of one browser, and two sessions of one app hold two logins. A pop-out is a
// `BaseWindow` that adopts the same view: the page never reloads and the partition goes with
// the view, so its login stays.
import assert from "node:assert/strict";
import { BaseWindow, session, shell, WebContentsView, type BrowserWindow } from "electron";
import type {
    FindResult,
    PreviewEvent,
    PreviewKey,
    PreviewNavigation,
    PreviewRect,
} from "@spinner/protocol";
import { error_page } from "./pages.js";
import { preview_partition, type PreviewHost, type PreviewView } from "./previews.js";

/** Chromium's `net::ERR_ABORTED`: a navigation the page itself replaced, not a failure. */
const ERR_ABORTED = -3;
/** A `findInPage` whose final result never comes (the page went away) resolves with zeros. */
export const FIND_TIMEOUT_MS = 2000;

export type PreviewEventSink = (event: PreviewEvent) => void;

export type DebugSink = (line: string) => void;

/** A pop-out opens this far right and down from the main window, like a cascaded document. */
export const POPOUT_CASCADE_PX = 40;
/** A pop-out keeps the pane's size, but never less than this; a tiny pane is not a window. */
export const POPOUT_MIN = { width: 480, height: 360 };

/** The size of a pop-out from the pane's rectangle in the main window. */
export function popout_size(pane: { width: number; height: number }): {
    width: number;
    height: number;
} {
    return {
        width: Math.max(POPOUT_MIN.width, Math.round(pane.width)),
        height: Math.max(POPOUT_MIN.height, Math.round(pane.height)),
    };
}

export function electron_preview_host(
    window: BrowserWindow,
    sink: PreviewEventSink,
    debug: DebugSink = () => undefined,
): PreviewHost {
    return {
        create(key: PreviewKey): PreviewView {
            return new ElectronPreviewView(window, key, sink, debug);
        },
    };
}

class ElectronPreviewView implements PreviewView {
    private readonly view: WebContentsView;
    private destroyed = false;
    /** The URL of the last `load`, for the error page's retry link and the events. */
    private url = "";
    /** The window the view lives in while popped out; null while docked. */
    private popout: BaseWindow | null = null;

    constructor(
        private readonly window: BrowserWindow,
        private readonly key: PreviewKey,
        private readonly sink: PreviewEventSink,
        private readonly debug: DebugSink,
    ) {
        this.view = new WebContentsView({
            webPreferences: {
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                session: session.fromPartition(preview_partition(key)),
            },
        });
        this.view.setVisible(false);
        window.contentView.addChildView(this.view);
        const contents = this.view.webContents;
        contents.setWindowOpenHandler(({ url }) => {
            void shell.openExternal(url);
            return { action: "deny" };
        });
        contents.on("did-start-loading", () => {
            this.sink({ key: this.key, type: "loading", url: contents.getURL() || this.url });
        });
        contents.on("did-finish-load", () => {
            const url = contents.getURL();
            if (!url.startsWith("data:")) {
                this.sink({ key: this.key, type: "ready", url, title: contents.getTitle() });
            }
        });
        contents.on("page-title-updated", (_event, title) => {
            this.popout?.setTitle(popout_title(this.key, title));
        });
        // The browser bar's five triggers; each sends the whole state, so a listener needs
        // no memory of the previous one.
        const navigated = () => {
            this.sink({ key: this.key, type: "navigated", ...this.navigation() });
        };
        contents.on("did-navigate", navigated);
        contents.on("did-navigate-in-page", navigated);
        contents.on("page-title-updated", navigated);
        contents.on("did-start-loading", navigated);
        contents.on("did-stop-loading", navigated);
        contents.on("did-fail-load", (_event, code, description, failed_url, is_main_frame) => {
            if (!is_main_frame || code === ERR_ABORTED) {
                return;
            }
            const error = `${description} (${code})`;
            this.sink({ key: this.key, type: "failed", url: failed_url, error });
            void contents.loadURL(data_url(error_page(failed_url, error)));
        });
    }

    load(url: string): void {
        assert.equal(this.destroyed, false);
        this.url = url;
        // Rejections surface as `did-fail-load`; the promise itself is not the signal.
        this.view.webContents.loadURL(url).catch(() => undefined);
    }

    set_bounds(rect: PreviewRect): void {
        assert.equal(this.destroyed, false);
        this.view.setBounds(rect);
        this.debug(`bounds ${this.key} ${JSON.stringify(this.view.getBounds())}`);
    }

    set_visible(visible: boolean): void {
        assert.equal(this.destroyed, false);
        this.view.setVisible(visible);
    }

    reload(): void {
        assert.equal(this.destroyed, false);
        const current = this.view.webContents.getURL();
        // Reloading the error page would show the same error; go back to the real URL.
        if (current.startsWith("data:")) {
            this.load(this.url);
        } else {
            this.view.webContents.reload();
        }
    }

    open_devtools(): void {
        assert.equal(this.destroyed, false);
        this.view.webContents.openDevTools({ mode: "detach" });
    }

    current_url(): string {
        const current = this.view.webContents.getURL();
        return current.startsWith("data:") ? this.url : current;
    }

    /** What a browser bar shows now. The error page reports the URL that failed. */
    navigation(): PreviewNavigation {
        const contents = this.view.webContents;
        return {
            url: this.current_url(),
            title: contents.getURL().startsWith("data:") ? "" : contents.getTitle(),
            canGoBack: contents.navigationHistory.canGoBack(),
            canGoForward: contents.navigationHistory.canGoForward(),
            loading: contents.isLoading(),
        };
    }

    go_back(): void {
        assert.equal(this.destroyed, false);
        const history = this.view.webContents.navigationHistory;
        if (history.canGoBack()) {
            history.goBack();
        }
    }

    go_forward(): void {
        assert.equal(this.destroyed, false);
        const history = this.view.webContents.navigationHistory;
        if (history.canGoForward()) {
            history.goForward();
        }
    }

    zoom_level(): number {
        return this.view.webContents.getZoomLevel();
    }

    set_zoom_level(level: number): void {
        assert.equal(this.destroyed, false);
        this.view.webContents.setZoomLevel(level);
    }

    find(text: string, next: boolean): Promise<FindResult> {
        assert.equal(this.destroyed, false);
        assert.ok(text !== "", "find needs text");
        const contents = this.view.webContents;
        return new Promise((resolve) => {
            let settled = false;
            const finish = (result: FindResult) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    contents.removeListener("found-in-page", on_found);
                    resolve(result);
                }
            };
            const on_found = (_event: unknown, result: Electron.Result) => {
                if (result.requestId === request && result.finalUpdate) {
                    finish({ matches: result.matches, active: result.activeMatchOrdinal });
                }
            };
            const timer = setTimeout(() => finish({ matches: 0, active: 0 }), FIND_TIMEOUT_MS);
            contents.on("found-in-page", on_found);
            const request = contents.findInPage(text, { findNext: next });
        });
    }

    stop_find(): void {
        assert.equal(this.destroyed, false);
        this.view.webContents.stopFindInPage("clearSelection");
    }

    async clear_storage(): Promise<void> {
        assert.equal(this.destroyed, false);
        const origin = new URL(this.current_url()).origin;
        assert.ok(origin.startsWith("http"), `clear storage needs an http origin, got ${origin}`);
        await this.view.webContents.session.clearStorageData({ origin });
        this.debug(`cleared storage of ${origin} for ${this.key}`);
        this.reload();
    }

    pop_out(on_closed: () => void): void {
        assert.equal(this.destroyed, false);
        if (this.popout !== null) {
            this.popout.focus();
            return;
        }
        const main = this.window.getBounds();
        const popout = new BaseWindow({
            ...popout_size(this.view.getBounds()),
            // The size is the page's, not the frame's: the pane's pixels stay the pane's.
            useContentSize: true,
            x: main.x + POPOUT_CASCADE_PX,
            y: main.y + POPOUT_CASCADE_PX,
            title: popout_title(this.key, this.view.webContents.getTitle()),
        });
        this.popout = popout;
        this.window.contentView.removeChildView(this.view);
        popout.contentView.addChildView(this.view);
        const fit = () => {
            const { width, height } = popout.getContentBounds();
            this.view.setBounds({ x: 0, y: 0, width, height });
        };
        fit();
        popout.on("resize", fit);
        this.view.setVisible(true);
        this.debug(`pop out ${this.key} ${JSON.stringify(popout.getBounds())}`);
        // The close button: adopt the view back while the window still exists, then report.
        // `dock_back` closes the window too, but clears `popout` first so this does nothing.
        popout.on("close", () => {
            if (this.popout === popout) {
                this.popout = null;
                this.adopt_back(popout);
                on_closed();
            }
        });
    }

    dock_back(): void {
        assert.equal(this.destroyed, false);
        const popout = this.popout;
        if (popout === null) {
            return;
        }
        this.popout = null;
        this.adopt_back(popout);
        popout.close();
    }

    /** Moves the view from `popout` back under the main window, hidden until the next `set`. */
    private adopt_back(popout: BaseWindow): void {
        popout.contentView.removeChildView(this.view);
        this.view.setVisible(false);
        if (!this.window.isDestroyed()) {
            this.window.contentView.addChildView(this.view);
        }
        this.debug(`dock back ${this.key}`);
    }

    destroy(): void {
        assert.equal(this.destroyed, false);
        this.destroyed = true;
        const popout = this.popout;
        if (popout !== null) {
            this.popout = null;
            popout.contentView.removeChildView(this.view);
            popout.close();
        } else if (!this.window.isDestroyed()) {
            this.window.contentView.removeChildView(this.view);
        }
        this.view.webContents.close();
    }
}

export function popout_title(key: PreviewKey, page_title: string): string {
    return page_title === "" ? key : `${key} — ${page_title}`;
}

export function data_url(html: string): string {
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
