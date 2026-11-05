// Goal: pin the entry grammar of docs/designs/session-workspace.md T2 and the token rule of
// T3, so the daemon's seed and the UI's grouping read the same entries from a doc.
// Method: scan the real `docs/designs/egm-adoption.md` (the large fixture) and small docs
// built here for each rule; parse and render tokens on both forms.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    DOC_LINES_MAX,
    ENTRIES_MAX,
    headings,
    is_entry_id,
    parse_entry_heading,
    parse_entry_token,
    render_entry_token,
    scan,
} from "./plan-entries.js";

const here = dirname(fileURLToPath(import.meta.url));
const EGM_ADOPTION = readFileSync(
    join(here, "..", "..", "..", "docs", "designs", "egm-adoption.md"),
    "utf8",
);

/** A doc with one plan section whose body is `plan`, under the given heading. */
function doc(plan: string, heading = "## Detailed Implementation Plan"): string {
    return ["# A design", "", "## Overview", "", "Text.", "", heading, "", plan, ""].join("\n");
}

describe("headings", () => {
    it("walks every heading outside a fence, with 1-based lines", () => {
        const text = ["# T", "", "```", "## fenced", "```", "", "### real", "~~~~", "## x", "~~~"]
            .join("\n");
        expect(headings(text, 100)).toEqual([
            { level: 1, text: "T", line: 1 },
            { level: 3, text: "real", line: 7 },
        ]);
    });

    it("closes a fence only with the same character at the same or greater length", () => {
        const text = ["````", "## in", "```", "## still in", "````", "## out"].join("\n");
        expect(headings(text, 100).map((heading) => heading.text)).toEqual(["out"]);
    });

    it("throws past the line bound", () => {
        expect(() => headings("a\nb\nc", 2)).toThrow("more than 2 lines");
        expect(() => headings("a\nb", 2)).not.toThrow();
    });
});

