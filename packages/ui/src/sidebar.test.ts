// The side panel's state (s020, round 2): a rail click opens its view, a click on the lit
// icon collapses the panel, a click on an icon whose panel the width or a fold hides opens it
// again; the record survives storage and falls back from bad input; the needs-you count
// follows `needs_human`; the detail level follows the panel's width; the title row carries
// the count alone, rendered to markup, since the rail icon owns the needs-you badge.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { initialReviews, initialSessions } from "../fixture/data.ts";
import { Sidebar, type ViewFacts } from "./Sidebar.tsx";
import { needsHuman } from "./state.ts";
import {
    DEFAULT_SIDEBAR,
    loadSidebar,
    loadSeen,
    markSeen,
    needsCount,
    saveSeen,
    SEEN_KEY,
    type Seen,
    pickView,
    saveSidebar,
    SIDEBAR_KEY,
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

describe("pickView", () => {
    it("opens one view at a time", () => {
        expect(pickView(DEFAULT_SIDEBAR, "reviews", true)).toEqual({ view: "reviews" });
        expect(pickView({ view: "reviews" }, "settings", true)).toEqual({ view: "settings" });
        expect(pickView({ view: null }, "sessions", false)).toEqual({ view: "sessions" });
    });

    it("collapses the panel on a click of the lit icon", () => {
        expect(pickView({ view: "sessions" }, "sessions", true)).toEqual({ view: null });
        expect(pickView({ view: "settings" }, "settings", true)).toEqual({ view: null });
    });

    it("opens, not collapses, when the width or a fold keeps the panel off screen", () => {
        expect(pickView({ view: "sessions" }, "sessions", false)).toEqual({ view: "sessions" });
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

    it("stops counting a session once its needs-you line was seen, until the line changes", () => {
        const rows = initialSessions().map(
            (view) => [view.summary.dir, view] as [string, typeof view],
        );
        const waiting = rows.find(([, view]) => needsHuman(view) !== null);
        if (waiting === undefined) {
            throw new Error("the fixture has a waiting session");
        }
        const [dir, view] = waiting;
        const seen = markSeen({}, dir, view);
        expect(seen[dir]).toBe(needsHuman(view));
        expect(needsCount(rows, seen)).toBe(0);
        const changed: Seen = { [dir]: "something else" };
        expect(needsCount(rows, changed)).toBe(1);
        // A pick of a session without a needs-you line leaves the record alone.
        const quiet = rows.find(([, row]) => needsHuman(row) === null);
        expect(markSeen(seen, quiet?.[0] ?? "none", quiet?.[1])).toBe(seen);
    });

    it("round-trips the seen record and drops a bad one", () => {
        const store = new Map<string, string>();
        const storage = {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => void store.set(key, value),
        };
        saveSeen(storage, { "s001-a": "approve the PR" });
        expect(loadSeen(storage)).toEqual({ "s001-a": "approve the PR" });
        store.set(SEEN_KEY, "[1]");
        expect(loadSeen(storage)).toEqual({});
        store.set(SEEN_KEY, "{");
        expect(loadSeen(storage)).toEqual({});
        expect(loadSeen(undefined)).toEqual({});
    });
});

describe("Sidebar title row", () => {
    function titleRow(view: "sessions" | "settings", facts: ViewFacts | undefined): string {
        const markup = renderToStaticMarkup(
            createElement(Sidebar, { view, level: "full", facts, children: null }),
        );
        const header = /<header class="side-title"[^>]*>(.*?)<\/header>/.exec(markup);
        if (header === null) {
            throw new Error(`no title row in ${markup}`);
        }
        return header[1] ?? "";
    }

    it("shows the view's name and its count, and no needs pill", () => {
        // The caller also knows how many sessions wait on the operator; the row ignores it.
        const facts = { count: 3, needs: 2 };
        const row = titleRow("sessions", facts);
        expect(row).toContain(">Sessions</h2>");
        expect(row).toContain('<span class="muted side-title-count">3</span>');
        expect(row).not.toContain("pill");
        expect(row).not.toContain("need");
    });

    it("shows settings by its name alone", () => {
        const row = titleRow("settings", undefined);
        expect(row).toContain(">Settings</h2>");
        expect(row).not.toContain("side-title-count");
    });
});

describe("loadSidebar and saveSidebar", () => {
    it("round-trips the record, a collapsed panel included", () => {
        const storage = memory();
        saveSidebar(storage, { view: "reviews" });
        expect(Object.keys(storage.store)).toEqual([SIDEBAR_KEY]);
        expect(SIDEBAR_KEY).toBe("spinner.sidebar.v2");
        expect(loadSidebar(storage)).toEqual({ view: "reviews" });
        saveSidebar(storage, { view: null });
        expect(loadSidebar(storage)).toEqual({ view: null });
    });

    it("falls back to the sessions view from a missing, broken or unknown record", () => {
        expect(loadSidebar(undefined)).toEqual(DEFAULT_SIDEBAR);
        expect(loadSidebar(memory())).toEqual(DEFAULT_SIDEBAR);
        expect(loadSidebar(memory({ [SIDEBAR_KEY]: "nope" }))).toEqual(DEFAULT_SIDEBAR);
        const odd = memory({ [SIDEBAR_KEY]: JSON.stringify({ view: "agents" }) });
        expect(loadSidebar(odd)).toEqual(DEFAULT_SIDEBAR);
        const v1 = memory({ [SIDEBAR_KEY]: JSON.stringify({ sessions: true, reviews: true }) });
        expect(loadSidebar(v1)).toEqual(DEFAULT_SIDEBAR);
        expect(DEFAULT_SIDEBAR).toEqual({ view: "sessions" });
    });

    it("does not throw when the storage refuses the write", () => {
        const full: SidebarStorage = {
            getItem: () => null,
            setItem: () => {
                throw new Error("quota");
            },
        };
        expect(() => saveSidebar(full, DEFAULT_SIDEBAR)).not.toThrow();
    });
});
