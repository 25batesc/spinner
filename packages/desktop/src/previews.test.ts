// Goal: the registry keeps one view per key, shows one at a time, keeps hidden views alive,
// loads a URL only when it changes, rounds bounds to integers, destroys a session's views on
// close, and bounds the number of views. Method: a fake host records every call per view.
import { describe, expect, it } from "vitest";
import { integer_rect, PreviewRegistry, type PreviewHost, type PreviewView } from "./previews.js";

interface FakeView extends PreviewView {
    calls: string[];
    url: string;
    destroyed: boolean;
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

    it("rejects a malformed key, url or rectangle", () => {
        const registry = new PreviewRegistry(fake_host());
        expect(() => registry.set("nokey", "http://x", rect)).toThrow(/session dir/);
        expect(() => registry.set("s1/web", "ftp://x", rect)).toThrow(/http/);
        expect(() => registry.set("s1/web", "http://x", { ...rect, x: Number.NaN })).toThrow(
            /finite/,
        );
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
