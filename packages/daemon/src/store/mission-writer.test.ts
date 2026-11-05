// Goal: the mission writer follows the editing rules (append-only Log and Contracts with the
// daemon's time and the author's name, one Roster row per agent, replace only on the
// operator's sections) and serializes concurrent writes to one file. Method: the pure
// function on template text, then the class on a temporary home with a recording bus.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MissionSectionRequest, SpinnerEvent } from "@spinner/protocol";
import { mission_section } from "../pipeline/mission-sections.js";
import { EventBus } from "../event-bus.js";
import { resolve_home, type SpinnerHome } from "../home.js";
import { render_mission } from "./mission-template.js";
import {
    MissionWriter,
    apply_mission_write,
    hh_mm,
    split_row,
    validate_mission_write,
} from "./mission-writer.js";

const base = render_mission({ id: "s9", title: "Test", time: "09:00" });

describe("apply_mission_write", () => {
    it("appends Log and Contracts lines with time and author, questions with the author", () => {
        let text = apply_mission_write(
            base,
            { section: "log", mode: "append", text: "started", author: "api" },
            "09:01",
        ).text;
        text = apply_mission_write(
            text,
            { section: "contracts", mode: "append", text: "POST /x", author: "api" },
            "09:02",
        ).text;
        text = apply_mission_write(
            text,
            { section: "open_questions", mode: "append", text: "v1 or v2?", author: "api" },
            "09:03",
        ).text;
        expect(text).toContain("- 09:00 operator: session created\n- 09:01 api: started\n");
        expect(text).toContain("## Contracts & decisions\n- 09:02 api: POST /x\n\n");
        expect(text).toContain("## Open questions\n- api: v1 or v2?\n\n");
        expect(text.indexOf("## Open questions")).toBeLessThan(text.indexOf("## Log"));
    });

    it("appends Plan items as checkboxes and drops the template's empty item", () => {
        expect(base).toContain("## Plan\n- [ ] 1. \n");
        let text = apply_mission_write(
            base,
            { section: "plan", mode: "append", text: "1. API contract (api)", author: "operator" },
            "09:01",
        ).text;
        text = apply_mission_write(
            text,
            { section: "plan", mode: "append", text: "- [x] 2. Done already (ui)", author: "ui" },
            "09:02",
        ).text;
        text = apply_mission_write(
            text,
            { section: "plan", mode: "append", text: "- 3. Verify (operator)", author: "ui" },
            "09:03",
        ).text;
        expect(text).toContain(
            "## Plan\n- [ ] 1. API contract (api)\n- [x] 2. Done already (ui)\n" +
                "- [ ] 3. Verify (operator)\n\n## Roster",
        );
    });

    it("upserts one Roster row per author and keeps the Owns cell", () => {
        const first = apply_mission_write(
            base,
            {
                section: "roster",
                mode: "roster_row",
                text: "contract",
                author: "api",
                blocked: "no",
            },
            "09:05",
        ).text;
        const row = first.split("\n").find((line) => line.startsWith("| api"));
        expect(row).toBe("| api | — | contract | no | 09:05 |");
        const owned = first.replace("| api | — |", "| api | `backend/**` |");
        const second = apply_mission_write(
            owned,
            {
                section: "roster",
                mode: "roster_row",
                text: "tests",
                author: "api",
                blocked: "yes: a | b",
            },
            "09:07",
        ).text;
        const rows = second.split("\n").filter((line) => line.startsWith("| api"));
        expect(rows).toEqual(["| api | `backend/**` | tests | yes: a / b | 09:07 |"]);
        expect(split_row(rows[0] ?? "")).toHaveLength(5);
    });

    it("replaces Goal and refuses modes where the rules forbid them", () => {
        const text = apply_mission_write(
            base,
            { section: "goal", mode: "replace", text: "Ship it.\n", author: "operator" },
            "09:08",
        ).text;
        expect(text).toContain("## Goal\nShip it.\n\n## Done when");
        const log_replace = { section: "log", mode: "replace", text: "x", author: "a" } as const;
        expect(validate_mission_write(log_replace)).toMatch(/replace is allowed/);
        const roster_append = {
            section: "roster",
            mode: "append",
            text: "x",
            author: "a",
        } as const;
        expect(validate_mission_write(roster_append)).toMatch(/append is allowed/);
        const multi = { section: "log", mode: "append", text: "a\nb", author: "a" } as const;
        expect(validate_mission_write(multi)).toMatch(/one line/);
        const spaced = { section: "log", mode: "append", text: "a", author: "a b" } as const;
        expect(validate_mission_write(spaced)).toMatch(/one word/);
    });

    it("item mode: adds with ids, ticks with owner and time, edits, assigns, reorders", () => {
        const item = (
            text: string,
            section: "plan" | "done_when",
            request: MissionSectionRequest["item"],
            author = "lead",
            time = "10:05",
        ): string =>
            apply_mission_write(
                text,
                { section, mode: "item", text: "", author, item: request },
                time,
            ).text;
        let text = item(base, "plan", { command: "add", text: "contract" });
        text = item(text, "plan", { command: "add", text: "workflow", owner: "backend" });
        text = item(text, "plan", { command: "add", text: "page", owner: "web" });
        expect(mission_section(text, "Plan")).toBe(
            ["- [ ] 1. contract (lead)", "- [ ] 2. workflow (backend)", "- [ ] 3. page (web)"].join(
                "\n",
            ),
        );
        text = item(text, "plan", { command: "tick", id: 1 });
        text = item(text, "plan", { command: "edit", id: 2, text: "workflow + tests" });
        text = item(text, "plan", { command: "assign", id: 3, owner: "admin" });
        expect(mission_section(text, "Plan")).toBe(
            [
                "- [x] 1. contract (lead, 10:05)",
                "- [ ] 2. workflow + tests (backend)",
                "- [ ] 3. page (admin)",
            ].join("\n"),
        );
        text = item(text, "plan", { command: "reorder", order: [3, 1] });
        expect(mission_section(text, "Plan").split("\n").map((line) => line.slice(6, 8))).toEqual(
            ["3.", "1.", "2."],
        );
        text = item(text, "plan", { command: "untick", id: 1 });
        expect(mission_section(text, "Plan")).toContain("- [ ] 1. contract (lead)");
        // The next id is max + 1 whatever the order; ids never change.
        text = item(text, "plan", { command: "add", text: "review" });
        expect(mission_section(text, "Plan")).toContain("- [ ] 4. review (lead)");
        expect(() => item(text, "plan", { command: "tick", id: 9 })).toThrow(/no item 9/);

        // Done when: positions as ids, the author on a tick, no numbers in the file.
        let done = apply_mission_write(
            base,
            {
                section: "done_when",
                mode: "replace",
                text: "- [ ] API agreed\n- [ ] UI done (web)",
                author: "lead",
            },
            "10:00",
        ).text;
        done = item(done, "done_when", { command: "tick", id: 2 }, "web", "10:07");
        done = item(done, "done_when", { command: "add", text: "PRs green" });
        expect(mission_section(done, "Done when")).toBe(
            ["- [ ] API agreed", "- [x] UI done (web, 10:07)", "- [ ] PRs green"].join("\n"),
        );
        expect(
            validate_mission_write({ section: "log", mode: "item", text: "", author: "a" }),
        ).toContain("plan and done_when");
        expect(
            validate_mission_write({
                section: "plan",
                mode: "item",
                text: "",
                author: "a",
                item: { command: "tick" },
            }),
        ).toContain("item.id");
    });

    it("item mode: the entry token is written first, kept by edit and tick, moved", () => {
        const item = (text: string, request: MissionSectionRequest["item"]): string =>
            apply_mission_write(
                text,
                { section: "plan", mode: "item", text: "", author: "lead", item: request },
                "10:05",
            ).text;
        let text = item(base, { command: "add", text: "`a.ts`", entry: "2.3" });
        expect(mission_section(text, "Plan")).toBe("- [ ] 1. [2.3] `a.ts` (lead)");
        text = item(text, { command: "edit", id: 1, text: "`a.ts` and `b.ts`" });
        expect(mission_section(text, "Plan")).toBe("- [ ] 1. [2.3] `a.ts` and `b.ts` (lead)");
        text = item(text, { command: "tick", id: 1 });
        expect(mission_section(text, "Plan")).toBe(
            "- [x] 1. [2.3] `a.ts` and `b.ts` (lead, 10:05)",
        );
        text = item(text, { command: "edit", id: 1, text: "[2.4] `c.ts`" });
        expect(mission_section(text, "Plan")).toBe("- [x] 1. [2.4] `c.ts` (lead, 10:05)");
        const refused = (request: MissionSectionRequest["item"]): string | null =>
            validate_mission_write({
                section: "plan",
                mode: "item",
                text: "",
                author: "lead",
                item: request,
            });
        expect(refused({ command: "tick", id: 1, entry: "2.3" })).toContain("add only");
        expect(refused({ command: "add", text: "x", entry: "x" })).toContain("entry id");
        expect(refused({ command: "add", text: "x", entry: "2.3" })).toBeNull();
    });

    it("item mode gives older Plan lines ids on the first write and keeps notes in place", () => {
        const old = [
            "# s9 \u00b7 Old",
            "",
            "## Plan",
            "- [x] 1. API contract agreed (backend-api)",
            "- [ ] RefundWorkflow + activities + tests (backend-api)",
            "  a note under the item",
            "- [ ] 4. Order page button (admin-ui, after 3)",
            "",
            "## Log",
            "",
        ].join("\n");
        const text = apply_mission_write(
            old,
            {
                section: "plan",
                mode: "item",
                text: "",
                author: "admin-ui",
                item: { command: "tick", id: 4 },
            },
            "11:00",
        ).text;
        expect(mission_section(text, "Plan")).toBe(
            [
                "- [x] 1. API contract agreed (backend-api)",
                "- [ ] 5. RefundWorkflow + activities + tests (backend-api)",
                "  a note under the item",
                "- [x] 4. Order page button (after 3) (admin-ui, 11:00)",
            ].join("\n"),
        );
        expect(mission_section(text, "Log")).toBe("");
    });

    it("formats the clock as HH:MM", () => {
        expect(hh_mm(new Date(2026, 9, 28, 7, 5))).toBe("07:05");
    });
});

