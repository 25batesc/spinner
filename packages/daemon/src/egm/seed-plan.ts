// The seed (docs/designs/session-workspace.md, T4, D10, D11): at approval the daemon writes
// one MISSION.md Plan item per entry of the doc's Detailed Implementation Plan, owner null,
// linked by the `[n.n]` token. Two pure halves: `seed_checks` runs before the approval record
// and gives the refusal reason, so no approval stands that the seed cannot honour; `seed_plan`
// runs after the record through `MissionWriter.rewrite`. A second run adds only the entries
// that have no item, and marks an item `stale` (its entry's title changed) or `orphaned`
// (its entry left the doc) without rewriting any token: it detects a renumbered doc, it does
// not guess.
import assert from "node:assert/strict";
import type { PlanScan, SeedResult } from "@spinner/protocol";
import {
    ITEMS_MAX,
    join_mission,
    parse_item,
    render_item,
    section_items,
    split_mission,
    with_ids,
    type MissionBlock,
    type MissionItem,
} from "../pipeline/mission-sections.js";
import { PLAN_PLACEHOLDER, SECTION_HEADINGS, write_items } from "../store/mission-writer.js";

/** The counts of one seed run; `approve_design` adds the doc path and hash for `SeedResult`. */
export type SeedCounts = Pick<SeedResult, "added" | "kept" | "stale" | "orphaned">;

/** The Plan section's lines and items, the template placeholder left out. */
interface PlanSection {
    block: MissionBlock;
    lines: string[];
    found: { line: number; item: MissionItem }[];
    items: (MissionItem & { id: number })[];
}

/**
 * The reason the seed cannot honour the doc, or null (T4): duplicate ids, empty titles, no
 * entries, or a Plan that would exceed `ITEMS_MAX` once every entry without an item is added.
 */
export function seed_checks(mission_text: string, scan: PlanScan): string | null {
    if (scan.duplicates.length > 0) {
        return `the plan has duplicate entry ids: ${scan.duplicates.join(", ")}`;
    }
    if (scan.empty_titles.length > 0) {
        return `entries without a title: ${scan.empty_titles.join(", ")}`;
    }
    if (scan.entries.length === 0) {
        return "no plan entries found under an Implementation Plan heading";
    }
    const { items } = plan_section(split_mission(mission_text));
    const linked = new Set(items.map((item) => item.entry));
    const missing = scan.entries.filter((entry) => !linked.has(entry.id)).length;
    const total = items.length + missing;
    if (total > ITEMS_MAX) {
        return `the Plan would hold ${total} items; the bound is ${ITEMS_MAX}`;
    }
    return null;
}

/**
 * T4 steps 1 to 5 over the mission text: appends one item per entry without one, in doc
 * order after the existing items, owner null; counts the rest kept, stale or orphaned. Every
 * Plan item is rendered through `render_item`, so a legacy `plan n.n:` prefix becomes the
 * token and the placeholder goes. Nothing is deleted; no tick changes.
 */
export function seed_plan(
    mission_text: string,
    scan: PlanScan,
): SeedCounts & { mission_text: string } {
    assert.equal(seed_checks(mission_text, scan), null, "seed_checks must pass first");
    const blocks = split_mission(mission_text);
    const section = plan_section(blocks);
    const { items, found, lines, block } = section;
    const titles = new Map(scan.entries.map((entry) => [entry.id, entry.title]));
    const by_entry = new Map<string, MissionItem[]>();
    for (const item of items) {
        if (item.entry !== null) {
            by_entry.set(item.entry, [...(by_entry.get(item.entry) ?? []), item]);
        }
    }
    // An entry is orphaned when the doc lost it, and stale when none of its items carries
    // its title: a split (CUJ 4) adds items with their own text beside the seeded one.
    const stale: string[] = [];
    const orphaned: string[] = [];
    for (const [id, linked] of by_entry) {
        const title = titles.get(id);
        if (title === undefined) {
            orphaned.push(id);
        } else if (!linked.some((item) => item.text === title)) {
            stale.push(id);
        }
    }
    const flagged = new Set([...stale, ...orphaned]);
    const kept = items.filter((item) => item.entry === null || !flagged.has(item.entry)).length;
    let next_id = items.reduce((max, item) => Math.max(max, item.id), 0);
    const added: (MissionItem & { id: number })[] = [];
    for (const entry of scan.entries) {
        if (by_entry.has(entry.id)) {
            continue;
        }
        next_id += 1;
        const item = {
            checked: false,
            id: next_id,
            text: entry.title,
            owner: null,
            entry: entry.id,
            ticked_at: null,
        };
        const back = parse_item(render_item(item));
        assert.ok(back !== null, `entry ${entry.id} must render as an item`);
        assert.equal(back.owner, null, `entry ${entry.id} must not render an owner`);
        assert.equal(back.text, entry.title, `entry ${entry.id} must keep its title`);
        assert.equal(back.entry, entry.id, `entry ${entry.id} must keep its token`);
        added.push(item);
    }
    write_items(block, lines, found, [...items, ...added], true, false);
    const text = join_mission(blocks);
    check_seed_output(text, items, added.length);
    return {
        mission_text: text,
        added: added.length,
        kept,
        stale,
        orphaned,
    };
}

/** Post-conditions: the count grew by `added` and every tick is still there. */
function check_seed_output(
    text: string,
    before: readonly (MissionItem & { id: number })[],
    added: number,
): void {
    const after = plan_section(split_mission(text)).items;
    assert.equal(after.length, before.length + added, "the seed must add exactly its items");
    const ticked = new Set(after.filter((item) => item.checked).map((item) => item.id));
    for (const item of before) {
        if (item.checked) {
            assert.ok(ticked.has(item.id), `item ${item.id} must keep its tick`);
        }
    }
}

/** The Log line: `plan seeded from <doc> (<sha12>): 23 added, 2 kept, 0 stale, 0 orphaned`. */
export function seed_log_line(doc_path: string, result: SeedResult): string {
    const ids = (list: readonly string[]): string =>
        list.length === 0 ? "" : `: ${list.join(", ")}`;
    return (
        `plan seeded from ${doc_path} (${result.sha12}): ${result.added} added, ` +
        `${result.kept} kept, ${result.stale.length} stale${ids(result.stale)}, ` +
        `${result.orphaned.length} orphaned${ids(result.orphaned)}`
    );
}

/** The Plan block (added at the end when absent) with its lines and ids filled in. */
function plan_section(blocks: MissionBlock[]): PlanSection {
    let block = blocks.find((entry) => entry.heading === SECTION_HEADINGS.plan);
    if (block === undefined) {
        block = { heading: SECTION_HEADINGS.plan, body: "\n" };
        blocks.push(block);
    }
    const lines = block.body.replace(/\n+$/, "").split("\n");
    const found = section_items(block.body).filter(
        ({ line }) => !PLAN_PLACEHOLDER.test(lines[line] ?? ""),
    );
    return { block, lines, found, items: with_ids(found.map(({ item }) => item)) };
}
