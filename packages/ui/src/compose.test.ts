// The compose box's rules: which PRs start ticked after an extraction, what a click does to a
// tick, and the body `Start` sends. Checked through the functions a component would call.
import { expect, it } from "vitest";

import { nextTicks, provisionalTitle, startBody, toggleTick, type ExtractedPr } from "./compose.ts";

function pr(number: number, partial: Partial<ExtractedPr> = {}): ExtractedPr {
    return {
        url: `https://github.com/example/web/pull/${number}`, repo: "web", number,
        title: `PR ${number}`, branch: `feature/${number}`, base: "main", adoptable: true,
        ...partial,
    };
}

it("ticks every adoptable PR of a first extraction and never one that is not adoptable", () => {
    const prs = [pr(1), pr(2, { adoptable: false, reason: "repo other is not in the project" })];
    expect([...nextTicks(new Set(), [], prs)]).toEqual([prs[0]?.url]);
});

it("keeps an untick across extractions while the PR stays in the text", () => {
    const first = [pr(1), pr(2)];
    const unticked = toggleTick(nextTicks(new Set(), [], first), first, pr(1).url);
    expect(unticked.has(pr(1).url)).toBe(false);
    const second = [pr(1), pr(2), pr(3)];
    const ticks = nextTicks(unticked, first, second);
    expect([...ticks].sort()).toEqual([pr(2).url, pr(3).url].sort());
});

it("ticks a PR again once it left the text and came back", () => {
    const first = [pr(1)];
    const unticked = toggleTick(nextTicks(new Set(), [], first), first, pr(1).url);
    const gone = nextTicks(unticked, first, []);
    expect(gone.size).toBe(0);
    expect(nextTicks(gone, [], first).has(pr(1).url)).toBe(true);
});

it("refuses to tick a PR that is not adoptable", () => {
    const prs = [pr(9, { adoptable: false, reason: "ambiguous" })];
    expect(toggleTick(new Set(), prs, pr(9).url).size).toBe(0);
});

it("sends the text, the project and the ticked PRs in the extraction's order", () => {
    const prs = [pr(3), pr(1), pr(2, { adoptable: false })];
    const ticked = new Set([pr(1).url, pr(3).url, pr(2).url]);
    expect(startBody("Fix the refunds\nmore", "/p/spinner.yaml", ticked, prs)).toEqual({
        text: "Fix the refunds\nmore", project: "/p/spinner.yaml",
        adopt: [pr(3).url, pr(1).url],
    });
    expect(startBody("x", "", new Set(), [])).toEqual({ text: "x", adopt: [] });
});

it("takes the provisional title from the first non-empty line", () => {
    expect(provisionalTitle("\n  \nRefund flow  \nhttps://x")).toBe("Refund flow");
    expect(provisionalTitle("   ")).toBe("");
});
