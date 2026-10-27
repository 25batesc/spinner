// Goal: `spinner new` and `spinner show` behave as docs/SESSION_PROTOCOL.md says, through the
// public `run_cli` entry. Method: run the commands against a temporary SPINNER_HOME and check
// the exit code, the captured output and the files on disk.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run_cli, type CliIo } from "./cli.js";

let root: string;
let out: string[];
let err: string[];
let io: CliIo;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "spinner-cli-"));
    out = [];
    err = [];
    io = {
        env: { SPINNER_HOME: root },
        out: (line) => out.push(line),
        err: (line) => err.push(line),
    };
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("spinner new", () => {
    it("creates a session directory and prints its path", async () => {
        const code = await run_cli(["new", "Refund", "flow"], io);
        expect(code).toBe(0);
        const path = join(root, "sessions", "s001-refund-flow");
        expect(out).toEqual([`created ${path}`]);
        expect(existsSync(join(path, "session.yaml"))).toBe(true);
        expect(existsSync(join(path, "MISSION.md"))).toBe(true);
        expect(existsSync(join(path, "agents"))).toBe(true);
    });

    it("honours --slug", async () => {
        expect(await run_cli(["new", "Anything", "--slug", "custom"], io)).toBe(0);
        expect(existsSync(join(root, "sessions", "s001-custom"))).toBe(true);
    });

    it("fails without a title", async () => {
        expect(await run_cli(["new"], io)).toBe(1);
        expect(err[0]).toMatch(/title is required/);
    });
});

describe("spinner show", () => {
    it("says when there are no sessions", async () => {
        expect(await run_cli(["show"], io)).toBe(0);
        expect(out[0]).toMatch(/^no sessions under /);
    });

    it("lists sessions with stage, stack state and needs_human", async () => {
        await run_cli(["new", "One"], io);
        await run_cli(["new", "Two"], io);
        out = [];
        expect(await run_cli(["show"], io)).toBe(0);
        expect(out).toHaveLength(1);
        const lines = out[0]?.split("\n") ?? [];
        expect(lines[0]).toMatch(/^id\s+title\s+stage\s+stack\s+needs you$/);
        expect(lines[1]).toMatch(/^s001\s+One\s+planned\s+none\s+write Goal/);
        expect(lines[2]).toMatch(/^s002\s+Two\s+planned\s+none/);
    });

    it("shows one session by dir or id and fails for an unknown one", async () => {
        await run_cli(["new", "One"], io);
        out = [];
        expect(await run_cli(["show", "s001-one"], io)).toBe(0);
        expect(out[0]).toContain("s001 · One");
        expect(out[0]).toContain("planned · stack none");
        expect(out[0]).toContain("needs you: write Goal");
        expect(await run_cli(["show", "s001"], io)).toBe(0);
        expect(await run_cli(["show", "nope"], io)).toBe(1);
        expect(err[0]).toMatch(/no session "nope"/);
    });
});

describe("usage", () => {
    it("prints usage for help and for an unknown command", async () => {
        expect(await run_cli(["help"], io)).toBe(0);
        expect(out[0]).toMatch(/^usage:/);
        expect(out[0]).toContain("spinner up ");
        expect(await run_cli(["frobnicate"], io)).toBe(1);
        expect(err[0]).toMatch(/unknown command/);
    });
});
