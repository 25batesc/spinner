// Goal: a drag, a click and the crop land on the same part of the page whatever the screen's
// density and the image's scale, and the lists show the right comments with the right
// labels. Method: plain inputs and outputs of the pure helpers.
import { describe, expect, it } from "vitest";
import type { Comment, PreviewAnchor } from "@spinner/protocol";
import {
    attachmentUrl,
    clampRect,
    defaultAgent,
    dragRect,
    imageRect,
    isDrag,
    openCommentsOn,
    sentNote,
    waitingLabel,
} from "./preview-comment.ts";

const anchor = (service: string): PreviewAnchor => ({
    kind: "preview",
    service,
    url: "http://a/",
    selector: null,
    text: null,
    component: null,
    source: null,
    rect: null,
    screenshot: null,
    console_errors: [],
});

function comment(id: string, overrides: Partial<Comment> = {}): Comment {
    return {
        id,
        agent: "lead",
        anchor: anchor("admin"),
        messages: [{ author: "operator", text: "x", created: "t" }],
        state: "open",
        waiting_on: "agent",
        created: `2026-11-09T16:00:0${id.slice(1)}Z`,
        updated: "t",
        ...overrides,
    };
}

describe("geometry", () => {
    it("tells a click from a drag and normalizes a drag in any direction", () => {
        expect(isDrag({ x: 10, y: 10 }, { x: 12, y: 13 })).toBe(false);
        expect(isDrag({ x: 10, y: 10 }, { x: 14, y: 10 })).toBe(true);
        expect(dragRect({ x: 50, y: 40 }, { x: 10, y: 60 })).toEqual({
            x: 10, y: 40, width: 40, height: 20,
        });
    });

    it("clamps to the viewport and drops a rect outside it", () => {
        expect(clampRect({ x: -5, y: 10, width: 20, height: 500 }, 100, 200)).toEqual({
            x: 0, y: 10, width: 15, height: 190,
        });
        expect(clampRect({ x: 120, y: 0, width: 10, height: 10 }, 100, 200)).toBeNull();
    });

    it("maps CSS pixels to the PNG's pixels at 2x and clamps to the image", () => {
        const capture = { width: 400, height: 300 };
        const natural = { width: 800, height: 600 };
        expect(imageRect({ x: 10, y: 20, width: 100, height: 50 }, capture, natural)).toEqual({
            x: 20, y: 40, width: 200, height: 100,
        });
        expect(imageRect({ x: 390, y: 290, width: 50, height: 50 }, capture, natural)).toEqual({
            x: 780, y: 580, width: 20, height: 20,
        });
        expect(imageRect({ x: 0, y: 0, width: 1, height: 1 }, { width: 0, height: 0 }, natural))
            .toBeNull();
    });
});

describe("choices", () => {
    it("defaults to the lead, else the first agent", () => {
        expect(defaultAgent(["ui", "lead"])).toBe("lead");
        expect(defaultAgent(["ui"])).toBe("ui");
        expect(defaultAgent([])).toBeUndefined();
    });

    it("lists the unresolved comments of one service, oldest first", () => {
        const comments = [
            comment("c3"),
            comment("c1"),
            comment("c2", { state: "resolved" }),
            comment("c4", { anchor: anchor("web") }),
        ];
        expect(openCommentsOn(comments, "admin").map((c) => c.id)).toEqual(["c1", "c3"]);
    });

    it("labels who answers next", () => {
        expect(waitingLabel(comment("c1"))).toBe("waits on lead");
        expect(waitingLabel(comment("c1", { waiting_on: "operator" }))).toBe("waits on you");
        expect(waitingLabel(comment("c1", { state: "suggested" }))).toBe("suggested: resolve?");
        expect(waitingLabel(comment("c1", { state: "resolved" }))).toBe("resolved");
    });

    it("builds the attachment URL and the sent note", () => {
        expect(attachmentUrl("s1-a", "artifacts/comments/shot-1.png")).toBe(
            "/sessions/s1-a/attachments/shot-1.png",
        );
        expect(attachmentUrl("s1-a", null)).toBeNull();
        expect(sentNote("c2", "lead", "started")).toBe("Comment c2 sent to lead.");
        expect(sentNote("c2", "lead", "stopped")).toMatch(/not running/);
    });
});
