// Goal: `spinner doctor` prints one line per check and exits 1 with the list of failures.
// Method: a temporary home, through the public `run_cli` entry. The checks the test controls
// (the home inside a git repository, a broken `config.yaml`, the `env` file's mode) are
// asserted line by line. PATH is empty, so `docker` and `gh` are "not on PATH" at once and
// the test never waits on Docker; those two lines are asserted by shape only.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run_cli, type CliIo } from "../cli.js";

let root: string;
let out: string[];
let err: string[];

function io_for(home: string, extra: NodeJS.ProcessEnv = {}): CliIo {
    return {
        env: { SPINNER_HOME: home, PATH: "", ...extra },
        out: (line) => out.push(line),
        err: (line) => err.push(line),
    };
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "spinner-doctor-"));
    out = [];
    err = [];
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("spinner doctor", () => {
    it("prints one line per check, ok or FAIL, and lists the failures", async () => {
        const repo = join(root, "repo");
        execFileSync("git", ["init", "--quiet", repo]);
        const home = join(repo, "home");
        mkdirSync(home);
        writeFileSync(join(home, "config.yaml"), "port: nope\n");
        writeFileSync(join(home, "env"), "");
        chmodSync(join(home, "env"), 0o644);

        const code = await run_cli(["doctor"], io_for(home));
        expect(code).toBe(1);
        expect(err).toEqual([]);
        const lines = out.slice(0, -1);
        expect(lines).toHaveLength(11);
        for (const line of lines) {
            expect(line).toMatch(/^(ok {2}|FAIL) {2}\S+\s+\S/);
        }
        expect(lines[0]).toMatch(/^FAIL {2}home .*inside a git repository; set SPINNER_HOME/);
        expect(lines[4]).toMatch(/^FAIL {2}pi .*config\.yaml: port must be an integer/);
        expect(lines[7]).toMatch(/^FAIL {2}env .*mode 644; run chmod 600/);
        expect(lines[9]).toMatch(/^ok {4}daemon .*not running; run spinner daemon start/);
        expect(out.at(-1)).toMatch(/^\d+ check\(s\) failed: home, .*pi, .*env/);
    });

    it("passes the checks it controls on a clean home and never prints the token", async () => {
        const home = join(root, "home");
        const io = io_for(home, {
            SLACK_USER_TOKEN: "xoxp-not-a-real-token",
            SPINNER_PI: process.execPath,
        });
        await run_cli(["doctor"], io);
        const lines = out.filter((line) => /^(ok {2}|FAIL) {2}/.test(line));
        expect(lines).toHaveLength(11);
        expect(lines[0]).toBe(`ok    home      ${home} (not created yet; the daemon creates it)`);
        expect(lines[1]).toMatch(/^ok {4}node {6}v\d+/);
        expect(lines[4]).toBe(`ok    pi        ${process.execPath} (no config.yaml, defaults)`);
        expect(lines[8]).toBe("ok    slack     SLACK_USER_TOKEN present");
        expect(lines[10]).toMatch(/^ok {4}diffview {2}not fetched \(optional; the first diff tab/);
        expect(out.join("\n")).not.toContain("xoxp-not-a-real-token");
    });

    it("rejects arguments", async () => {
        expect(await run_cli(["doctor", "--fix"], io_for(root))).toBe(1);
        expect(err).toEqual(["spinner doctor: takes no arguments"]);
    });
});
