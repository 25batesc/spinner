// Goal: the seed of docs/designs/session-workspace.md T4 adds one Plan item per doc entry
// with owner null and the entry token, is idempotent, detects a renumbered or trimmed doc
// without rewriting a token, keeps every tick, and refuses through `seed_checks` the docs it
// cannot honour. Method: pure calls over small docs built here and the real
// `docs/designs/egm-adoption.md` (166 entries), with the output re-parsed by `mission_view`.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scan } from "@spinner/protocol";
import { mission_section, mission_view } from "../pipeline/mission-sections.js";
import { render_mission } from "../store/mission-template.js";
import { seed_checks, seed_log_line, seed_plan } from "./seed-plan.js";

const here = dirname(fileURLToPath(import.meta.url));
const EGM_ADOPTION = readFileSync(
    resolve(here, "..", "..", "..", "..", "docs", "designs", "egm-adoption.md"),
    "utf8",
);

/** A doc with 3 phases and 23 entries, `1.1` to `1.9`, `2.1` to `2.8`, `3.1` to `3.6`. */
function doc(sizes: number[] = [9, 8, 6], renumber: Record<string, string> = {}): string {
    const lines = ["# Design", "", "## Overview", "", "Text.", ""];
    lines.push("## Detailed Implementation Plan");
    for (const [index, size] of sizes.entries()) {
        const phase = index + 1;
        lines.push("", `#### Build session ${phase}: phase ${phase}`);
        for (let n = 1; n <= size; n += 1) {
            const id = `${phase}.${n}`;
            lines.push("", `##### ${id} \`src/${renumber[id] ?? id}.ts\` (Modify)`);
        }
    }
    return `${lines.join("\n")}\n`;
}

const BASE = render_mission({ id: "s9", title: "Seed", time: "09:00" });

/** A mission whose Plan is the given lines. */
function mission(plan: string[]): string {
    return BASE.replace(/## Plan\n[\s\S]*?\n\n/, `## Plan\n${plan.join("\n")}\n\n`);
}

describe("seed_plan", () => {
    it("seeds 23 entries into an empty Plan with owner null and the token", () => {
        const result = seed_plan(BASE, scan(doc()));
        expect(result).toMatchObject({ added: 23, kept: 0, stale: [], orphaned: [] });
        const plan = mission_view(result.mission_text).plan;
        expect(plan).toHaveLength(23);
        expect(plan[0]).toMatchObject({ id: 1, entry: "1.1", text: "`src/1.1.ts`", owner: null });
        expect(plan[22]).toMatchObject({ id: 23, entry: "3.6", owner: null, state: "next" });
        expect(mission_section(result.mission_text, "Plan").split("\n")[0]).toBe(
            "- [ ] 1. [1.1] `src/1.1.ts`",
        );
        // The template placeholder is gone.
        expect(result.mission_text).not.toContain("- [ ] 1. \n");
    });

    it("continues the ids after free items and keeps them", () => {
        const text = mission(["- [ ] 1. free one (lead)", "- [x] 2. free two (lead, 09:30)"]);
        const result = seed_plan(text, scan(doc()));
        expect(result).toMatchObject({ added: 23, kept: 2 });
        const plan = mission_view(result.mission_text).plan;
        expect(plan.map((item) => item.id).slice(0, 4)).toEqual([1, 2, 3, 4]);
        expect(plan[1]).toMatchObject({ state: "done", ticked_at: "09:30", entry: null });
        expect(plan[2]).toMatchObject({ entry: "1.1", owner: null });
    });

    it("adds nothing on a second run", () => {
        const first = seed_plan(BASE, scan(doc()));
        const second = seed_plan(first.mission_text, scan(doc()));
        expect(second).toMatchObject({ added: 0, kept: 23, stale: [], orphaned: [] });
        expect(mission_section(second.mission_text, "Plan")).toBe(
            mission_section(first.mission_text, "Plan"),
        );
    });

    it("marks shifted items stale after a renumbering and adds the new last entry", () => {
        // 2.3 is split into 2.3 and 2.4, so the old 2.4 to 2.8 become 2.5 to 2.9.
        const first = seed_plan(BASE, scan(doc()));
        const renumber: Record<string, string> = { "2.4": "2.3b" };
        for (let n = 5; n <= 9; n += 1) {
            renumber[`2.${n}`] = `2.${n - 1}`;
        }
        const changed = scan(doc([9, 9, 6], renumber));
        const second = seed_plan(first.mission_text, changed);
        expect(second.stale).toEqual(["2.4", "2.5", "2.6", "2.7", "2.8"]);
        expect(second).toMatchObject({ added: 1, kept: 18, orphaned: [] });
        const plan = mission_view(second.mission_text).plan;
        expect(plan[23]).toMatchObject({ id: 24, entry: "2.9", text: "`src/2.8.ts`" });
        // No token was rewritten.
        expect(plan[12]).toMatchObject({ id: 13, entry: "2.4", text: "`src/2.4.ts`" });
    });

    it("is not confused by five entries that share a title", () => {
        const same = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`1.${n}`, "same"]));
        const first = seed_plan(BASE, scan(doc([5], same)));
        const second = seed_plan(first.mission_text, scan(doc([5], same)));
        expect(second).toMatchObject({ added: 0, kept: 5, stale: [] });
    });

    it("keeps an item whose entry left the doc and reports it orphaned", () => {
        const first = seed_plan(BASE, scan(doc([3])));
        const second = seed_plan(first.mission_text, scan(doc([2])));
        expect(second).toMatchObject({ added: 0, kept: 2, orphaned: ["1.3"] });
        expect(mission_view(second.mission_text).plan).toHaveLength(3);
    });

    it("does not read a split item with its own text as stale (CUJ 4)", () => {
        const first = seed_plan(BASE, scan(doc([3])));
        const split = first.mission_text.replace(
            "- [ ] 3. [1.3] `src/1.3.ts`",
            "- [ ] 3. [1.3] `src/1.3.ts`\n- [ ] 4. [1.3] the tests (lead)",
        );
        const second = seed_plan(split, scan(doc([3])));
        expect(second).toMatchObject({ added: 0, kept: 4, stale: [] });
    });

    it("seeds the 166 entries of egm-adoption.md, owner null on every line, under 500 ms", () => {
        const started = performance.now();
        const parsed = scan(EGM_ADOPTION);
        const result = seed_plan(BASE, parsed);
        expect(performance.now() - started).toBeLessThan(500);
        expect(result.added).toBe(166);
        const plan = mission_view(result.mission_text).plan;
        expect(plan).toHaveLength(166);
        expect(plan.every((item) => item.owner === null && item.entry !== null)).toBe(true);
        const by_entry = new Map(plan.map((item) => [item.entry, item]));
        expect(by_entry.get("1.25")?.text).toBe("`packages/pi-extension/src/tty.ts`");
        expect(by_entry.get("1.34")?.text).toBe(
            "`docs/designs/SITEMAP.md` and `docs/designs/egm-adoption.md`",
        );
        expect(by_entry.get("3.12")?.text.endsWith("`review-runs.test.ts`")).toBe(true);
    });

    it("seeds a flat doc under no phase", () => {
        const flat = "## Detailed Implementation Plan\n\n#### 1. `a.ts` (Create)\n\n#### 2. `b.ts`";
        const parsed = scan(flat);
        expect(parsed.phases).toEqual([]);
        const plan = mission_view(seed_plan(BASE, parsed).mission_text).plan;
        expect(plan.map((item) => [item.entry, item.text])).toEqual([
            ["1", "`a.ts`"],
            ["2", "`b.ts`"],
        ]);
    });

    it("turns a legacy `plan 1.5:` line into the token and keeps its tick and owner", () => {
        const text = mission([
            "- [x] 1. plan 1.1: `src/1.1.ts` (engine, 09:30)",
            "- [ ] 2. plan 1.2: `src/1.2.ts` (ui)",
        ]);
        const result = seed_plan(text, scan(doc([3])));
        expect(result).toMatchObject({ added: 1, kept: 2 });
        expect(mission_section(result.mission_text, "Plan")).toBe(
            [
                "- [x] 1. [1.1] `src/1.1.ts` (engine, 09:30)",
                "- [ ] 2. [1.2] `src/1.2.ts` (ui)",
                "- [ ] 3. [1.3] `src/1.3.ts`",
            ].join("\n"),
        );
    });

    it("keeps a note under an item in place", () => {
        const text = mission(["- [ ] 1. [1.1] `src/1.1.ts` (lead)", "  a note under the item"]);
        const result = seed_plan(text, scan(doc([2])));
        expect(mission_section(result.mission_text, "Plan")).toBe(
            [
                "- [ ] 1. [1.1] `src/1.1.ts` (lead)",
                "  a note under the item",
                "- [ ] 2. [1.2] `src/1.2.ts`",
            ].join("\n"),
        );
    });
});

