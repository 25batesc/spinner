// The fixture's mission parser and item writer, on the daemon's format: ids, owners, times,
// the `doing` state from the Roster, and the tick / untick / edit writes.
import { expect, it } from "vitest";

import { applyItem, missionView, parseItem, renderItem } from "./mission-view.ts";
import { MISSION } from "./pipeline.ts";

it("parses the fixture mission into the structured view", () => {
    const view = missionView(MISSION);
    expect(view.title).toBe("Refund flow");
    expect(view.goal).toBe("Let a customer request a refund.");
    expect(view.done_when.map((i) => [i.id, i.state, i.owner, i.ticked_at])).toEqual([
        [1, "done", "frontend", "10:20"], [2, "open", null, null],
    ]);
    expect(view.plan.map((i) => [i.id, i.state, i.owner])).toEqual([
        [1, "done", "backend"], [2, "next", "frontend"], [3, "doing", "backend"],
    ]);
    expect(view.roster[1]?.blocked).toBe("waiting on api");
    expect(view.contracts[0]).toEqual({
        id: 1, ts: "10:00", author: "backend", text: "POST /refunds",
    });
    expect(view.questions[0]).toEqual({
        id: 1, ts: null, author: "backend", text: "partial refunds in the first round?",
        answer: null, resolved: null,
    });
    expect(view.questions.slice(1)).toEqual([
        {
            id: 2, ts: "10:06", author: "frontend", text: "one refund button per order line?",
            answer: "10:08 operator: one per order", resolved: null,
        },
        {
            id: 3, ts: "10:03", author: "backend", text: "the refund route's path?", answer: null,
            resolved: { ts: "10:09", author: "lead", reason: "POST /refunds, in Contracts" },
        },
    ]);
    expect(view.log.map((l) => l.author)).toEqual(["operator", "backend", "frontend"]);
});

it("round-trips an item line", () => {
    const line = "- [x] 3. the Stripe call (backend, 10:12)";
    const item = parseItem(line);
    expect(item).toEqual({
        checked: true, id: 3, text: "the Stripe call", owner: "backend", entry: null,
        ticked_at: "10:12",
    });
    expect(renderItem(item!)).toBe(line);
});

it("ticks, unticks and edits a plan item; ticks a done_when item by position", () => {
    const ticked = applyItem(MISSION, "plan", "operator", { command: "tick", id: 2 }, "11:05");
    expect("text" in ticked && ticked.text).toContain("- [x] 2. the form (frontend, 11:05)");
    const back = applyItem(
        "text" in ticked ? ticked.text : "", "plan", "operator", { command: "untick", id: 2 },
    );
    expect("text" in back && back.text).toContain("- [ ] 2. the form (frontend)");
    const edited = applyItem(MISSION, "plan", "operator", {
        command: "edit", id: 3, text: "the Stripe refund call",
    });
    expect("text" in edited && edited.text).toContain("- [ ] 3. the Stripe refund call (backend)");
    const done = applyItem(MISSION, "done_when", "operator", { command: "tick", id: 2 }, "11:06");
    expect("text" in done && done.text).toContain("- [x] refunds reach Stripe (operator, 11:06)");
});

it("names the first problem of a bad request", () => {
    expect(applyItem(MISSION, "plan", "operator", { command: "tick", id: 9 })).toEqual({
        error: "no item 9 in Plan",
    });
    expect(applyItem(MISSION, "plan", "operator", { command: "edit", id: 1 })).toEqual({
        error: "edit needs text",
    });
});
