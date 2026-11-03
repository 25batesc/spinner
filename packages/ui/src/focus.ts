// What the middle pane looks at, remembered across a reload of the window (s020). Before this
// record, no key held the selection: `spinner.layout.v2` holds geometry only, so a reload fell
// back to the first of every session sorted needs-you first, then newest. A review waiting on
// its draft sorts first, so a reload in a session view landed on a review.
//
// The record keeps one selection per list and the list that was active, and the load restores
// the three as one. A pick in one list never overwrites the other list's selection, so the two
// do not compete. The record lives in `sessionStorage`: it is per window, it survives a reload,
// and two windows do not overwrite each other's focus.
import type { SessionView } from "@spinner/protocol";

import { isReview } from "./review.ts";

/** The list whose selection the middle pane shows. */
export type FocusPanel = "sessions" | "reviews";

export interface Focus {
    panel: FocusPanel;
    /** The last session picked in the sessions list. */
    session: string | undefined;
    /** The last review picked in the reviews list. */
    review: string | undefined;
}

export const FOCUS_KEY = "spinner.focus.v1";

export const NO_FOCUS: Focus = { panel: "sessions", session: undefined, review: undefined };

/** The subset of `Storage` the record needs, so tests pass a plain object. */
export interface FocusStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

function dirOf(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
}

/** Reads the record; a missing, unreadable or partial record falls back field by field. */
export function loadFocus(storage: FocusStorage | undefined): Focus {
    let parsed: unknown;
    try {
        const raw = storage?.getItem(FOCUS_KEY);
        parsed = raw === null || raw === undefined ? undefined : JSON.parse(raw);
    } catch {
        parsed = undefined;
    }
    if (typeof parsed !== "object" || parsed === null) {
        return NO_FOCUS;
    }
    const record = parsed as Record<string, unknown>;
    return {
        panel: record["panel"] === "reviews" ? "reviews" : "sessions",
        session: dirOf(record["session"]),
        review: dirOf(record["review"]),
    };
}

/** Writes the record. A full or disabled storage is not an error. */
export function saveFocus(storage: FocusStorage | undefined, focus: Focus): void {
    try {
        storage?.setItem(FOCUS_KEY, JSON.stringify(focus));
    } catch {
        // Private mode or a full quota: the focus lasts for this page only.
    }
}

/** A pick in `panel`'s list: that list becomes active, the other list keeps its selection. */
export function pickFocus(focus: Focus, panel: FocusPanel, dir: string): Focus {
    if (panel === "reviews") {
        return { ...focus, panel, review: dir };
    }
    return { ...focus, panel, session: dir };
}

/** The panel a session belongs to: a review in the reviews list, else the sessions list. */
export function panelOf(view: SessionView | undefined): FocusPanel {
    return isReview(view) ? "reviews" : "sessions";
}

/**
 * The session the middle pane shows: the active list's selection while it exists; else the
 * first session of the active list's kind (`sessions` comes sorted); else, with that list
 * empty, the first session of the other list. The selection is not checked for its kind: a
 * pop-out window's `?pane=` route names its session before the views arrive.
 */
export function focusedDir(
    focus: Focus,
    sessions: [string, SessionView][],
): string | undefined {
    const wanted = focus.panel === "reviews" ? focus.review : focus.session;
    if (wanted !== undefined && sessions.some(([dir]) => dir === wanted)) {
        return wanted;
    }
    const own = sessions.find(([, view]) => panelOf(view) === focus.panel);
    return own?.[0] ?? sessions[0]?.[0];
}
