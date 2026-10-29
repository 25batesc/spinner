// The pane geometry rules: a drag clamps at the minimum and `collapse` folds the pane the way
// its kind says (the left panel hides, the previews become a strip, agents never fold),
// restore brings the remembered width back, the free column moves to the open pane, expand
// shows the previews alone, and the layout survives a round trip through storage while bad
// or partial records fall back to the defaults.
import { describe, expect, it } from "vitest";

import {
    columns,
    DEFAULT_LAYOUT,
    loadLayout,
    reduceLayout,
    saveLayout,
    STORAGE_KEY,
    visiblePanes,
    type Layout,
    type LayoutStorage,
} from "./layout.ts";

function memory(initial: Record<string, string> = {}): LayoutStorage & { store: typeof initial } {
    const store = { ...initial };
    return {
        store,
        getItem: (key) => store[key] ?? null,
        setItem: (key, value) => {
            store[key] = value;
        },
    };
}

const fold = (layout: Layout, pane: "sessions" | "agents" | "previews", remember?: number) =>
    reduceLayout(layout, { kind: "collapse", pane, remember });

describe("reduceLayout", () => {
    it("clamps a drag between the minimum and the maximum and never folds by itself", () => {
        const wide = reduceLayout(DEFAULT_LAYOUT, { kind: "drag", pane: "sessions", width: 999 });
        expect(wide.panes.sessions.width).toBe(480);
        const narrow = reduceLayout(DEFAULT_LAYOUT, { kind: "drag", pane: "sessions", width: 60 });
        expect(narrow.panes.sessions).toMatchObject({ width: 140, hidden: false });
        const right = reduceLayout(DEFAULT_LAYOUT, { kind: "drag", pane: "previews", width: 10 });
        expect(right.panes.previews).toMatchObject({ width: 200, collapsed: false });
    });

    it("folds each pane its own way: the left panel hides, previews strip, agents stay", () => {
        const left = fold(DEFAULT_LAYOUT, "sessions", 260);
        expect(left.panes.sessions).toMatchObject({ hidden: true, collapsed: false, width: 260 });
        const right = fold(DEFAULT_LAYOUT, "previews", 520);
        expect(right.panes.previews).toMatchObject({ collapsed: true, hidden: false, width: 520 });
        expect(fold(DEFAULT_LAYOUT, "agents")).toEqual(DEFAULT_LAYOUT);
    });

    it("restore brings back the remembered width, or the width the restoring drag gives", () => {
        const narrowed = reduceLayout(DEFAULT_LAYOUT, {
            kind: "drag", pane: "previews", width: 300,
        });
        const collapsed = fold(narrowed, "previews", 520);
        expect(collapsed.panes.previews.width).toBe(520);
        const restored = reduceLayout(collapsed, { kind: "restore", pane: "previews" });
        expect(restored.panes.previews).toEqual({
            width: 520, collapsed: false, hidden: false, popped: false,
        });
        const dragged = reduceLayout(collapsed, { kind: "restore", pane: "previews", width: 333 });
        expect(dragged.panes.previews.width).toBe(333);
    });

    it("restore clears the popped flag too", () => {
        const popped = reduceLayout(DEFAULT_LAYOUT, {
            kind: "popped", pane: "agents", popped: true,
        });
        expect(columns(popped)).toBe("260px 6px 24px 6px 1fr");
        const back = reduceLayout(popped, { kind: "restore", pane: "agents" });
        expect(back.panes.agents.popped).toBe(false);
    });
});

describe("columns and visiblePanes", () => {
    it("gives the agents pane the free space by default", () => {
        expect(columns(DEFAULT_LAYOUT)).toBe("260px 6px 1fr 6px 520px");
    });

    it("drops the left panel's column and divider when it is hidden", () => {
        const hidden = fold(DEFAULT_LAYOUT, "sessions");
        expect(visiblePanes(hidden)).toEqual(["agents", "previews"]);
        expect(columns(hidden)).toBe("1fr 6px 520px");
        const both = fold(hidden, "previews");
        expect(columns(both)).toBe("1fr 6px 24px");
    });

    it("expand shows the previews alone and keeps the panes underneath", () => {
        const expanded = reduceLayout(fold(DEFAULT_LAYOUT, "sessions"), {
            kind: "expand", expanded: true,
        });
        expect(visiblePanes(expanded)).toEqual(["previews"]);
        expect(columns(expanded)).toBe("1fr");
        const back = reduceLayout(expanded, { kind: "expand", expanded: false });
        expect(columns(back)).toBe("1fr 6px 520px");
    });
});

describe("loadLayout and saveLayout", () => {
    it("round-trips widths, folds and expand, but never the popped flag", () => {
        const storage = memory();
        const layout: Layout = {
            panes: {
                sessions: { width: 300, collapsed: false, hidden: true, popped: false },
                agents: { width: 640, collapsed: false, hidden: false, popped: true },
                previews: { width: 700, collapsed: true, hidden: false, popped: false },
            },
            expanded: true,
        };
        saveLayout(storage, layout);
        const loaded = loadLayout(storage);
        expect(loaded.expanded).toBe(true);
        expect(loaded.panes.sessions).toEqual(layout.panes.sessions);
        expect(loaded.panes.agents).toEqual({ ...layout.panes.agents, popped: false });
        expect(loaded.panes.previews).toEqual(layout.panes.previews);
    });

    it("falls back field by field on a missing, broken or out-of-range record", () => {
        expect(loadLayout(undefined)).toEqual(DEFAULT_LAYOUT);
        expect(loadLayout(memory({ [STORAGE_KEY]: "{not json" }))).toEqual(DEFAULT_LAYOUT);
        const partial = memory({
            [STORAGE_KEY]: JSON.stringify({
                panes: { previews: { width: 5000, collapsed: "yes" }, agents: { hidden: true } },
            }),
        });
        const loaded = loadLayout(partial);
        expect(loaded.panes.sessions).toEqual(DEFAULT_LAYOUT.panes.sessions);
        expect(loaded.panes.agents.hidden).toBe(false);
        // The previews have no cap of their own: the agents minimum bounds the drag instead.
        expect(loaded.panes.previews).toEqual({
            width: 5000, collapsed: false, hidden: false, popped: false,
        });
    });

    it("swallows a storage that throws", () => {
        const broken: LayoutStorage = {
            getItem: () => {
                throw new Error("quota");
            },
            setItem: () => {
                throw new Error("quota");
            },
        };
        expect(loadLayout(broken)).toEqual(DEFAULT_LAYOUT);
        expect(() => saveLayout(broken, DEFAULT_LAYOUT)).not.toThrow();
    });
});
