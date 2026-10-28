import { describe, expect, it } from "vitest";

import { changedHeadings, parseMission, tableRows } from "./mission.ts";

const FILE = [
    "# s1 · Title", "", "## Goal", "Ship it.", "", "## Done when", "- [ ] a", "",
    "## Roster", "| Agent | Doing |", "|---|---|", "| ui | work |", "",
    "## Contracts & decisions", "- one", "", "## Log", "- 10:00 ui: hi", "",
].join("\n");

describe("parseMission", () => {
    it("splits sections and names the known ones", () => {
        const mission = parseMission(FILE);
        expect(mission.title).toBe("s1 · Title");
        expect(mission.parts.map((p) => p.section)).toEqual([
            "goal", "done_when", "roster", "contracts", "log",
        ]);
        expect(mission.parts[0]?.body).toBe("Ship it.");
    });

    it("reads the roster rows without the divider", () => {
        const roster = parseMission(FILE).parts.find((p) => p.section === "roster");
        expect(tableRows(roster?.body ?? "")).toEqual([["Agent", "Doing"], ["ui", "work"]]);
    });

    it("reports only the sections that changed", () => {
        const before = parseMission(FILE);
        const after = parseMission(FILE.replace("Ship it.", "Ship it now."));
        expect(changedHeadings(before, after)).toEqual(["Goal"]);
        expect(changedHeadings(null, after)).toEqual([]);
    });
});
