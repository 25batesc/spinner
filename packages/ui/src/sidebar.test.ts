// The sidebar's sections (s020): a header toggles its own section and leaves the other one
// alone, so both can be open; the settings view gives the column back on a header click; a
// rail click opens its section; the record survives storage and falls back from bad input;
// the needs-you count follows `needs_human`; the detail level follows the column's width.
import { describe, expect, it } from "vitest";

import { initialReviews, initialSessions } from "../fixture/data.ts";
import {
    DEFAULT_SIDEBAR,
    loadSidebar,
    needsCount,
    openSection,
    saveSidebar,
    sectionOpen,
    setSettings,
    SIDEBAR_KEY,
    toggleSection,
    widthLevel,
    type SidebarStorage,
} from "./sidebar.ts";

function memory(initial: Record<string, string> = {}): SidebarStorage & { store: typeof initial } {
    const store = { ...initial };
    return {
        store,
        getItem: (key) => store[key] ?? null,
        setItem: (key, value) => {
            store[key] = value;
        },
    };
}

describe("the sections", () => {
    it("toggles one section at a time, and both can be open", () => {
        const both = toggleSection(DEFAULT_SIDEBAR, "reviews");
        expect(sectionOpen(both, "sessions")).toBe(true);
        expect(sectionOpen(both, "reviews")).toBe(true);
        const reviewsOnly = toggleSection(both, "sessions");
        expect(sectionOpen(reviewsOnly, "sessions")).toBe(false);
        expect(sectionOpen(reviewsOnly, "reviews")).toBe(true);
    });

    it("shows the sections closed under settings, and a header click leaves settings open", () => {
        const settings = setSettings(DEFAULT_SIDEBAR, true);
        expect(sectionOpen(settings, "sessions")).toBe(false);
        const back = toggleSection(settings, "reviews");
        expect(back.settings).toBe(false);
        expect(sectionOpen(back, "reviews")).toBe(true);
        expect(sectionOpen(back, "sessions")).toBe(true);
    });

    it("opens the rail's section and never closes it", () => {
        const closed = { sessions: false, reviews: false, settings: true };
        expect(openSection(closed, "reviews")).toEqual({
            sessions: false, reviews: true, settings: false,
        });
        expect(openSection(DEFAULT_SIDEBAR, "sessions")).toEqual(DEFAULT_SIDEBAR);
    });
});

describe("widthLevel", () => {
    it("is the title alone under 190 px, the pills under 240 px, the full card from 240 px", () => {
        expect(widthLevel(140)).toBe("title");
        expect(widthLevel(189)).toBe("title");
        expect(widthLevel(190)).toBe("pills");
        expect(widthLevel(239)).toBe("pills");
        expect(widthLevel(240)).toBe("full");
        expect(widthLevel(260)).toBe("full");
        expect(widthLevel(480)).toBe("full");
    });
});

describe("needsCount", () => {
    it("counts the sessions that wait on the operator", () => {
        const pairs = (views: ReturnType<typeof initialSessions>) =>
            views.map((view) => [view.summary.dir, view] as [string, typeof view]);
        expect(needsCount(pairs(initialSessions()))).toBe(1);
        expect(needsCount(pairs(initialReviews()))).toBe(2);
        expect(needsCount([])).toBe(0);
    });
});

describe("loadSidebar and saveSidebar", () => {
    it("round-trips the record and falls back field by field", () => {
        const storage = memory();
        const state = { sessions: false, reviews: true, settings: false };
        saveSidebar(storage, state);
        expect(Object.keys(storage.store)).toEqual([SIDEBAR_KEY]);
        expect(loadSidebar(storage)).toEqual(state);
        expect(loadSidebar(undefined)).toEqual(DEFAULT_SIDEBAR);
        expect(loadSidebar(memory({ [SIDEBAR_KEY]: "nope" }))).toEqual(DEFAULT_SIDEBAR);
        const partial = memory({ [SIDEBAR_KEY]: JSON.stringify({ reviews: true, sessions: 1 }) });
        expect(loadSidebar(partial)).toEqual({ ...DEFAULT_SIDEBAR, reviews: true });
    });
});
