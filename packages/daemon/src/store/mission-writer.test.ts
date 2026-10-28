// Goal: the mission writer follows the editing rules (append-only Log and Contracts with the
// daemon's time and the author's name, one Roster row per agent, replace only on the
// operator's sections) and serializes concurrent writes to one file. Method: the pure
// function on template text, then the class on a temporary home with a recording bus.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpinnerEvent } from "@spinner/protocol";
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
