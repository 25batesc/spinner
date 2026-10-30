// The preview registry: one view per preview key, created on demand, shown one at a time,
// hidden views kept alive so a page keeps its state, destroyed when the session closes. A
// popped-out view lives in its own window: the registry neither places nor hides it. This
// file is pure so Vitest can drive it: the registry takes a `PreviewHost` that makes views and
// calls their methods; `main.ts` supplies the Electron one.
import assert from "node:assert/strict";
import {
    preview_key_session,
    type FindResult,
    type PreviewKey,
    type PreviewRect,
    type ZoomDirection,
} from "@spinner/protocol";

/** What the registry needs from one `WebContentsView`. */
export interface PreviewView {
    load(url: string): void;
    set_bounds(rect: PreviewRect): void;
    set_visible(visible: boolean): void;
    reload(): void;
    open_devtools(): void;
    /** The URL the page is at now, after navigation inside it. */
    current_url(): string;
    /**
     * Moves the view into its own window; `on_closed` fires when the user closes that window,
     * after the view is back in the main window. A second call focuses the window.
     */
    pop_out(on_closed: () => void): void;
    /** Closes the window and puts the view back in the main window, hidden. */
    dock_back(): void;
    go_back(): void;
    go_forward(): void;
    zoom_level(): number;
    set_zoom_level(level: number): void;
    /** `next` repeats the last search from the current match. Resolves with the final count. */
    find(text: string, next: boolean): Promise<FindResult>;
    stop_find(): void;
    /** Clears the storage of the page's current origin, then reloads. */
    clear_storage(): Promise<void>;
    destroy(): void;
}

export interface PreviewHost {
    create(key: PreviewKey): PreviewView;
}

/** Hidden views above this count are destroyed, least recently shown first. */
export const VIEWS_MAX_DEFAULT = 32;

interface Entry {
    view: PreviewView;
    /** The URL of the last `set`, so a repeated `set` with the same URL only moves the view. */
    url: string;
    /** Shown in the main window. Never true while `popped`. */
    visible: boolean;
    popped: boolean;
    /** Monotonic tick of the last `set` or `show`, for eviction order. */
    shown_at: number;
    /** The text of the last `find`, so the same text again finds the next match. */
    finding: string | null;
}

/** One Chromium zoom level is 20 %; these bounds are 50 % to 300 %, like a browser's. */
export const ZOOM_LEVEL_MIN = -3.8;
export const ZOOM_LEVEL_MAX = 6;

/** The zoom level after one step from `current`. `reset` is 100 %. */
export function next_zoom_level(current: number, direction: ZoomDirection): number {
    assert.ok(Number.isFinite(current), "a zoom level is a number");
    if (direction === "reset") {
        return 0;
    }
    const step = direction === "in" ? 1 : -1;
    return Math.min(ZOOM_LEVEL_MAX, Math.max(ZOOM_LEVEL_MIN, current + step));
}

export class PreviewRegistry {
    private readonly entries = new Map<PreviewKey, Entry>();
    private tick = 0;

    constructor(
        private readonly host: PreviewHost,
        private readonly views_max = VIEWS_MAX_DEFAULT,
    ) {
        assert.ok(views_max >= 1, "the registry must hold at least one view");
    }

    /** Creates or reuses the view for `key`, loads `url` if it changed, places and shows it. */
    set(key: PreviewKey, url: string, rect: PreviewRect): void {
        assert_key(key);
        assert_url(url);
        const bounds = integer_rect(rect);
        let entry = this.entries.get(key);
        if (entry === undefined) {
            this.evict(key);
            entry = {
                view: this.host.create(key),
                url: "",
                visible: false,
                popped: false,
                shown_at: 0,
                finding: null,
            };
            this.entries.set(key, entry);
        }
        if (entry.url !== url) {
            entry.url = url;
            entry.view.load(url);
        }
        if (entry.popped) {
            return;
        }
        entry.view.set_bounds(bounds);
        this.show(key);
    }

    show(key: PreviewKey): void {
        const entry = this.entries.get(key);
        if (entry === undefined || entry.popped) {
            return;
        }
        this.tick += 1;
        entry.shown_at = this.tick;
        for (const [other_key, other] of this.entries) {
            if (other.popped) {
                continue;
            }
            const visible = other_key === key;
            if (other.visible !== visible) {
                other.visible = visible;
                other.view.set_visible(visible);
            }
        }
        assert.equal(entry.visible, true);
    }

    hide(key: PreviewKey): void {
        const entry = this.entries.get(key);
        if (entry === undefined || !entry.visible) {
            return;
        }
        entry.visible = false;
        entry.view.set_visible(false);
    }

    reload(key: PreviewKey): void {
        this.entries.get(key)?.view.reload();
    }

    devtools(key: PreviewKey): void {
        this.entries.get(key)?.view.open_devtools();
    }

    /** The page's current URL, or the last `set` URL before the first load, or undefined. */
    url(key: PreviewKey): string | undefined {
        const entry = this.entries.get(key);
        if (entry === undefined) {
            return undefined;
        }
        const current = entry.view.current_url();
        return current === "" ? entry.url : current;
    }

    /** Loads `url` in the view; the pane's `set` URL stays, as after a click in the page. */
    navigate(key: PreviewKey, url: string): void {
        assert_url(url);
        this.entries.get(key)?.view.load(url);
    }

