// Goal: the texts an agent and the operator read about a preview comment carry the whole
// place, keep secrets out of URLs, and name the oldest comment waiting on the operator.
// Method: build comments by hand and check the helpers' output line by line.
import { describe, expect, it } from "vitest";
import {
    comment_prompt_text,
    comment_reply_text,
    comment_where,
    comments_needs_human,
    comments_waiting_on_operator,
    redact_url,
    type Comment,
    type PreviewAnchor,
} from "./comments.js";

const ANCHOR: PreviewAnchor = {
    kind: "preview",
    service: "admin",
    url: "http://admin.s17.localhost/refunds?tab=2",
    selector: "#queue > li:nth-of-type(2)",
    text: "Refund 41",
    component: "RefundRow",
    source: "src/RefundQueue.tsx:41:7",
    rect: { x: 10, y: 20, width: 300, height: 40 },
    screenshot: "artifacts/comments/shot-20261109-160000-abcdef.png",
    console_errors: ["TypeError: x is undefined\n    at RefundRow"],
};

function comment(overrides: Partial<Comment> = {}): Comment {
    return {
        id: "c3",
        agent: "lead",
        anchor: ANCHOR,
        messages: [{ author: "operator", text: "Make the amount bold.", created: "t1" }],
        state: "open",
        waiting_on: "agent",
        created: "2026-11-09T16:00:00.000Z",
        updated: "2026-11-09T16:00:00.000Z",
        ...overrides,
    };
}

describe("redact_url", () => {
    it("replaces secret-looking query values and keeps the rest", () => {
        const url = "http://a.localhost/x?tab=2&access_token=abc123&apiKey=k&code=9";
        const out = new URL(redact_url(url));
        expect(out.searchParams.get("tab")).toBe("2");
        expect(out.searchParams.get("access_token")).toBe("[redacted]");
        expect(out.searchParams.get("apiKey")).toBe("[redacted]");
        expect(out.searchParams.get("code")).toBe("[redacted]");
    });

    it("returns a URL without secrets, or one that does not parse, unchanged", () => {
        expect(redact_url("http://a.localhost/x?tab=2")).toBe("http://a.localhost/x?tab=2");
        expect(redact_url("not a url")).toBe("not a url");
    });
});

describe("comment_prompt_text", () => {
    it("carries the text, every part of the place, the screenshot and what to do", () => {
        const text = comment_prompt_text(comment(), "/s/artifacts/comments/shot.png");
        expect(text.split("\n")).toEqual([
            "Preview comment c3 from operator on admin /refunds?tab=2 · RefundRow:",
            "",
            "Make the amount bold.",
            "",
            "Where:",
            "- service: admin",
            "- url: http://admin.s17.localhost/refunds?tab=2",
            "- selector: #queue > li:nth-of-type(2)",
            '- element text: "Refund 41"',
            "- component: RefundRow",
            "- source: src/RefundQueue.tsx:41:7",
            "- area: x 10, y 20, 300×40 CSS px",
            "- screenshot: /s/artifacts/comments/shot.png (attached as an image)",
            "- console errors since the previous freeze (1):",
            "  - TypeError: x is undefined at RefundRow",
            "",
            "Answer with comment_reply c3. When the change is made, comment_suggest_resolve c3; " +
                "the operator resolves.",
        ]);
    });

    it("says the whole page and no errors for a page comment without a pick", () => {
        const anchor: PreviewAnchor = {
            ...ANCHOR,
            selector: null,
            text: null,
            component: null,
            source: null,
            rect: null,
            console_errors: [],
        };
        const text = comment_prompt_text(comment({ anchor }), null);
        expect(text).toContain("- area: the whole page");
        expect(text).toContain("- console errors since the previous freeze: none");
        expect(text).not.toContain("selector");
        expect(text).not.toContain("screenshot");
    });

    it("refuses a comment without a message", () => {
        expect(() => comment_prompt_text(comment({ messages: [] }), null)).toThrow(/no message/);
    });
});

describe("the operator's side", () => {
    it("names the reply's author and the tool to answer with", () => {
        const reply = { author: "operator", text: "Bolder.", created: "t2" };
        expect(comment_reply_text(comment(), reply)).toBe(
            "operator replied on preview comment c3 (admin /refunds?tab=2 · RefundRow):\n\n" +
                "Bolder.\n\nRead the thread with comments_list; answer with comment_reply c3.",
        );
    });

    it("lists only unresolved comments waiting on the operator, oldest first", () => {
        const comments = [
            comment({ id: "c5", waiting_on: "operator", created: "2026-11-09T17:00:00Z" }),
            comment({ id: "c4", waiting_on: "agent" }),
            comment({ id: "c2", waiting_on: "operator", state: "resolved" }),
            comment({ id: "c1", waiting_on: "operator", state: "suggested" }),
        ];
        expect(comments_waiting_on_operator(comments).map((c) => c.id)).toEqual(["c1", "c5"]);
    });

    it("names the oldest waiting comment and counts the rest", () => {
        const where = comment_where(ANCHOR);
        expect(comments_needs_human([{ id: "c1", where }])).toBe(
            "answer preview comment c1 on admin /refunds?tab=2 · RefundRow",
        );
        expect(comments_needs_human([{ id: "c1", where }, { id: "c5", where }])).toBe(
            "answer preview comment c1 on admin /refunds?tab=2 · RefundRow and 1 more",
        );
        expect(() => comments_needs_human([])).toThrow();
    });
});
