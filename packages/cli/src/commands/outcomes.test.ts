// Goal: `spinner outcomes` prints one row per track with the sessions, the PRs and the mean
// fixer rounds and operator steers per PR (docs/designs/egm-adoption.md, entry 6.21). A reset
// session counts the PRs of its earlier rounds, and a PR in both a round and `repos` counts
// once. Sessions without `outcomes`, without a `design` block or without a PR are left out.
// Method: a scratch home with real session directories, live and archived, through the
// public `run_cli` entry; the printed table is compared line by line.
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { create_session, resolve_home, write_session, type SpinnerHome } from "@spinner/daemon";
import type { DesignTrack, OutcomeCounts, PullRequest, RoundRecord } from "@spinner/protocol";
import { run_cli, type CliIo } from "../cli.js";

let root: string;
let home: SpinnerHome;
let out: string[];
let err: string[];

function io(): CliIo {
    return {
        env: { SPINNER_HOME: home.root },
        out: (line) => out.push(line),
        err: (line) => err.push(line),
    };
}

function pr(repo: string, number: number): PullRequest {
    return {
        number,
        url: `https://github.com/acme/${repo}/pull/${number}`,
        author: "owner-1",
        state: "open",
        head: "abc1234",
        checks: "green",
        approval_check: "pending",
        approvals: { required: [], peer: [], owner: false },
        threads: { bots_open: 0, humans_open: 0, resolved: 0 },
        review: "none",
        bot_reviewed_head: null,
        queue: "none",
        last_activity: "2026-11-03T00:00:00Z",
    };
}

function round(prs: { repo: string; number: number }[]): RoundRecord {
    return {
        round: 1,
        branch: "feat/x",
        prs: prs.map((entry) => ({ ...entry, url: null, state: "merged", merged_at: null })),
        started: null,
        ended: null,
    };
}

interface Seed {
    track: DesignTrack | null;
    outcomes: OutcomeCounts | null;
    current: number | null;
    rounds?: RoundRecord[];
}

/** One session in `home.sessions`; `archive` moves it under `home.archive` afterwards. */
function seed(title: string, input: Seed): string {
    const created = create_session(home, { title });
    const repos = {
        web: {
            path: "~/code/web",
            changed: true,
            pr: input.current === null ? null : pr("web", input.current),
        },
    };
    write_session({
        ...created,
        session: {
            ...created.session,
            repos,
            ...(input.track === null ? {} : { design: { track: input.track } }),
            ...(input.outcomes === null ? {} : { outcomes: input.outcomes }),
            ...(input.rounds === undefined ? {} : { rounds: input.rounds }),
        },
    });
    return created.dir;
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "spinner-outcomes-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home") });
    out = [];
    err = [];
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("spinner outcomes", () => {
    it("prints the means per PR for each track, with the PRs of earlier rounds", async () => {
        // Design: a reset session with web#41 in round 1 and web#57 now (2 PRs), and one
        // whose only PR is in both round 1 and `repos` (1 PR). 3 PRs, 2 + 1 fix rounds.
        seed("Design reset", {
            track: "design",
            outcomes: { fix_rounds: 2, operator_steers: 1 },
            current: 57,
            rounds: [round([{ repo: "web", number: 41 }])],
        });
        seed("Design same PR", {
            track: "design",
            outcomes: { fix_rounds: 1, operator_steers: 3 },
            current: 12,
            rounds: [round([{ repo: "web", number: 12 }])],
        });
        // Direct: two sessions with one PR each. 2 PRs, 3 fix rounds, 5 steers.
        seed("Direct one", {
            track: "direct",
            outcomes: { fix_rounds: 3, operator_steers: 4 },
            current: 7,
        });
        seed("Direct two", {
            track: "direct",
            outcomes: { fix_rounds: 0, operator_steers: 1 },
            current: 8,
        });
        // Left out: no outcomes, no design block, no PR.
        seed("No outcomes", { track: "design", outcomes: null, current: 1 });
        const nine = { fix_rounds: 9, operator_steers: 9 };
        seed("Legacy", { track: null, outcomes: nine, current: 2 });
        seed("No PR", { track: "direct", outcomes: nine, current: null });

        const code = await run_cli(["outcomes"], io());
        expect(err).toEqual([]);
        expect(code).toBe(0);
        expect(out).toEqual([
            "track   sessions  PRs  fix_rounds/PR  operator_steers/PR",
            "design  2         3    1.00           1.33",
            "direct  2         2    1.50           2.50",
        ]);
    });

    it("reads archived sessions and prints `-` for a track without PRs", async () => {
        const dir = seed("Archived design", {
            track: "design",
            outcomes: { fix_rounds: 1, operator_steers: 0 },
            current: 3,
        });
        mkdirSync(home.archive, { recursive: true });
        renameSync(join(home.sessions, dir), join(home.archive, dir));

        const code = await run_cli(["outcomes"], io());
        expect(code).toBe(0);
        expect(out).toEqual([
            "track   sessions  PRs  fix_rounds/PR  operator_steers/PR",
            "design  1         1    1.00           0.00",
            "direct  0         0    -              -",
        ]);
    });

    it("refuses arguments", async () => {
        expect(await run_cli(["outcomes", "extra"], io())).toBe(1);
        expect(err).toEqual(['spinner outcomes: takes no arguments, got "extra"']);
    });
});