describe("seed_checks", () => {
    it("refuses duplicates, empty titles, no entries, and a Plan past ITEMS_MAX", () => {
        const dup = scan(doc().replace("##### 1.2 ", "##### 1.1 "));
        expect(seed_checks(BASE, dup)).toBe("the plan has duplicate entry ids: 1.1");
        const empty = scan(doc().replace("##### 1.2 `src/1.2.ts` (Modify)", "##### 1.2 (Modify)"));
        expect(seed_checks(BASE, empty)).toBe("entries without a title: 1.2");
        expect(seed_checks(BASE, scan("# nothing\n"))).toBe(
            "no plan entries found under an Implementation Plan heading",
        );
        const big = scan(doc([250, 250]));
        expect(seed_checks(BASE, big)).toBeNull();
        const full = mission(["- [ ] 1. free (lead)"]);
        expect(seed_checks(full, big)).toBe("the Plan would hold 501 items; the bound is 500");
        expect(seed_checks(BASE, scan(doc()))).toBeNull();
        expect(() => seed_plan(BASE, dup)).toThrow(/seed_checks/);
    });

    it("counts an existing linked item as covering its entry", () => {
        const seeded = seed_plan(BASE, scan(doc([250, 250]))).mission_text;
        expect(seed_checks(seeded, scan(doc([250, 250])))).toBeNull();
    });
});

describe("seed_log_line", () => {
    it("names the counts and the ids of stale and orphaned entries", () => {
        const base = { doc_path: "docs/designs/x.md", sha12: "a1b2c3d4e5f6" };
        const none = { ...base, added: 23, kept: 2, stale: [], orphaned: [] };
        expect(seed_log_line(base.doc_path, none)).toBe(
            "plan seeded from docs/designs/x.md (a1b2c3d4e5f6): " +
                "23 added, 2 kept, 0 stale, 0 orphaned",
        );
        expect(
            seed_log_line(base.doc_path, {
                ...base,
                added: 1,
                kept: 23,
                stale: ["2.4", "2.5"],
                orphaned: ["3.9"],
            }),
        ).toBe(
            "plan seeded from docs/designs/x.md (a1b2c3d4e5f6): " +
                "1 added, 23 kept, 2 stale: 2.4, 2.5, 1 orphaned: 3.9",
        );
    });
});
