// Goal: the registry keeps one view per key, shows one at a time, keeps hidden views alive,
// loads a URL only when it changes, rounds bounds to integers, destroys a session's views on
// close, bounds the number of views, and leaves a popped-out view to its own window until it
// docks back. Method: a fake host records every call per view and can close a pop-out window.
import { describe, expect, it } from "vitest";
import {
    integer_rect,
    next_zoom_level,
    PreviewRegistry,
    ZOOM_LEVEL_MAX,
    ZOOM_LEVEL_MIN,
    type PreviewHost,
    type PreviewView,
} from "./previews.js";

interface FakeView extends PreviewView {
    calls: string[];
    url: string;
    destroyed: boolean;
    /** The user's close of the pop-out window, while one is open. */
    close_window: (() => void) | null;
    zoom: number;
}

function fake_host(): PreviewHost & { views: Map<string, FakeView> } {
    const views = new Map<string, FakeView>();
    return {
        views,
        create(key) {
            const view: FakeView = {
                calls: [],
                url: "",
                destroyed: false,
                close_window: null,
                zoom: 0,
                load(url) {
                    this.url = url;
                    this.calls.push(`load ${url}`);
                },
                set_bounds(rect) {
                    this.calls.push(`bounds ${rect.x},${rect.y} ${rect.width}x${rect.height}`);
                },
                set_visible(visible) {
                    this.calls.push(visible ? "show" : "hide");
                },
                reload() {
                    this.calls.push("reload");
                },
                open_devtools() {
                    this.calls.push("devtools");
                },
                current_url() {
                    return this.url;
                },
                pop_out(on_closed) {
                    this.calls.push(this.close_window === null ? "pop out" : "focus");
                    this.close_window = () => {
                        this.close_window = null;
                        this.calls.push("window closed");
                        on_closed();
                    };
                },
                dock_back() {
                    this.close_window = null;
                    this.calls.push("dock back");
                },
                go_back() {
                    this.calls.push("back");
                },
                go_forward() {
                    this.calls.push("forward");
                },
                zoom_level() {
                    return this.zoom;
                },
                set_zoom_level(level) {
                    this.zoom = level;
                    this.calls.push(`zoom ${level}`);
                },
                find(text, next) {
                    this.calls.push(`find ${text}${next ? " next" : ""}`);
                    return Promise.resolve({ matches: 3, active: next ? 2 : 1 });
                },
                stop_find() {
                    this.calls.push("stop find");
                },
                clear_storage() {
                    this.calls.push("clear storage");
                    return Promise.resolve();
                },
                destroy() {
                    this.destroyed = true;
                    this.calls.push("destroy");
                },
            };
            views.set(key, view);
            return view;
        },
    };
}

const rect = { x: 10, y: 20, width: 300, height: 200 };

