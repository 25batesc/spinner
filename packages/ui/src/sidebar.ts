// The sidebar's state (s020, round 2): VS Code's shape. The rail at the far left always shows
// the `sessions` and `reviews` icons at the top and the gear at the bottom; one side panel
// beside it shows one view at a time, or none. A click on an icon opens its view; a click on
// the active icon collapses the panel. The state is remembered per window in
// `sessionStorage`, as the focus record is (`focus.ts`): a reload keeps it and two windows
// keep their own.
import type { SessionView } from "@spinner/protocol";

import { needsHuman } from "./state.ts";

export type SidebarView = "sessions" | "prs" | "plans" | "reviews" | "settings";

export interface SidebarState {
    /** The view the side panel shows; null while the panel is collapsed. */
    view: SidebarView | null;
}

export const SIDEBAR_KEY = "spinner.sidebar.v2";

export const DEFAULT_SIDEBAR: SidebarState = { view: "sessions" };

const VIEWS: readonly SidebarView[] = ["sessions", "prs", "plans", "reviews", "settings"];

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

/**
 * The needs-you lines the operator has looked at, by session dir. A pick of a session marks
 * its current line seen; the badge counts a session again only when the line changes.
 */
export type Seen = Readonly<Record<string, string>>;

export const SEEN_KEY = "spinner.seen.v1";

/** The record with the session's current needs-you line marked seen; unchanged without one. */
export function markSeen(seen: Seen, dir: string, view: SessionView | undefined): Seen {
    const line = view === undefined ? null : needsHuman(view);
    if (line === null || seen[dir] === line) {
        return seen;
    }
    return { ...seen, [dir]: line };
}

/**
 * How many of `sessions` wait on the operator with a line the operator has not seen: the
 * rail badge. Without `seen`, every waiting session counts.
 */
export function needsCount(sessions: readonly [string, SessionView][], seen: Seen = {}): number {
    return sessions.filter(([dir, view]) => {
        const line = needsHuman(view);
        return line !== null && seen[dir] !== line;
    }).length;
}

export function loadSeen(storage: SidebarStorage | undefined): Seen {
    const raw = storage?.getItem(SEEN_KEY);
    if (raw === null || raw === undefined) {
        return {};
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return {};
        }
        const seen: Record<string, string> = {};
        for (const [dir, line] of Object.entries(parsed)) {
            if (typeof line === "string") {
                seen[dir] = line;
            }
        }
        return seen;
    } catch {
        return {};
    }
}

export function saveSeen(storage: SidebarStorage | undefined, seen: Seen): void {
    storage?.setItem(SEEN_KEY, JSON.stringify(seen));
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