describe("MissionWriter", () => {
    let home: SpinnerHome;
    let bus: EventBus;
    let events: SpinnerEvent[];

    beforeEach(() => {
        home = resolve_home({ SPINNER_HOME: mkdtempSync(join(tmpdir(), "spinner-writer-")) });
        mkdirSync(join(home.sessions, "s9-test"), { recursive: true });
        writeFileSync(join(home.sessions, "s9-test", "MISSION.md"), base);
        bus = new EventBus();
        events = [];
        bus.subscribe((event) => events.push(event));
    });

    afterEach(() => {
        rmSync(home.root, { recursive: true, force: true });
    });

    it("serializes concurrent writes, stamps the time and publishes mission.changed", async () => {
        const writer = new MissionWriter(home, bus, { now: () => new Date(2026, 9, 28, 10, 30) });
        const writes = [];
        for (let n = 1; n <= 20; n += 1) {
            const author = n % 2 === 0 ? "api" : "ui";
            writes.push(
                writer.write("s9-test", {
                    section: "log",
                    mode: "append",
                    text: `line ${n}`,
                    author,
                }),
            );
        }
        const results = await Promise.all(writes);
        expect(results.every((result) => result.ok)).toBe(true);
        const text = readFileSync(join(home.sessions, "s9-test", "MISSION.md"), "utf8");
        const lines = text.split("\n").filter((line) => /^- 10:30 (api|ui): line \d+$/.test(line));
        expect(lines).toHaveLength(20);
        expect(lines[0]).toBe("- 10:30 ui: line 1");
        expect(lines[19]).toBe("- 10:30 api: line 20");
        expect(events.filter((event) => event.type === "mission.changed")).toHaveLength(20);
        expect(writer.last_write("s9-test")?.author).toBe("api");
    });

    it("rewrite applies a function to the file and publishes one mission.changed", async () => {
        const writer = new MissionWriter(home, bus, { now: () => new Date(2026, 9, 28, 12, 0) });
        const first = writer.write("s9-test", {
            section: "log",
            mode: "append",
            text: "before",
            author: "lead",
        });
        const rewrite = writer.rewrite("s9-test", "spinner", (text) =>
            text.replace("## Plan\n", "## Plan\n- [ ] 1. [1.1] seeded\n"),
        );
        await Promise.all([first, rewrite]);
        const text = readFileSync(join(home.sessions, "s9-test", "MISSION.md"), "utf8");
        expect(mission_section(text, "Plan")).toContain("- [ ] 1. [1.1] seeded");
        expect(mission_section(text, "Log")).toContain("before");
        const changed = events.filter((event) => event.type === "mission.changed");
        expect(changed).toHaveLength(2);
        expect(changed[1]).toMatchObject({ author: "spinner", sections: [] });
        expect(changed[1]?.type === "mission.changed" && changed[1].view.plan[0]).toMatchObject({
            id: 1,
            entry: "1.1",
            text: "seeded",
        });
        expect(writer.last_write("s9-test")?.author).toBe("spinner");
    });

    it("rewrites the agent's NOTES.md on a Roster row write", async () => {
        const writer = new MissionWriter(home, bus, { now: () => new Date(2026, 9, 28, 11, 0) });
        await writer.write("s9-test", {
            section: "log",
            mode: "append",
            text: "began",
            author: "api",
        });
        await writer.write("s9-test", {
            section: "roster",
            mode: "roster_row",
            text: "the workflow",
            author: "api",
            blocked: "yes: a seed",
        });
        const notes = readFileSync(
            join(home.sessions, "s9-test", "agents", "api", "NOTES.md"),
            "utf8",
        );
        expect(notes).toContain("- Doing: the workflow\n- Blocked?: yes: a seed\n");
        expect(notes).toContain("## Recent Log lines\n- 11:00 api: began\n");
        expect(writer.last_notes_write("s9-test", "api")).toBe(
            new Date(2026, 9, 28, 11, 0).getTime(),
        );
        expect(writer.last_notes_write("s9-test", "ui")).toBeNull();
    });

    it("refuses a bad request and keeps serving the next one", async () => {
        const writer = new MissionWriter(home, bus);
        const bad = writer.write("s9-test", {
            section: "log",
            mode: "replace",
            text: "x",
            author: "a",
        });
        await expect(bad).rejects.toThrow(/replace is allowed/);
        const good = await writer.write("s9-test", {
            section: "log",
            mode: "append",
            text: "fine",
            author: "a",
        });
        expect(good.sections).toEqual(["log"]);
    });
});

