// Goal: pin the token rule of a Plan item's entry link. Method: parse and render tokens on
// both forms, and the texts that look like a token and are not one.
import { describe, expect, it } from "vitest";
import { is_entry_id, parse_entry_token, render_entry_token } from "./plan-entries.js";

describe("entry tokens", () => {
    it("parses and renders `[1.5] text`", () => {
        expect(parse_entry_token("[1.5] text")).toEqual({ entry: "1.5", rest: "text" });
        expect(render_entry_token("1.5", "text")).toBe("[1.5] text");
        expect(render_entry_token(null, "text")).toBe("text");
    });

    it("parses the legacy `plan 1.5: text` prefix", () => {
        expect(parse_entry_token("plan 1.5: text")).toEqual({ entry: "1.5", rest: "text" });
    });

    it("leaves `[D7] text`, a 17-character bracket and a bare token as plain text", () => {
        expect(parse_entry_token("[D7] fix the guard")).toEqual({
            entry: null,
            rest: "[D7] fix the guard",
        });
        const long = `[${"1".repeat(17)}] text`;
        expect(parse_entry_token(long)).toEqual({ entry: null, rest: long });
        expect(parse_entry_token(`[${"1".repeat(16)}] text`).entry).toBe("1".repeat(16));
        expect(parse_entry_token("[1.5]")).toEqual({ entry: null, rest: "[1.5]" });
    });

    it("validates an entry id", () => {
        expect(is_entry_id("3")).toBe(true);
        expect(is_entry_id("2.21")).toBe(true);
        expect(is_entry_id("")).toBe(false);
        expect(is_entry_id("x")).toBe(false);
        expect(is_entry_id("1".repeat(17))).toBe(false);
        expect(() => render_entry_token("x", "text")).toThrow("not an entry id");
    });
});
