// The Electron `PreviewHost`: one `WebContentsView` per key, a child of the main window's
// content view. A failed load renders the error inside the view with a retry link, so the
// app stays usable; the renderer only gets the `failed` event. Links a page opens in a new
// window go to the default browser. Previews share the default session on purpose
// (MISSION Contracts): cookies behave like tabs of one browser.
import assert from "node:assert/strict";
import { shell, WebContentsView, type BrowserWindow } from "electron";
import type { PreviewEvent, PreviewKey, PreviewRect } from "@spinner/protocol";
import { error_page } from "./pages.js";
import type { PreviewHost, PreviewView } from "./previews.js";

/** Chromium's `net::ERR_ABORTED`: a navigation the page itself replaced, not a failure. */
const ERR_ABORTED = -3;

export type PreviewEventSink = (event: PreviewEvent) => void;

export type DebugSink = (line: string) => void;

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

    constructor(
        private readonly window: BrowserWindow,
        private readonly key: PreviewKey,
        private readonly sink: PreviewEventSink,
        private readonly debug: DebugSink,
    ) {
        this.view = new WebContentsView({
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
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

    destroy(): void {
        assert.equal(this.destroyed, false);
        this.destroyed = true;
        if (!this.window.isDestroyed()) {
            this.window.contentView.removeChildView(this.view);
        }
        this.view.webContents.close();
    }
}

export function data_url(html: string): string {
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
