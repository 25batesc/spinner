// Goal: pin the text the daemon sends an agent for a diff comment and the `needs_human` line
// the operator reads, so the daemon, the extension and the UI agree on one wording.
// Method: format notices for each anchor kind and check the exact strings.
import { describe, expect, it } from "vitest";
import {
    DIFF_NOTICE_TEXT_CHARS,
    diff_needs_human,
    diff_notice_text,
    diff_notice_where,
    type DiffNotice,
} from "./diff.js";

const on_lines: DiffNotice = {
    repo: "backend",
    thread: 12,
    status: "open",
    path: "src/app.ts",
    start_line: 40,
    end_line: 42,
    author: "cullen",
    text: "Why does this\n  swallow the error?",
};

describe("diff_notice_where", () => {
    it("names lines, a whole file and a whole branch", () => {
        expect(diff_notice_where(on_lines)).toBe("backend src/app.ts:40-42");
        expect(diff_notice_where({ ...on_lines, end_line: 40 })).toBe("backend src/app.ts:40");
        expect(diff_notice_where({ ...on_lines, start_line: null, end_line: null })).toBe(
            "backend src/app.ts (whole file)",
        );
        const branch = { ...on_lines, path: null, start_line: null, end_line: null };
        expect(diff_notice_where(branch)).toBe("backend (whole branch)");
    });
});

describe("diff_notice_text", () => {
    it("is three lines: where, who said what, what to do", () => {
        expect(diff_notice_text(on_lines)).toBe(
            "diff comment #12 on backend src/app.ts:40-42 waits on you.\n" +
                "cullen: Why does this swallow the error?\n" +
                "Read it with diff_comments show 12; answer with diff_reply.",
        );
    });

    it("cuts a long text", () => {
        const lines = diff_notice_text({ ...on_lines, text: "x".repeat(500) }).split("\n");
        expect(lines[1]).toHaveLength("cullen: ".length + DIFF_NOTICE_TEXT_CHARS);
        expect(lines[1]?.endsWith("…")).toBe(true);
    });
});

describe("diff_needs_human", () => {
    it("names the oldest thread and counts the rest", () => {
        expect(diff_needs_human(1, on_lines)).toBe(
            "answer diff comment #12 on backend src/app.ts:40-42",
        );
        expect(diff_needs_human(3, on_lines)).toBe(
            "answer diff comment #12 on backend src/app.ts:40-42 and 2 more",
        );
    });
});
