// The per-session memory of the previews pane's tabs. Method: an in-memory storage, a save, a
// load from a second "window" over the same storage, bad JSON, and the size bound.
import { describe, expect, it } from "vitest";
import {
    loadPreviewChoice,
    PREVIEW_CHOICE_KEY,
    PREVIEW_CHOICE_SESSIONS_MAX,
    savePreviewChoice,
    type ChoiceStorage,
} from "./preview-choice.ts";

function memory(): ChoiceStorage & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
        map,
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => void map.set(key, value),
    };
}

describe("preview choice", () => {
    it("remembers tab, service and repo per session, and a second page reads them", () => {
        const storage = memory();
        savePreviewChoice(storage, "s1-a", { tab: "diff" });
        savePreviewChoice(storage, "s1-a", { service: "web" });
        savePreviewChoice(storage, "s2-b", { repo: "api" });
        expect(loadPreviewChoice(storage, "s1-a")).toEqual({ tab: "diff", service: "web" });
        expect(loadPreviewChoice(storage, "s2-b")).toEqual({ repo: "api" });
        expect(loadPreviewChoice(storage, "s3-c")).toEqual({});
        expect(loadPreviewChoice(undefined, "s1-a")).toEqual({});
    });

    it("survives bad JSON and keeps at most the newest sessions", () => {
        const storage = memory();
        storage.map.set(PREVIEW_CHOICE_KEY, "{not json");
        expect(loadPreviewChoice(storage, "s1-a")).toEqual({});
        for (let i = 0; i < PREVIEW_CHOICE_SESSIONS_MAX + 5; i += 1) {
            savePreviewChoice(storage, `s${i}`, { tab: "previews" });
        }
        const kept = Object.keys(JSON.parse(storage.map.get(PREVIEW_CHOICE_KEY) ?? "{}"));
        expect(kept).toHaveLength(PREVIEW_CHOICE_SESSIONS_MAX);
        expect(kept).toContain(`s${PREVIEW_CHOICE_SESSIONS_MAX + 4}`);
        expect(kept).not.toContain("s0");
    });
});