    back(key: PreviewKey): void {
        this.entries.get(key)?.view.go_back();
    }

    forward(key: PreviewKey): void {
        this.entries.get(key)?.view.go_forward();
    }

    zoom(key: PreviewKey, direction: ZoomDirection): void {
        const entry = this.entries.get(key);
        if (entry === undefined) {
            return;
        }
        entry.view.set_zoom_level(next_zoom_level(entry.view.zoom_level(), direction));
    }

    /** Null clears the search; the same text again finds the next match. */
    async find(key: PreviewKey, text: string | null): Promise<FindResult | null> {
        const entry = this.entries.get(key);
        if (entry === undefined) {
            return null;
        }
        if (text === null || text === "") {
            entry.finding = null;
            entry.view.stop_find();
            return null;
        }
        const next = entry.finding === text;
        entry.finding = text;
        return entry.view.find(text, next);
    }

    clear_storage(key: PreviewKey): Promise<void> {
        const entry = this.entries.get(key);
        return entry === undefined ? Promise.resolve() : entry.view.clear_storage();
    }

    /**
     * Moves the view into its own window; false when the key has no view yet. The main window
     * stops showing it; `set` and `show` leave it alone until `dock_back`. `on_closed` fires
     * when the user closes the window: the view is docked by then.
     */
    pop_out(key: PreviewKey, on_closed: () => void): boolean {
        const entry = this.entries.get(key);
        if (entry === undefined) {
            return false;
        }
        if (!entry.popped) {
            entry.popped = true;
            entry.visible = false;
        }
        entry.view.pop_out(() => {
            entry.popped = false;
            on_closed();
        });
        assert.equal(entry.visible, false);
        return true;
    }

    /** Puts the view back in the main window, hidden; false when it was not popped out. */
    dock_back(key: PreviewKey): boolean {
        const entry = this.entries.get(key);
        if (entry === undefined || !entry.popped) {
            return false;
        }
        entry.popped = false;
        entry.view.dock_back();
        assert.equal(entry.visible, false);
        return true;
    }

    popped_keys(): PreviewKey[] {
        return [...this.entries].filter(([, entry]) => entry.popped).map(([key]) => key);
    }

    /** Destroys every view of the session; the daemon's `session.closed` calls this. */
    close_session(session_dir: string): number {
        let closed = 0;
        for (const [key, entry] of [...this.entries]) {
            if (preview_key_session(key) === session_dir) {
                entry.view.destroy();
                this.entries.delete(key);
                closed += 1;
            }
        }
        return closed;
    }

    /**
     * Destroys every docked view: the window's page reloaded or navigated, so the renderer
     * that placed them is gone and would otherwise leave them painted at stale rectangles.
     * Popped-out views live in their own windows and are re-adopted through `panes.list`.
     */
    close_docked(): number {
        let closed = 0;
        for (const [key, entry] of [...this.entries]) {
            if (!entry.popped) {
                entry.view.destroy();
                this.entries.delete(key);
                closed += 1;
            }
        }
        return closed;
    }

    close_all(): void {
        for (const [key, entry] of [...this.entries]) {
            entry.view.destroy();
            this.entries.delete(key);
        }
        assert.equal(this.entries.size, 0);
    }

    keys(): PreviewKey[] {
        return [...this.entries.keys()];
    }

    visible_key(): PreviewKey | undefined {
        for (const [key, entry] of this.entries) {
            if (entry.visible) {
                return key;
            }
        }
        return undefined;
    }

    /**
     * Makes room for `incoming`: drops the least recently shown hidden views past the bound.
     * A popped-out view is on screen in its own window, so it stays.
     */
    private evict(incoming: PreviewKey): void {
        assert.equal(this.entries.has(incoming), false);
        const hidden = [...this.entries]
            .filter(([, entry]) => !entry.visible && !entry.popped)
            .sort(([, a], [, b]) => a.shown_at - b.shown_at);
        let excess = this.entries.size + 1 - this.views_max;
        for (const [key, entry] of hidden) {
            if (excess <= 0) {
                break;
            }
            entry.view.destroy();
            this.entries.delete(key);
            excess -= 1;
        }
        const on_screen = this.visible_key() !== undefined || this.popped_keys().length > 0;
        assert.ok(this.entries.size < this.views_max || on_screen);
    }
}

/** `setBounds` takes integers; the renderer measures fractional CSS pixels. */
export function integer_rect(rect: PreviewRect): PreviewRect {
    assert_finite(rect.x, "x");
    assert_finite(rect.y, "y");
    assert_finite(rect.width, "width");
    assert_finite(rect.height, "height");
    const x = Math.round(rect.x);
    const y = Math.round(rect.y);
    const width = Math.max(0, Math.round(rect.x + rect.width) - x);
    const height = Math.max(0, Math.round(rect.y + rect.height) - y);
    return { x, y, width, height };
}

function assert_finite(value: number, name: string): void {
    assert.equal(typeof value, "number", `rect.${name} must be a number`);
    assert.ok(Number.isFinite(value), `rect.${name} must be finite`);
}

function assert_key(key: PreviewKey): void {
    assert.equal(typeof key, "string", "a preview key is a string");
    assert.ok(key.includes("/"), "a preview key is <session dir>/<service>");
}

function assert_url(url: string): void {
    assert.equal(typeof url, "string", "a preview url is a string");
    assert.ok(/^https?:\/\//.test(url), "a preview url is http(s)");
}
