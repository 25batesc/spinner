// The pane windows: a pane of the workbench (sessions, agents) popped out as its own
// `BrowserWindow` on the UI's `?pane=<pane>&session=<session>` route. One window per
// `(pane, session)`; the close button docks the pane back. This file is pure so Vitest can
// drive it: the registry takes a `PaneWindowHost` that opens windows; `main.ts` supplies the
// Electron one. A popped-out preview is not a pane window: `PreviewRegistry` owns it.
import assert from "node:assert/strict";
import type { PaneName, PoppedPane } from "@spinner/protocol";

/** What the registry needs from one `BrowserWindow`. */
export interface PaneWindow {
    focus(): void;
    close(): void;
}

export interface PaneWindowHost {
    /** Opens the window on `url`; `on_closed` fires when the user closes it. */
    open(pane: PoppedPane, url: string, on_closed: () => void): PaneWindow;
}

/**
 * The panes a page can show alone. The previews pane is one since 2026-11-06: its window
 * carries every tab of the session, and the views follow it (`PreviewRegistry.set`).
 */
export const PAGE_PANES: readonly PaneName[] = ["sessions", "agents", "previews"];

export function pane_url(daemon_url: string, pane: PaneName, session: string): string {
    const url = new URL(daemon_url);
    url.searchParams.set("pane", pane);
    url.searchParams.set("session", session);
    return url.toString();
}

export class PaneWindows {
    private readonly windows = new Map<string, PaneWindow>();

    constructor(
        private readonly host: PaneWindowHost,
        private readonly daemon_url: string,
    ) {}

    /** Opens or focuses the window; false when `pane` has no page of its own. */
    pop_out(pane: PaneName, session: string, on_closed: () => void): boolean {
        assert.equal(typeof session, "string");
        if (!PAGE_PANES.includes(pane)) {
            return false;
        }
        const id = pane_id(pane, session);
        const open = this.windows.get(id);
        if (open !== undefined) {
            open.focus();
            return true;
        }
        const popped: PoppedPane = { pane, session };
        const window = this.host.open(popped, pane_url(this.daemon_url, pane, session), () => {
            if (this.windows.get(id) === window) {
                this.windows.delete(id);
                on_closed();
            }
        });
        this.windows.set(id, window);
        return true;
    }

    /** Closes the window without the close callback; false when there is none. */
    dock_back(pane: PaneName, session: string): boolean {
        const id = pane_id(pane, session);
        const window = this.windows.get(id);
        if (window === undefined) {
            return false;
        }
        this.windows.delete(id);
        window.close();
        return true;
    }

    /** Closes the session's windows; the daemon's `session.closed` calls this. */
    close_session(session: string): PoppedPane[] {
        const closed = this.list().filter((popped) => popped.session === session);
        for (const popped of closed) {
            this.dock_back(popped.pane, popped.session);
        }
        return closed;
    }

    list(): PoppedPane[] {
        return [...this.windows.keys()].map(parse_pane_id);
    }
}

function pane_id(pane: PaneName, session: string): string {
    assert.equal(session.includes("/"), false, "a session dir has no slash");
    return `${pane}/${session}`;
}

function parse_pane_id(id: string): PoppedPane {
    const slash = id.indexOf("/");
    assert.ok(slash > 0);
    return { pane: id.slice(0, slash) as PaneName, session: id.slice(slash + 1) };
}
