// The pane geometry rules: a drag clamps at the minimum and `collapse` folds the pane the way
// its kind says (the left panel hides, the previews become a strip, agents never fold),
// restore brings the remembered width back, the free column moves to the open pane, expand
// shows the previews alone, and the layout survives a round trip through storage while bad
// or partial records fall back to the defaults. A narrow window is a derived layout: the
// previews shrink, then the side panel, then the previews collapse, then the side panel folds,
// and the agents pane never goes under 280 px.
import { describe, expect, it } from "vitest";

import {
    columns,
    DEFAULT_LAYOUT,
    fitLayout,
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

describe("fitLayout", () => {
    // The defaults ask for 260 + 6 + 280 + 6 + 520 = 1072 px with the agents at their minimum.
    it("leaves a layout that fits, and one not measured yet, alone", () => {
        expect(fitLayout(DEFAULT_LAYOUT, 1072)).toBe(DEFAULT_LAYOUT);
        expect(fitLayout(DEFAULT_LAYOUT, 1460)).toBe(DEFAULT_LAYOUT);
        expect(fitLayout(DEFAULT_LAYOUT, 0)).toBe(DEFAULT_LAYOUT);
    });

    it("shrinks the previews first, down to their minimum, so the agents keep 280 px", () => {
        // A 900 px window: 860 px for the grid. The previews give up the 212 px deficit.
        const fitted = fitLayout(DEFAULT_LAYOUT, 860);
        expect(columns(fitted)).toBe("260px 6px 1fr 6px 308px");
        expect(fitted.panes.previews.collapsed).toBe(false);
        // 752 px: the previews stop at 200 and the side panel gives the other 120 px.
        const tighter = fitLayout(DEFAULT_LAYOUT, 752);
        expect(columns(tighter)).toBe("260px 6px 1fr 6px 200px");
        expect(columns(fitLayout(DEFAULT_LAYOUT, 660))).toBe("168px 6px 1fr 6px 200px");
    });

    it("collapses the previews to a strip before it folds the side panel", () => {
        // Under 632 px (140 + 6 + 280 + 6 + 200) the minimums do not fit: the previews strip.
        const strip = fitLayout(DEFAULT_LAYOUT, 560);
        expect(columns(strip)).toBe("140px 6px 1fr 6px 24px");
        expect(strip.panes.previews).toMatchObject({ collapsed: true, hidden: false });
        expect(strip.panes.sessions.hidden).toBe(false);
        // Under 456 px (140 + 6 + 280 + 6 + 24) the side panel folds too.
        const folded = fitLayout(DEFAULT_LAYOUT, 400);
        expect(visiblePanes(folded)).toEqual(["agents", "previews"]);
        expect(columns(folded)).toBe("1fr 6px 24px");
    });

    it("never changes the stored layout, the expanded view or a folded agents pane", () => {
        fitLayout(DEFAULT_LAYOUT, 400);
        expect(DEFAULT_LAYOUT.panes.previews).toMatchObject({ width: 520, collapsed: false });
        const expanded = reduceLayout(DEFAULT_LAYOUT, { kind: "expand", expanded: true });
        expect(fitLayout(expanded, 400)).toBe(expanded);
        const popped = reduceLayout(DEFAULT_LAYOUT, {
            kind: "popped", pane: "agents", popped: true,
        });
        expect(fitLayout(popped, 400)).toBe(popped);
    });

    it("counts a hidden side panel and a strip at their real widths", () => {
        const hidden = fold(DEFAULT_LAYOUT, "sessions");
        // 280 + 6 + 520 = 806 fits in 806; at 700 the previews shrink to 414.
        expect(fitLayout(hidden, 806)).toBe(hidden);
        expect(columns(fitLayout(hidden, 700))).toBe("1fr 6px 414px");
        const strip = fold(DEFAULT_LAYOUT, "previews");
        // 260 + 6 + 280 + 6 + 24 = 576; at 500 the side panel shrinks to 184.
        expect(columns(fitLayout(strip, 500))).toBe("184px 6px 1fr 6px 24px");
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
            drawer: { height: 200, collapsed: false },
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

describe("the job drawer", () => {
    it("clamps a dragged height between the floor and the pane's allowance", () => {
        const dragged = reduceLayout(DEFAULT_LAYOUT, { kind: "drawer", height: 300, max: 500 });
        expect(dragged.drawer).toEqual({ height: 300, collapsed: false });
        expect(reduceLayout(DEFAULT_LAYOUT, { kind: "drawer", height: 10, max: 500 }).drawer)
            .toEqual({ height: 48, collapsed: false });
        expect(reduceLayout(DEFAULT_LAYOUT, { kind: "drawer", height: 900, max: 500 }).drawer)
            .toEqual({ height: 500, collapsed: false });
        // A pane too short for the reserve still leaves the floor.
        expect(reduceLayout(DEFAULT_LAYOUT, { kind: "drawer", height: 100, max: 20 }).drawer)
            .toEqual({ height: 48, collapsed: false });
    });

    it("keeps the height through a collapse, and a drag reopens", () => {
        const tall = reduceLayout(DEFAULT_LAYOUT, { kind: "drawer", height: 320, max: 600 });
        const bar = reduceLayout(tall, { kind: "drawer-collapse", collapsed: true });
        expect(bar.drawer).toEqual({ height: 320, collapsed: true });
        expect(reduceLayout(bar, { kind: "drawer-collapse", collapsed: false }).drawer)
            .toEqual({ height: 320, collapsed: false });
        expect(reduceLayout(bar, { kind: "drawer", height: 100, max: 600 }).drawer)
            .toEqual({ height: 100, collapsed: false });
        // A drag that ends under the floor passed smaller heights on the way; the collapse
        // remembers the height the drag began at.
        const low = reduceLayout(tall, { kind: "drawer", height: 60, max: 600 });
        const collapse = { kind: "drawer-collapse" as const, collapsed: true, remember: 320 };
        const dragged = reduceLayout(low, collapse);
        expect(dragged.drawer).toEqual({ height: 320, collapsed: true });
    });

    it("survives storage with the panes, and falls back field by field", () => {
        const storage = memory();
        const bar = reduceLayout(
            reduceLayout(DEFAULT_LAYOUT, { kind: "drawer", height: 260, max: 600 }),
            { kind: "drawer-collapse", collapsed: true },
        );
        saveLayout(storage, bar);
        expect(loadLayout(storage).drawer).toEqual({ height: 260, collapsed: true });
        const partial = memory({ [STORAGE_KEY]: JSON.stringify({ drawer: { height: 5 } }) });
        expect(loadLayout(partial).drawer).toEqual({ height: 48, collapsed: false });
        const none = memory({ [STORAGE_KEY]: JSON.stringify({ expanded: false }) });
        expect(loadLayout(none).drawer).toEqual(DEFAULT_LAYOUT.drawer);
    });
});
