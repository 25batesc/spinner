// The sidebar's state (s020, round 2): VS Code's shape. The rail at the far left always shows
// the `sessions` and `reviews` icons at the top and the gear at the bottom; one side panel
// beside it shows one view at a time, or none. A click on an icon opens its view; a click on
// the active icon collapses the panel. The state is remembered per window in
// `sessionStorage`, as the focus record is (`focus.ts`): a reload keeps it and two windows
// keep their own.
import type { SessionView } from "@spinner/protocol";

import { needsHuman } from "./state.ts";

export type SidebarView = "sessions" | "reviews" | "settings";

export interface SidebarState {
    /** The view the side panel shows; null while the panel is collapsed. */
    view: SidebarView | null;
}

export const SIDEBAR_KEY = "spinner.sidebar.v2";

export const DEFAULT_SIDEBAR: SidebarState = { view: "sessions" };

const VIEWS: readonly SidebarView[] = ["sessions", "reviews", "settings"];

/** The subset of `Storage` the record needs, so tests pass a plain object. */
export interface SidebarStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

/**
 * A rail click on `view`. `shown` is true when the panel has an open column on screen: the
 * active icon then collapses it; any other click, or a click while the window's width or a
 * fold hides the column, opens the panel on that view.
 */
export function pickView(state: SidebarState, view: SidebarView, shown: boolean): SidebarState {
    if (shown && state.view === view) {
        return { view: null };
    }
    return { view };
}

/**
 * The detail a card shows at the column's width: `title` alone, the `title` with its `pills`,
 * or the `full` card. CSS draws each level from the column's `data-level` attribute.
 */
export type WidthLevel = "title" | "pills" | "full";

/** The narrowest width, in CSS pixels, of the `pills` and the `full` levels. */
export const LEVEL_PILLS_PX = 190;
export const LEVEL_FULL_PX = 240;

export function widthLevel(width: number): WidthLevel {
    if (width >= LEVEL_FULL_PX) {
        return "full";
    }
    if (width >= LEVEL_PILLS_PX) {
        return "pills";
    }
    return "title";
}

/** How many of `sessions` wait on the operator: the pill on the title row, the rail badge. */
export function needsCount(sessions: readonly [string, SessionView][]): number {
    return sessions.filter(([, view]) => needsHuman(view) !== null).length;
}

/** Reads the record; a missing, unreadable or unknown record falls back to the default. */
export function loadSidebar(storage: SidebarStorage | undefined): SidebarState {
    let parsed: unknown;
    try {
        const raw = storage?.getItem(SIDEBAR_KEY);
        parsed = raw === null || raw === undefined ? undefined : JSON.parse(raw);
    } catch {
        parsed = undefined;
    }
    if (typeof parsed !== "object" || parsed === null || !("view" in parsed)) {
        return DEFAULT_SIDEBAR;
    }
    const view = (parsed as { view: unknown }).view;
    if (view === null) {
        return { view: null };
    }
    const known = VIEWS.find((name) => name === view);
    return known === undefined ? DEFAULT_SIDEBAR : { view: known };
}

/** Writes the record. A full or disabled storage is not an error. */
export function saveSidebar(storage: SidebarStorage | undefined, state: SidebarState): void {
    try {
        storage?.setItem(SIDEBAR_KEY, JSON.stringify(state));
    } catch {
        // Private mode or a full quota: the view lasts for this page only.
    }
}