describe("PreviewRegistry", () => {
    it("creates a view on first set, loads once, and only moves it afterwards", () => {
        const host = fake_host();
        const registry = new PreviewRegistry(host);
        registry.set("s1-a/web", "http://web.s1.localhost", rect);
        registry.set("s1-a/web", "http://web.s1.localhost", { ...rect, width: 400 });
        expect(host.views.size).toBe(1);
        expect(host.views.get("s1-a/web")?.calls).toEqual([
            "load http://web.s1.localhost",
            "bounds 10,20 300x200",
            "show",
            "bounds 10,20 400x200",
        ]);
    });

    it("loads again when the url of a key changes", () => {
        const host = fake_host();
        const registry = new PreviewRegistry(host);
        registry.set("s1-a/web", "http://web.s1.localhost", rect);
        registry.set("s1-a/web", "http://web.s1.localhost/other", rect);
        expect(host.views.get("s1-a/web")?.calls.filter((c) => c.startsWith("load"))).toEqual([
            "load http://web.s1.localhost",
            "load http://web.s1.localhost/other",
        ]);
    });

    it("shows one view at a time and keeps the hidden one alive", () => {
        const host = fake_host();
        const registry = new PreviewRegistry(host);
        registry.set("s1-a/web", "http://web.s1.localhost", rect);
        registry.set("s1-a/api", "http://api.s1.localhost", rect);
        expect(registry.visible_key()).toBe("s1-a/api");
        expect(host.views.get("s1-a/web")?.calls.at(-1)).toBe("hide");
        expect(host.views.get("s1-a/web")?.destroyed).toBe(false);
        registry.show("s1-a/web");
        expect(registry.visible_key()).toBe("s1-a/web");
        expect(host.views.get("s1-a/api")?.calls.at(-1)).toBe("hide");
        // A second show is a no-op on the view: no flicker from redundant calls.
        registry.show("s1-a/web");
        expect(host.views.get("s1-a/web")?.calls.filter((c) => c === "show")).toHaveLength(2);
    });

    it("hide, reload and devtools reach the view; unknown keys are ignored", () => {
        const host = fake_host();
        const registry = new PreviewRegistry(host);
        registry.set("s1-a/web", "http://web.s1.localhost", rect);
        registry.hide("s1-a/web");
        registry.hide("s1-a/web");
        registry.reload("s1-a/web");
        registry.devtools("s1-a/web");
        registry.hide("none/none");
        registry.reload("none/none");
        expect(registry.visible_key()).toBeUndefined();
        expect(host.views.get("s1-a/web")?.calls.slice(-3)).toEqual(["hide", "reload", "devtools"]);
    });

    it("reports the page's current url, or the set url before the first load", () => {
        const host = fake_host();
        const registry = new PreviewRegistry(host);
        registry.set("s1-a/web", "http://web.s1.localhost", rect);
        expect(registry.url("s1-a/web")).toBe("http://web.s1.localhost");
        const view = host.views.get("s1-a/web");
        if (view === undefined) {
            throw new Error("view missing");
        }
        view.url = "http://web.s1.localhost/after-login";
        expect(registry.url("s1-a/web")).toBe("http://web.s1.localhost/after-login");
        expect(registry.url("none/none")).toBeUndefined();
    });

    it("destroys the views of a closed session and no others", () => {
        const host = fake_host();
        const registry = new PreviewRegistry(host);
        registry.set("s1-a/web", "http://web.s1.localhost", rect);
        registry.set("s1-a/api", "http://api.s1.localhost", rect);
        registry.set("s2-b/web", "http://web.s2.localhost", rect);
        expect(registry.close_session("s1-a")).toBe(2);
        expect(registry.keys()).toEqual(["s2-b/web"]);
        expect(host.views.get("s1-a/web")?.destroyed).toBe(true);
        expect(host.views.get("s2-b/web")?.destroyed).toBe(false);
        expect(registry.close_session("s1-a")).toBe(0);
        registry.close_all();
        expect(registry.keys()).toEqual([]);
    });

    it("evicts the least recently shown hidden view past the bound", () => {
        const host = fake_host();
        const registry = new PreviewRegistry(host, 2);
        registry.set("s1-a/web", "http://web.s1.localhost", rect);
        registry.set("s1-a/api", "http://api.s1.localhost", rect);
        registry.show("s1-a/web");
        registry.set("s2-b/web", "http://web.s2.localhost", rect);
        expect(registry.keys().sort()).toEqual(["s1-a/web", "s2-b/web"]);
        expect(host.views.get("s1-a/api")?.destroyed).toBe(true);
    });

    it("leaves a popped-out view alone until dock back, then the next set places it", () => {
        const host = fake_host();
        const registry = new PreviewRegistry(host);
        registry.set("s1-a/web", "http://web.s1.localhost", rect);
        registry.set("s1-a/api", "http://api.s1.localhost", rect);
        const closed: string[] = [];
        expect(registry.pop_out("s1-a/web", () => closed.push("web"))).toBe(true);
        expect(registry.pop_out("none/none", () => closed.push("none"))).toBe(false);
        expect(registry.popped_keys()).toEqual(["s1-a/web"]);
        expect(registry.visible_key()).toBe("s1-a/api");
        // The pane keeps measuring: the URL may change, the placement must not.
        registry.set("s1-a/web", "http://web.s1.localhost/next", { ...rect, width: 50 });
        registry.show("s1-a/web");
        registry.hide("s1-a/web");
        registry.show("s1-a/api");
        const web = host.views.get("s1-a/web");
        expect(web?.calls.slice(-2)).toEqual(["pop out", "load http://web.s1.localhost/next"]);
        expect(registry.visible_key()).toBe("s1-a/api");
        // A second pop-out focuses the window.
        registry.pop_out("s1-a/web", () => closed.push("web"));
        expect(web?.calls.at(-1)).toBe("focus");
        expect(registry.dock_back("s1-a/web")).toBe(true);
        expect(registry.dock_back("s1-a/web")).toBe(false);
        expect(registry.popped_keys()).toEqual([]);
        expect(closed).toEqual([]);
        registry.set("s1-a/web", "http://web.s1.localhost/next", rect);
        expect(web?.calls.slice(-3)).toEqual(["dock back", "bounds 10,20 300x200", "show"]);
    });

    it("a closed pop-out window docks the view and reports it once", () => {
        const host = fake_host();
        const registry = new PreviewRegistry(host, 2);
        registry.set("s1-a/web", "http://web.s1.localhost", rect);
        const closed: string[] = [];
        registry.pop_out("s1-a/web", () => closed.push("web"));
        // Two more views: the hidden one goes, the popped-out one is on screen and stays.
        registry.set("s1-a/api", "http://api.s1.localhost", rect);
        registry.hide("s1-a/api");
        registry.set("s1-a/docs", "http://docs.s1.localhost", rect);
        expect(registry.keys().sort()).toEqual(["s1-a/docs", "s1-a/web"]);
        host.views.get("s1-a/web")?.close_window?.();
        expect(closed).toEqual(["web"]);
        expect(registry.popped_keys()).toEqual([]);
        expect(registry.dock_back("s1-a/web")).toBe(false);
    });

    it("browser bar: navigate keeps the set url, history and zoom reach the view", async () => {
        const host = fake_host();
        const registry = new PreviewRegistry(host);
        registry.set("s1-a/web", "http://web.s1.localhost", rect);
        registry.navigate("s1-a/web", "http://api.s1.localhost/items");
        expect(() => registry.navigate("s1-a/web", "file:///etc/passwd")).toThrow(/http/);
        // The pane's URL did not change: a repeated set only moves the view, no load.
        registry.set("s1-a/web", "http://web.s1.localhost", { ...rect, width: 400 });
        registry.back("s1-a/web");
        registry.forward("s1-a/web");
        registry.zoom("s1-a/web", "in");
        registry.zoom("s1-a/web", "in");
        registry.zoom("s1-a/web", "out");
        registry.zoom("s1-a/web", "reset");
        await registry.clear_storage("s1-a/web");
        registry.navigate("none/none", "http://x");
        registry.zoom("none/none", "in");
        expect(host.views.get("s1-a/web")?.calls.slice(3)).toEqual([
            "load http://api.s1.localhost/items",
            "bounds 10,20 400x200",
            "back",
            "forward",
            "zoom 1",
            "zoom 2",
            "zoom 1",
            "zoom 0",
            "clear storage",
        ]);
    });

    it("find: the same text again finds the next match; null clears", async () => {
        const host = fake_host();
        const registry = new PreviewRegistry(host);
        registry.set("s1-a/web", "http://web.s1.localhost", rect);
        expect(await registry.find("s1-a/web", "items")).toEqual({ matches: 3, active: 1 });
        expect(await registry.find("s1-a/web", "items")).toEqual({ matches: 3, active: 2 });
        expect(await registry.find("s1-a/web", "other")).toEqual({ matches: 3, active: 1 });
        expect(await registry.find("s1-a/web", null)).toBeNull();
        expect(await registry.find("s1-a/web", "")).toBeNull();
        expect(await registry.find("s1-a/web", "other")).toEqual({ matches: 3, active: 1 });
        expect(await registry.find("none/none", "x")).toBeNull();
        expect(host.views.get("s1-a/web")?.calls.slice(3)).toEqual([
            "find items",
            "find items next",
            "find other",
            "stop find",
            "stop find",
            "find other",
        ]);
    });

    it("rejects a malformed key, url or rectangle", () => {
        const registry = new PreviewRegistry(fake_host());
        expect(() => registry.set("nokey", "http://x", rect)).toThrow(/session dir/);
        expect(() => registry.set("s1/web", "ftp://x", rect)).toThrow(/http/);
        expect(() => registry.set("s1/web", "http://x", { ...rect, x: Number.NaN })).toThrow(
            /finite/,
        );
    });
});

describe("next_zoom_level", () => {
    it("steps one level, stops at the bounds, and resets to 100 %", () => {
        expect(next_zoom_level(0, "in")).toBe(1);
        expect(next_zoom_level(0, "out")).toBe(-1);
        expect(next_zoom_level(ZOOM_LEVEL_MAX, "in")).toBe(ZOOM_LEVEL_MAX);
        expect(next_zoom_level(ZOOM_LEVEL_MIN, "out")).toBe(ZOOM_LEVEL_MIN);
        expect(next_zoom_level(2.5, "reset")).toBe(0);
        expect(() => next_zoom_level(Number.NaN, "in")).toThrow(/number/);
    });
});

describe("integer_rect", () => {
    it("rounds edges, not sizes, so adjacent rectangles do not drift", () => {
        expect(integer_rect({ x: 10.4, y: 0.6, width: 100.3, height: 50.9 })).toEqual({
            x: 10,
            y: 1,
            width: 101,
            height: 51,
        });
    });

    it("never returns a negative size", () => {
        expect(integer_rect({ x: 0, y: 0, width: -5, height: 0.2 })).toEqual({
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        });
    });
});
