// Goal: `spinner board` prints one line per session with the ones that need the operator on
// top, and `spinner adopt` / `spinner verify` reject bad input before touching GitHub.
// Method: write session.yaml files by hand into a temporary SPINNER_HOME (the daemon tests
// cover the GitHub side with fixtures), run the commands through `run_cli`, read the output.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Session, Stage } from "@spinner/protocol";
import { run_cli, type CliIo } from "../cli.js";
import { sort_board } from "./board.js";

let root: string;
let out: string[];
let err: string[];
let io: CliIo;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "spinner-board-cli-"));
    out = [];
    err = [];
    io = {
        env: { SPINNER_HOME: root },
        out: (line) => out.push(line),
        err: (line) => err.push(line),
    };
});

function write_session(id: string, stage: Stage, needs_human: string | null, pr = true): void {
    const session: Session = {
        version: 1,
        id,
        slug: "x",
        title: "x",
        created: "2026-10-26",
        stage,
        needs_human,
        branch: "feat/x",
        base: "main",
        repos: {
            backend: {
                path: "~/code/backend",
                changed: true,
                pr: pr
                    ? {
                          number: 1,
                          url: "https://github.com/acme/backend/pull/1",
                          author: "owner-1",
                          state: "open",
                          head: "abc1234",
                          checks: "green",
                          approval_check: "pending",
                          approvals: { required: ["peer"], peer: ["human-1"], owner: false },
                          threads: { bots_open: 0, humans_open: 1, resolved: 2 },
                          review: "none",
                          bot_reviewed_head: "abc1234",
                          queue: "none",
                          last_activity: "2026-10-26T09:12:00Z",
                      }
                    : null,
            },
        },
        stack: { state: "none" },
        agents: {},
    };
    const dir = join(root, "sessions", `${id}-x`);
    mkdirSync(dir, { recursive: true });
    // JSON is valid YAML, which keeps this package free of a yaml dependency.
    writeFileSync(join(dir, "session.yaml"), JSON.stringify(session, null, 2));
}

describe("spinner board", () => {
    it("prints sessions that need you first, with a PR summary line", async () => {
        write_session("s001", "peer-review", null);
        write_session("s002", "approving", "approve backend#1");
        write_session("s003", "fixing", null, false);
        expect(await run_cli(["board"], io)).toBe(0);
        expect(out[0]).toMatch(/^s002-x\s+approving\s+← approve backend#1$/);
        expect(out[1]).toBe(
            "    backend#1 open checks green threads 0b/1h open review none approvals 1/1",
        );
        expect(out[2]).toMatch(/^s001-x\s+peer-review\s*$/);
        expect(out[4]).toMatch(/^s003-x\s+fixing/);
        expect(err).toEqual([]);
    });

    it("says when there are no sessions", async () => {
        expect(await run_cli(["board"], io)).toBe(0);
        expect(out[0]).toMatch(/^no sessions under /);
    });

    it("sorts by needs_human, then later stages first, then by name", () => {
        const entry = (dir: string, stage: Stage, needs_human: string | null) => ({
            dir,
            path: join(root, "sessions", dir),
            session: { stage, needs_human } as Session,
        });
        const sorted = sort_board([
            entry("s001-x", "building", null),
            entry("s002-x", "queued", null),
            entry("s003-x", "verifying", "verify locally"),
            entry("s000-x", "queued", null),
        ]);
        expect(sorted.map((item) => item.dir)).toEqual(["s003-x", "s000-x", "s002-x", "s001-x"]);
    });
});

describe("spinner adopt and verify argument checks", () => {
    it("adopt needs a URL and rejects a non-PR URL without calling gh", async () => {
        expect(await run_cli(["adopt"], io)).toBe(1);
        expect(err[0]).toMatch(/URL is required/);
        expect(await run_cli(["adopt", "https://github.com/acme/backend/issues/1"], io)).toBe(1);
        expect(err.at(-1)).toMatch(/not a GitHub pull request URL/);
    });

    it("verify needs an existing session with a PR", async () => {
        expect(await run_cli(["verify"], io)).toBe(1);
        expect(err[0]).toMatch(/a session is required/);
        write_session("s001", "building", null, false);
        expect(await run_cli(["verify", "s001"], io)).toBe(1);
        expect(err.at(-1)).toMatch(/has no PR to verify/);
    });

    it("verify records the tick and re-derives the stage", async () => {
        write_session("s001", "verifying", "verify locally (backend#1)");
        expect(await run_cli(["verify", "s001"], io)).toBe(0);
        expect(out[0]).toBe("verified s001-x: backend@abc1234");
        // The hand-written PR has an open human thread, so the tick lands in addressing.
        expect(out[1]).toBe("stage: addressing; needs_human: -");
    });
});
