// Goal: the outcome counters start at zeros, count one at a time on a fresh read of the
// session, and the steer rule counts only an operator's steer to the lead
// (docs/designs/egm-adoption.md, entries 6.20 and 6.22, review v2 M-5). Method: real session
// directories in a scratch home; `session.yaml` is read back after each count.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { Session } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { create_session, read_session, write_session } from "../store/session-store.js";
import { count_outcome, counts_as_operator_steer, with_outcome } from "./outcomes.js";

let home: SpinnerHome;

beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "spinner-outcomes-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home") });
});

function yaml_of(dir: string): Session {
    return parse(readFileSync(join(home.sessions, dir, "session.yaml"), "utf8")) as Session;
}

describe("with_outcome", () => {
    it("starts at zeros when outcomes is absent and raises only the named counter", () => {
        const created = create_session(home, { title: "Pure" });
        expect(created.session.outcomes).toBeUndefined();
        const once = with_outcome(created.session, "fix_rounds");
        expect(once.outcomes).toEqual({ fix_rounds: 1, operator_steers: 0 });
        const twice = with_outcome(once, "operator_steers");
        expect(twice.outcomes).toEqual({ fix_rounds: 1, operator_steers: 1 });
        expect(once.outcomes).toEqual({ fix_rounds: 1, operator_steers: 0 });
    });

    it("refuses a corrupt counter", () => {
        const created = create_session(home, { title: "Corrupt" });
        const bad = { ...created.session, outcomes: { fix_rounds: -1, operator_steers: 0 } };
        expect(() => with_outcome(bad, "fix_rounds")).toThrow(/must not be negative/);
    });
});

describe("count_outcome", () => {
    it("writes the count and keeps a field another writer changed since the caller read", () => {
        const created = create_session(home, { title: "Fresh read" });
        // Another writer changes the title after the caller's read.
        write_session({ ...created, session: { ...created.session, title: "Renamed" } });
        const counted = count_outcome(home, created.dir, "operator_steers");
        expect(counted.session.title).toBe("Renamed");
        expect(yaml_of(created.dir).title).toBe("Renamed");
        expect(yaml_of(created.dir).outcomes).toEqual({ fix_rounds: 0, operator_steers: 1 });
        count_outcome(home, created.dir, "operator_steers");
        expect(yaml_of(created.dir).outcomes).toEqual({ fix_rounds: 0, operator_steers: 2 });
        const read = read_session(home, created.dir);
        expect(read.ok && read.summary.session.outcomes?.operator_steers).toBe(2);
    });

    it("throws for a session that does not exist", () => {
        expect(() => count_outcome(home, "s999-nope", "fix_rounds")).toThrow(/cannot count/);
    });
});

describe("counts_as_operator_steer", () => {
    it("counts a steer to the lead with source operator", () => {
        expect(counts_as_operator_steer("steer", "lead", { text: "t", source: "operator" })).toBe(
            true,
        );
    });

    it("does not count a prompt, a steer to a worker, or a steer without source", () => {
        const operator = { text: "t", source: "operator" as const };
        expect(counts_as_operator_steer("prompt", "lead", operator)).toBe(false);
        expect(counts_as_operator_steer("steer", "backend", operator)).toBe(false);
        expect(counts_as_operator_steer("steer", "lead", { text: "t" })).toBe(false);
    });
});
