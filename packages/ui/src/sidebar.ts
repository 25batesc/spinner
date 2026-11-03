// The sidebar's sections (s020): the rail's `sessions` and `reviews` icons are the headers of
// an accordion in one column, and `settings` takes the column below the headers. Both
// sections may be open at once. The state is remembered per window in `sessionStorage`, as
// the focus record is (`focus.ts`): a reload keeps it and two windows keep their own.
import type { SessionView } from "@spinner/protocol";

import { needsHuman } from "./state.ts";

export type SectionId = "sessions" | "reviews";

export interface SidebarState {
    sessions: boolean;
    reviews: boolean;
    /** The settings view shows below the headers; the sections show closed meanwhile. */
    settings: boolean;
}

export const SIDEBAR_KEY = "spinner.sidebar.v1";

export const DEFAULT_SIDEBAR: SidebarState = { sessions: true, reviews: false, settings: false };

/** The subset of `Storage` the record needs, so tests pass a plain object. */
export interface SidebarStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

/** A header click: the section opens or closes; the settings view gives the column back. */
export function toggleSection(state: SidebarState, id: SectionId): SidebarState {
    if (state.settings) {
        return { ...state, settings: false, [id]: true };
    }
    return { ...state, [id]: !state[id] };
}

/** A rail click on a collapsed column: the column opens on that section, open. */
export function openSection(state: SidebarState, id: SectionId): SidebarState {
    return { ...state, settings: false, [id]: true };
}

export function setSettings(state: SidebarState, settings: boolean): SidebarState {
    return { ...state, settings };
}

/** True when the section's list shows: open, and the settings view is not on. */
export function sectionOpen(state: SidebarState, id: SectionId): boolean {
    return state[id] && !state.settings;
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

/** How many of `sessions` wait on the operator: the badge on a header and on the rail. */
export function needsCount(sessions: readonly [string, SessionView][]): number {
    return sessions.filter(([, view]) => needsHuman(view) !== null).length;
}

/** Reads the record; a missing, unreadable or partial record falls back field by field. */
export function loadSidebar(storage: SidebarStorage | undefined): SidebarState {
    let parsed: unknown;
    try {
        const raw = storage?.getItem(SIDEBAR_KEY);
        parsed = raw === null || raw === undefined ? undefined : JSON.parse(raw);
    } catch {
        parsed = undefined;
    }
    if (typeof parsed !== "object" || parsed === null) {
        return DEFAULT_SIDEBAR;
    }
    const record = parsed as Record<string, unknown>;
    const flag = (key: keyof SidebarState) =>
        typeof record[key] === "boolean" ? (record[key] as boolean) : DEFAULT_SIDEBAR[key];
    return { sessions: flag("sessions"), reviews: flag("reviews"), settings: flag("settings") };
}

/** Writes the record. A full or disabled storage is not an error. */
export function saveSidebar(storage: SidebarStorage | undefined, state: SidebarState): void {
    try {
        storage?.setItem(SIDEBAR_KEY, JSON.stringify(state));
    } catch {
        // Private mode or a full quota: the sections last for this page only.
    }
}
