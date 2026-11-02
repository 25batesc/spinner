// The compose box's rules: which PRs start ticked after an extraction, what a click does to a
// tick, and the body `Start` sends. Checked through the functions a component would call.
import { expect, it } from "vitest";

import { nextTicks, startBody, toggleTick, type ExtractedPr } from "./compose.ts";

const url = (number: number) => `https://github.com/example/web/pull/${number}`;

function pr(number: number, partial: Partial<ExtractedPr> = {}): ExtractedPr {
    return {
        ref: `web#${number}`, url: url(number),
        repo: "example/web", key: "web", number, title: `PR ${number}`,
        branch: `feature/${number}`, base: "main", adoptable: true, ...partial,
    };
}

it("ticks every adoptable PR of a first extraction and never one that is not adoptable", () => {
    const prs = [pr(1), pr(2, { adoptable: false, reason: "repo other is not in the project" })];
    expect([...nextTicks(new Set(), [], prs)]).toEqual([prs[0]?.url]);
});

it("keeps an untick across extractions while the PR stays in the text", () => {
    const first = [pr(1), pr(2)];
    const unticked = toggleTick(nextTicks(new Set(), [], first), first, url(1));
    expect(unticked.has(url(1))).toBe(false);
    const second = [pr(1), pr(2), pr(3)];
    const ticks = nextTicks(unticked, first, second);
    expect([...ticks].sort()).toEqual([url(2), url(3)].sort());
});

it("ticks a PR again once it left the text and came back", () => {
    const first = [pr(1)];
    const unticked = toggleTick(nextTicks(new Set(), [], first), first, url(1));
    const gone = nextTicks(unticked, first, []);
    expect(gone.size).toBe(0);
    expect(nextTicks(gone, [], first).has(url(1))).toBe(true);
});

it("refuses to tick a PR that is not adoptable, or one without a URL", () => {
    const prs = [pr(9, { adoptable: false, reason: "ambiguous" }), pr(8, { url: null })];
    expect(toggleTick(new Set(), prs, url(9)).size).toBe(0);
    expect(nextTicks(new Set(), [], prs).size).toBe(0);
});

it("sends the text, the project and the ticked PRs in the extraction's order", () => {
    const prs = [pr(3), pr(1), pr(2, { adoptable: false })];
    const ticked = new Set([url(1), url(3), url(2)]);
    expect(startBody("Fix the refunds\nmore", "/p/spinner.yaml", ticked, prs)).toEqual({
        text: "Fix the refunds\nmore", project: "/p/spinner.yaml",
        adopt: [url(3), url(1)],
    });
    expect(startBody("x", "", new Set(), [])).toEqual({ text: "x", adopt: [] });
});
