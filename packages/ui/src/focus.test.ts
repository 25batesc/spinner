// The focus record (s020): a reload restores the active list and its selection as one, and a
// pick in one list leaves the other list's selection alone. The tests use the fixture's
// sessions and reviews, sorted as the App sorts them, so the review that waits on its draft
// sorts first, which is the order that made a reload land on a review before the record.
import { describe, expect, it } from "vitest";

import { initialReviews, initialSessions } from "../fixture/data.ts";
import {
    activatePanel,
    FOCUS_KEY,
    focusedDir,
    loadFocus,
    NO_FOCUS,
    pickFocus,
    saveFocus,
    type FocusStorage,
} from "./focus.ts";
import { initialState, reduce, sortedSessions } from "./state.ts";

function memory(initial: Record<string, string> = {}): FocusStorage & { store: typeof initial } {
    const store = { ...initial };
    return {
        store,
        getItem: (key) => store[key] ?? null,
        setItem: (key, value) => {
            store[key] = value;
        },
    };
}

const all = [...initialSessions(), ...initialReviews()];
const sorted = sortedSessions(reduce(initialState, { kind: "snapshot", sessions: all }));
const firstReview = initialReviews()[0]?.summary.dir ?? "";
const secondReview = initialReviews()[1]?.summary.dir ?? "";

describe("focusedDir", () => {
    it("starts on the first ordinary session, not on the review that sorts first", () => {
        expect(sorted[0]?.[1].kind).toBe("review");
        const dir = focusedDir(NO_FOCUS, sorted);
        expect(dir).toBeDefined();
        expect(dir?.startsWith("r")).toBe(false);
    });

    it("shows the session picked last after a review was picked before it", () => {
        let focus = pickFocus(NO_FOCUS, "reviews", firstReview);
        focus = pickFocus(focus, "sessions", "s001-bootstrap");
        expect(focus).toEqual({
            panel: "sessions", session: "s001-bootstrap", review: firstReview,
        });
        expect(focusedDir(focus, sorted)).toBe("s001-bootstrap");
    });

    it("shows the review picked last and keeps the session for the way back", () => {
        let focus = pickFocus(NO_FOCUS, "sessions", "s001-bootstrap");
        focus = pickFocus(focus, "reviews", secondReview);
        expect(focusedDir(focus, sorted)).toBe(secondReview);
        expect(focusedDir({ ...focus, panel: "sessions" }, sorted)).toBe("s001-bootstrap");
    });

    it("falls back inside the active list when its selection is gone", () => {
        const gone = { panel: "sessions" as const, session: "s999-gone", review: firstReview };
        expect(focusedDir(gone, sorted)?.startsWith("s")).toBe(true);
        const goneReview = { panel: "reviews" as const, session: undefined, review: "r0-gone" };
        expect(focusedDir(goneReview, sorted)?.startsWith("r")).toBe(true);
    });

    it("falls back to the other list when the active list is empty, and to none at all", () => {
        const reviewsOnly = sorted.filter(([, view]) => view.kind === "review");
        expect(focusedDir(NO_FOCUS, reviewsOnly)).toBe(reviewsOnly[0]?.[0]);
        expect(focusedDir(NO_FOCUS, [])).toBeUndefined();
    });
});

describe("loadFocus and saveFocus", () => {
    it("round-trips the record through storage", () => {
        const storage = memory();
        const focus = { panel: "reviews" as const, session: "s001-bootstrap", review: firstReview };
        saveFocus(storage, focus);
        expect(Object.keys(storage.store)).toEqual([FOCUS_KEY]);
        expect(loadFocus(storage)).toEqual(focus);
    });

    it("falls back field by field from a missing, broken or partial record", () => {
        expect(loadFocus(undefined)).toEqual(NO_FOCUS);
        expect(loadFocus(memory())).toEqual(NO_FOCUS);
        expect(loadFocus(memory({ [FOCUS_KEY]: "{not json" }))).toEqual(NO_FOCUS);
        const partial = memory({ [FOCUS_KEY]: JSON.stringify({ panel: "x", review: 7 }) });
        expect(loadFocus(partial)).toEqual(NO_FOCUS);
        const half = memory({ [FOCUS_KEY]: JSON.stringify({ session: "s001-bootstrap" }) });
        expect(loadFocus(half)).toEqual({ ...NO_FOCUS, session: "s001-bootstrap" });
    });

    it("does not throw when the storage refuses the write", () => {
        const full: FocusStorage = {
            getItem: () => null,
            setItem: () => {
                throw new Error("quota");
            },
        };
        expect(() => saveFocus(full, NO_FOCUS)).not.toThrow();
    });
});

describe("activatePanel", () => {
    it("makes the rail's list the active one and keeps both selections", () => {
        const focus = { panel: "sessions" as const, session: "s001", review: "r051" };
        const reviews = activatePanel(focus, "reviews");
        expect(reviews).toEqual({ panel: "reviews", session: "s001", review: "r051" });
        expect(activatePanel(reviews, "reviews")).toBe(reviews);
        expect(activatePanel(reviews, "sessions").panel).toBe("sessions");
    });
});
