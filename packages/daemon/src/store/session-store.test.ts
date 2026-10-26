// Goal: a created session directory has exactly the layout docs/SESSION_PROTOCOL.md describes,
// and the store reads back what it wrote. Method: point SPINNER_HOME at a fresh temporary
// directory, create sessions, and inspect the files and the listing.
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolve_home, type SpinnerHome } from "../home.js";
import {
    SESSION_FILES,
    SESSION_SUBDIRS,
    create_session,
    list_sessions,
    next_session_id,
    read_session,
    slugify,
} from "./session-store.js";

let home: SpinnerHome;

beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "spinner-home-"));
    home = resolve_home({ SPINNER_HOME: root });
});

afterEach(() => {
    rmSync(home.root, { recursive: true, force: true });
});

describe("create_session", () => {
    it("creates the protocol layout", () => {
        const now = new Date(2026, 9, 26, 17, 30, 0);
        const summary = create_session(home, { title: "Payments: refund flow", now });

        expect(summary.dir).toBe("s001-payments-refund-flow");
        expect(summary.path).toBe(join(home.sessions, "s001-payments-refund-flow"));
        for (const subdir of SESSION_SUBDIRS) {
            expect(existsSync(join(summary.path, subdir)), subdir).toBe(true);
        }
        for (const file of SESSION_FILES) {
            expect(existsSync(join(summary.path, file)), file).toBe(true);
        }
        const entries = readdirSync(summary.path).sort();
        expect(entries).toEqual([...SESSION_SUBDIRS, ...SESSION_FILES].sort());

        const yaml = parse(readFileSync(join(summary.path, "session.yaml"), "utf8"));
        expect(yaml).toMatchObject({
            version: 1,
            id: "s001",
            slug: "payments-refund-flow",
            title: "Payments: refund flow",
            stage: "planned",
            branch: "feat/payments-refund-flow",
            base: "main",
            repos: {},
            stack: { state: "none" },
            agents: {},
        });
        expect(yaml.created).toMatch(/^2026-10-26T17:30:00[+-]\d\d:\d\d$/);

        const mission = readFileSync(join(summary.path, "MISSION.md"), "utf8");
        expect(mission.startsWith("# s001 · Payments: refund flow\n")).toBe(true);
        for (const heading of ["Goal", "Done when", "Plan", "Roster", "Contracts & decisions",
            "Open questions", "Log"]) {
            expect(mission, heading).toContain(`\n## ${heading}\n`);
        }
        expect(mission).toContain("- 17:30 operator: session created");
    });

    it("numbers sessions after the highest existing id", () => {
        create_session(home, { title: "first" });
        mkdirSync(join(home.sessions, "s041-handmade"));
        expect(next_session_id(home)).toBe("s042");
        const third = create_session(home, { title: "third", slug: "custom" });
        expect(third.dir).toBe("s042-custom");
    });

    it("refuses an empty title and a home inside a git repo", () => {
        expect(() => create_session(home, { title: "   " })).toThrow(/title/);
        mkdirSync(join(home.root, ".git"));
        expect(() => create_session(home, { title: "x" })).toThrow(/inside a git repository/);
    });
});

describe("list_sessions and read_session", () => {
    it("returns an empty list when the sessions directory does not exist", () => {
        expect(list_sessions(home)).toEqual({ sessions: [], errors: [] });
    });

    it("lists created sessions sorted and reports unreadable ones", () => {
        create_session(home, { title: "Beta" });
        create_session(home, { title: "Alpha" });
        mkdirSync(join(home.sessions, "s999-broken"));
        writeFileSync(join(home.sessions, "s999-broken", "session.yaml"), "version: 1\n");
        mkdirSync(join(home.sessions, "not-a-session"));

        const result = list_sessions(home);
        expect(result.sessions.map((entry) => entry.dir)).toEqual(["s001-beta", "s002-alpha"]);
        expect(result.errors.map((entry) => entry.dir)).toEqual(["not-a-session", "s999-broken"]);
        expect(result.errors[1]?.error).toMatch(/missing string `id`/);
    });

    it("rejects a session.yaml from a newer version", () => {
        mkdirSync(join(home.sessions, "s007-future"), { recursive: true });
        writeFileSync(
            join(home.sessions, "s007-future", "session.yaml"),
            "version: 99\nid: s007\nslug: future\ntitle: t\nstage: planned\n",
        );
        const read = read_session(home, "s007-future");
        expect(read.ok).toBe(false);
        if (!read.ok) {
            expect(read.error).toMatch(/newer than supported/);
        }
    });
});

describe("slugify", () => {
    it("lower-cases and collapses punctuation", () => {
        expect(slugify("Payments: refund flow!")).toBe("payments-refund-flow");
        expect(slugify("  --Already-slug--  ")).toBe("already-slug");
    });
});
