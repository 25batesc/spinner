// The pane geometry rules: a drag below the threshold collapses, restore brings the last width
// back, the free column moves when the agents pane is a strip, and the remembered layout
// survives a round trip through storage while bad or partial records fall back to defaults.
import { describe, expect, it } from "vitest";

import {
    columns,
    DEFAULT_LAYOUT,
    loadLayout,
    reduceLayout,
    saveLayout,
    STORAGE_KEY,
    STRIP_PX,
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

describe("reduceLayout", () => {
    it("clamps a drag between the threshold and the maximum", () => {
        const wide = reduceLayout(DEFAULT_LAYOUT, { kind: "drag", pane: "sessions", width: 999 });
        expect(wide.sessions.width).toBe(480);
        const narrow = reduceLayout(DEFAULT_LAYOUT, {
            kind: "drag", pane: "sessions", width: 180.4,
        });
        expect(narrow.sessions).toEqual({ width: 180, collapsed: false, popped: false });
    });

    it("collapses below the threshold and keeps the remembered width for restore", () => {
        const narrowed = reduceLayout(DEFAULT_LAYOUT, {
            kind: "drag", pane: "previews", width: 300,
        });
        const collapsed = reduceLayout(narrowed, {
            kind: "collapse", pane: "previews", remember: 520,
        });
        expect(collapsed.previews.collapsed).toBe(true);
        expect(collapsed.previews.width).toBe(520);
        const dragged = reduceLayout(narrowed, { kind: "drag", pane: "previews", width: 100 });
        expect(dragged.previews).toEqual({ width: 300, collapsed: true, popped: false });
        const restored = reduceLayout(collapsed, { kind: "restore", pane: "previews" });
        expect(restored.previews).toEqual({ width: 520, collapsed: false, popped: false });
    });

    it("a drag back past the threshold reopens a collapsed pane", () => {
        const collapsed = reduceLayout(DEFAULT_LAYOUT, { kind: "hide", pane: "sessions" });
        const open = reduceLayout(collapsed, { kind: "drag", pane: "sessions", width: 300 });
        expect(open.sessions).toEqual({ width: 300, collapsed: false, popped: false });
    });

    it("restore clears both the collapsed and the popped flags", () => {
        const popped = reduceLayout(DEFAULT_LAYOUT, {
            kind: "popped", pane: "agents", popped: true,
        });
        expect(columns(popped)).toContain(`${STRIP_PX}px`);
        const back = reduceLayout(popped, { kind: "restore", pane: "agents" });
        expect(back.agents.popped).toBe(false);
    });
});

describe("columns", () => {
    it("gives the agents pane the free space by default", () => {
        expect(columns(DEFAULT_LAYOUT)).toBe("260px 6px 1fr 6px 520px");
    });

    it("moves the free space to previews, then sessions, when agents is a strip", () => {
        const agentsHidden = reduceLayout(DEFAULT_LAYOUT, { kind: "hide", pane: "agents" });
        expect(columns(agentsHidden)).toBe("260px 6px 24px 6px 1fr");
        const previewsToo = reduceLayout(agentsHidden, { kind: "hide", pane: "previews" });
        expect(columns(previewsToo)).toBe("1fr 6px 24px 6px 24px");
        const all = reduceLayout(previewsToo, { kind: "hide", pane: "sessions" });
        expect(columns(all)).toBe("24px 6px 1fr 6px 24px");
    });
});

describe("loadLayout and saveLayout", () => {
    it("round-trips widths and collapsed flags but never the popped flag", () => {
        const storage = memory();
        const layout: Layout = {
            sessions: { width: 300, collapsed: true, popped: false },
            agents: { width: 0, collapsed: false, popped: true },
            previews: { width: 700, collapsed: false, popped: false },
        };
        saveLayout(storage, layout);
        expect(loadLayout(storage)).toEqual({
            sessions: { width: 300, collapsed: true, popped: false },
            agents: { width: 0, collapsed: false, popped: false },
            previews: { width: 700, collapsed: false, popped: false },
        });
    });

    it("falls back field by field on a missing, broken or out-of-range record", () => {
        expect(loadLayout(undefined)).toEqual(DEFAULT_LAYOUT);
        expect(loadLayout(memory({ [STORAGE_KEY]: "{not json" }))).toEqual(DEFAULT_LAYOUT);
        const partial = memory({
            [STORAGE_KEY]: JSON.stringify({ previews: { width: 5000, collapsed: "yes" } }),
        });
        const loaded = loadLayout(partial);
        expect(loaded.sessions).toEqual(DEFAULT_LAYOUT.sessions);
        expect(loaded.previews).toEqual({ width: 900, collapsed: false, popped: false });
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