describe("MissionWriter on the design track (2.21, 2.22)", () => {
    let home: SpinnerHome;

    beforeEach(() => {
        home = resolve_home({ SPINNER_HOME: mkdtempSync(join(tmpdir(), "spinner-writer-")) });
        mkdirSync(join(home.sessions, "s9-test"), { recursive: true });
        writeFileSync(join(home.sessions, "s9-test", "MISSION.md"), base);
    });

    afterEach(() => {
        rmSync(home.root, { recursive: true, force: true });
    });

    /** A session.yaml with the given `design` block, or none. */
    function session_with(design: string): void {
        const yaml = [
            "version: 1",
            "id: s9",
            "slug: test",
            "title: Test",
            "created: 2026-11-02",
            "stage: planned",
            "needs_human: null",
            "branch: feat/test",
            "base: main",
            "repos: {}",
            "stack: { state: none }",
            "agents: {}",
            design,
        ].join("\n");
        writeFileSync(join(home.sessions, "s9-test", "session.yaml"), `${yaml}\n`);
    }

    const write = (section: "goal" | "done_when" | "plan" | "log", author: string) => {
        const writer = new MissionWriter(home, new EventBus());
        const request: MissionSectionRequest =
            section === "plan" || section === "log"
                ? { section, mode: "append", text: "a line", author }
                : { section, mode: "replace", text: "- [ ] x", author };
        return writer.write("s9-test", request);
    };

    it("refuses the lead's Goal and Done when; Plan, Log and Roster pass", async () => {
        session_with("design: { track: design, doc: docs/designs/x.md }");
        const refusal = "this session's spec is the design doc (docs/designs/x.md)";
        await expect(write("goal", "lead")).rejects.toThrow(refusal);
        await expect(write("done_when", "lead")).rejects.toThrow(refusal);
        await expect(write("done_when", "operator")).rejects.toThrow(refusal);
        expect((await write("plan", "lead")).ok).toBe(true);
        expect((await write("log", "lead")).ok).toBe(true);
        const roster = await new MissionWriter(home, new EventBus()).write("s9-test", {
            section: "roster",
            mode: "roster_row",
            text: "the draft",
            author: "lead",
            blocked: "no",
        });
        expect(roster.ok).toBe(true);
        expect((await write("goal", "spinner")).ok).toBe(true);
    });

    it("names a doc that is not named yet", async () => {
        session_with("design: { track: design }");
        await expect(write("goal", "lead")).rejects.toThrow(
            "this session's spec is the design doc (not named yet)",
        );
    });

    it("lets the lead write Goal on the direct track and without a design block", async () => {
        session_with("design: { track: direct }");
        expect((await write("goal", "lead")).ok).toBe(true);
        session_with("");
        expect((await write("goal", "lead")).ok).toBe(true);
    });
});
