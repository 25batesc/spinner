// The Plans view's pure half: the status line, the targets of `Implement` and its body.
import { describe, expect, it } from "vitest";
import type { PlanView, SessionView } from "@spinner/protocol";

import {
    canImplement,
    implementBody,
    implementTargets,
    liveImplementations,
    planStatusText,
    planTone,
} from "./plans.ts";

function plan(over: Partial<PlanView>): PlanView {
    return {
        id: "s9-exports", title: "Exports", created: "2026-11-12T09:00:00Z",
        updated: "2026-11-12T09:00:00Z", project: null, doc: "exports.md", origin: null,
        implementations: [], status: "drafted", entries: 7, done: 0, session: null,
        sessions: [],
        ...over,
    };
}

function view(kind: string, id: string, title: string): SessionView {
    return { kind, summary: { session: { id, title } } } as unknown as SessionView;
}

describe("the Plans view", () => {
    it("says the status of a plan in a few words", () => {
        expect(planStatusText(plan({ status: "draft", entries: 0 }))).toBe("draft");
        expect(planStatusText(plan({}))).toBe("drafted · 7 steps");
        expect(planStatusText(plan({ status: "reviewed", entries: 1 }))).toBe("reviewed · 1 step");
        expect(planStatusText(plan({ status: "implementing", done: 3 }))).toBe("implementing 3/7");
        expect(planStatusText(plan({ status: "done", done: 7 }))).toBe("done · 7 steps");
        expect(planTone(plan({ status: "implementing" }))).toBe("warn");
        expect(canImplement(plan({ entries: 0 }))).toBe(false);
        expect(canImplement(plan({}))).toBe(true);
    });

    it("offers a new session and the live code sessions as targets", () => {
        const targets = implementTargets([
            ["s8-a", view("session", "s8", "Billing")],
            ["s7-r", view("review", "s7", "A peer's PR")],
            ["s6-p", view("plan", "s6", "A plan")],
        ]);
        expect(targets).toEqual([{ dir: "s8-a", label: "s8 · Billing" }]);
        expect(implementBody("")).toEqual({});
        expect(implementBody("s8-a")).toEqual({ session: "s8-a" });
    });

    it("links the live sessions that implement a plan", () => {
        const sessions = [
            { session: "s8-a", live: true, title: "Billing", done: 1, entries: 7 },
            { session: "s2-old", live: false, title: null, done: 7, entries: 7 },
        ];
        expect(liveImplementations(plan({ sessions }))).toEqual(["s8-a"]);
    });
});
