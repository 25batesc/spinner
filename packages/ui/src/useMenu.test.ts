// The close rule every toolbar menu shares (dogfood row 8, r4.3). Method: a container whose
// `contains` knows two nodes (the menu's button and one item) stands in for the DOM; each case
// feeds `closesMenu` the event the document listener would see and reads whether the menu
// closes. The driver flow `menus` checks the same rule on the three real menus.
import { expect, it } from "vitest";

import { closesMenu } from "./useMenu.ts";

const button = { name: "button" };
const item = { name: "item" };
const elsewhere = { name: "elsewhere" };
const container = { contains: (node: unknown) => node === button || node === item };

it("closes on a pointer press outside the container", () => {
    expect(closesMenu({ type: "pointerdown", target: elsewhere }, container)).toBe(true);
});

it("stays open on a press on its button or inside the menu", () => {
    expect(closesMenu({ type: "pointerdown", target: button }, container)).toBe(false);
    expect(closesMenu({ type: "pointerdown", target: item }, container)).toBe(false);
});

it("closes on Escape and on no other key", () => {
    expect(closesMenu({ type: "keydown", key: "Escape", target: item }, container)).toBe(true);
    expect(closesMenu({ type: "keydown", key: "Enter", target: item }, container)).toBe(false);
    expect(closesMenu({ type: "keydown", key: "a", target: elsewhere }, container)).toBe(false);
});

it("closes only on Escape before the container mounts, and ignores other events", () => {
    expect(closesMenu({ type: "pointerdown", target: elsewhere }, null)).toBe(false);
    expect(closesMenu({ type: "keydown", key: "Escape", target: elsewhere }, null)).toBe(true);
    expect(closesMenu({ type: "click", target: elsewhere }, container)).toBe(false);
});