describe("scan on egm-adoption.md", () => {
    const result = scan(EGM_ADOPTION);

    it("finds 6 phases and 166 entries, first 1.1 and last 6.23", () => {
        expect(result.phases.map((phase) => phase.number)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(result.phases[0]?.title).toBe(
            "`egm-adapter`, the harness adapter and its evidence probes",
        );
        expect(result.entries).toHaveLength(166);
        expect(result.entries[0]?.id).toBe("1.1");
        expect(result.entries[165]?.id).toBe("6.23");
        expect(result.entries.every((entry) => entry.phase !== null)).toBe(true);
        expect(result.duplicates).toEqual([]);
        expect(result.empty_titles).toEqual([]);
    });

    it("strips a trailing parenthetical whatever it holds (1.25, 1.34, 3.12)", () => {
        const by_id = new Map(result.entries.map((entry) => [entry.id, entry]));
        expect(by_id.get("1.25")).toMatchObject({
            title: "`packages/pi-extension/src/tty.ts`",
            kind: "Modify",
            phase: 1,
        });
        expect(by_id.get("1.34")).toMatchObject({
            title: "`docs/designs/SITEMAP.md` and `docs/designs/egm-adoption.md`",
            kind: "Create",
        });
        expect(by_id.get("3.12")).toMatchObject({ kind: "Modify", phase: 3 });
        expect(by_id.get("3.12")?.title.endsWith("`review-runs.test.ts`")).toBe(true);
    });

    it("scans 2 100 lines well under the bound", () => {
        expect(EGM_ADOPTION.split("\n").length).toBeLessThan(DOC_LINES_MAX);
    });
});

describe("scan rules", () => {
    it("reads EGM's flat `#### 1.` layout with no phase", () => {
        const plan = ["#### 1. `src/a.ts` (Create)", "", "#### 2. `src/b.ts`"].join("\n");
        const result = scan(doc(plan));
        expect(result.phases).toEqual([]);
        expect(result.entries).toEqual([
            { id: "1", phase: null, title: "`src/a.ts`", kind: "Create", line: 9 },
            { id: "2", phase: null, title: "`src/b.ts`", kind: null, line: 11 },
        ]);
    });

    it("accepts the `## Implementation Plan` synonym and stops at the next `## `", () => {
        const synonym = doc("##### 1.1 one", "## Implementation Plan");
        const text = `${synonym}\n## Notes\n\n##### 1.2 two\n`;
        expect(scan(text).entries.map((entry) => entry.id)).toEqual(["1.1"]);
    });

    it("gives a phase with an empty title and reads an entry under it", () => {
        const result = scan(doc(["#### Build session 2", "", "##### 2.1 x"].join("\n")));
        expect(result.phases).toEqual([{ number: 2, title: "", line: 9 }]);
        expect(result.entries[0]).toMatchObject({ id: "2.1", phase: 2, title: "x" });
    });

    it("does not count a heading inside a code fence", () => {
        const plan = ["##### 1.1 real", "", "```md", "##### 1.2 fenced", "```"].join("\n");
        expect(scan(doc(plan)).entries.map((entry) => entry.id)).toEqual(["1.1"]);
    });

    it("keeps both paths of a two-path heading and the backticks", () => {
        const result = scan(doc("##### 2.3 `a.ts`, `b.ts` (Modify)"));
        expect(result.entries[0]).toMatchObject({ title: "`a.ts`, `b.ts`", kind: "Modify" });
    });

    it("strips a `**[D7]**` tag before the parenthetical", () => {
        const result = scan(doc("##### 2.4 `c.ts` (Modify) **[D7]**"));
        expect(result.entries[0]).toMatchObject({ title: "`c.ts`", kind: "Modify" });
    });

    it("reports a title that strips to empty", () => {
        const result = scan(doc("##### 2.5 (Modify)"));
        expect(result.entries[0]).toMatchObject({ id: "2.5", title: "", kind: "Modify" });
        expect(result.empty_titles).toEqual(["2.5"]);
    });

    it("keeps the first of a duplicate id and reports the second", () => {
        const result = scan(doc(["##### 2.3 first", "", "##### 2.3 second"].join("\n")));
        expect(result.entries.map((entry) => entry.title)).toEqual(["first"]);
        expect(result.duplicates).toEqual(["2.3"]);
    });

    it("finds nothing without a plan section", () => {
        const result = scan("# A design\n\n## Overview\n\n##### 1.1 not a plan\n");
        expect(result).toEqual({ phases: [], entries: [], duplicates: [], empty_titles: [] });
    });

    it("throws past the entry bound", () => {
        const lines: string[] = [];
        for (let index = 1; index <= ENTRIES_MAX + 1; index += 1) {
            lines.push(`##### 1.${index} entry`);
        }
        expect(() => scan(doc(lines.join("\n\n")))).toThrow(`more than ${ENTRIES_MAX} entries`);
        expect(scan(doc(lines.slice(0, ENTRIES_MAX).join("\n\n"))).entries).toHaveLength(500);
    });

    it("ignores `### ` and `#### ` headings that are not phases or entries", () => {
        const plan = ["### Target Files", "", "#### Verification", "", "##### 1.1 x"].join("\n");
        expect(scan(doc(plan)).entries).toHaveLength(1);
        expect(scan(doc(plan)).phases).toHaveLength(0);
    });
});

describe("parse_entry_heading", () => {
    it("reads a kind only from the four words", () => {
        expect(parse_entry_heading("1.2 `a.ts` (Delete)")?.kind).toBe("Delete");
        expect(parse_entry_heading("1.2 `a.ts` (Remove)")?.kind).toBe("Remove");
        expect(parse_entry_heading("1.2 `a.ts` (No change)")).toMatchObject({
            title: "`a.ts`",
            kind: null,
        });
        expect(parse_entry_heading("1.2 `a.ts` (Modify / Create)")?.kind).toBe("Modify");
    });

    it("strips a nested trailing parenthetical whole", () => {
        expect(parse_entry_heading("1.2 `a.ts` (Modify (see T2))")).toMatchObject({
            title: "`a.ts`",
            kind: "Modify",
        });
    });

    it("returns null for a heading without an id", () => {
        expect(parse_entry_heading("Build session 1")).toBeNull();
        expect(parse_entry_heading("Overview")).toBeNull();
    });
});

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
