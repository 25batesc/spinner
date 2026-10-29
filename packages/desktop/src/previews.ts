// The preview registry: one view per preview key, created on demand, shown one at a time,
// hidden views kept alive so a page keeps its state, destroyed when the session closes. This
// file is pure so Vitest can drive it: the registry takes a `PreviewHost` that makes views and
// calls their methods; `main.ts` supplies the Electron one.
import assert from "node:assert/strict";
import { preview_key_session, type PreviewKey, type PreviewRect } from "@spinner/protocol";

/** What the registry needs from one `WebContentsView`. */
export interface PreviewView {
    load(url: string): void;
    set_bounds(rect: PreviewRect): void;
    set_visible(visible: boolean): void;
    reload(): void;
    open_devtools(): void;
    /** The URL the page is at now, after navigation inside it. */
    current_url(): string;
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
    visible: boolean;
    /** Monotonic tick of the last `set` or `show`, for eviction order. */
    shown_at: number;
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
            entry = { view: this.host.create(key), url: "", visible: false, shown_at: 0 };
            this.entries.set(key, entry);
        }
        if (entry.url !== url) {
            entry.url = url;
            entry.view.load(url);
        }
        entry.view.set_bounds(bounds);
        this.show(key);
    }

    show(key: PreviewKey): void {
        const entry = this.entries.get(key);
        if (entry === undefined) {
            return;
        }
        this.tick += 1;
        entry.shown_at = this.tick;
        for (const [other_key, other] of this.entries) {
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

    /** Makes room for `incoming`: drops the least recently shown hidden views past the bound. */
    private evict(incoming: PreviewKey): void {
        assert.equal(this.entries.has(incoming), false);
        const hidden = [...this.entries]
            .filter(([, entry]) => !entry.visible)
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
        assert.ok(this.entries.size < this.views_max || this.visible_key() !== undefined);
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
