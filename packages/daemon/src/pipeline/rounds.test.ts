// Goal: the round functions of docs/designs/egm-adoption.md, entry 2.41, follow T14:
// `round_of` for each source, `parse_previous_rounds` on the exact text `archive_round`
// writes, `rounds_of` merging records with parsed rounds, and `round_record` with a merged
// and a closed PR (entry 2.42). Method: MISSION.md text made by `archive_round` itself, and
// sessions built from `create_session`'s shape with PR facts.
import { describe, expect, it } from "vitest";
import type { PullRequest, Session } from "@spinner/protocol";
import { archive_round } from "./mission-sections.js";
import { parse_previous_rounds, round_of, round_record, rounds_of } from "./rounds.js";

const MISSION = "# s4 · Refunds\n\n## Goal\nG\n\n## Log\n- 10:00 lead: began\n";

function session(patch: Partial<Session> = {}): Session {
    return {
        version: 1,
        id: "s4",
        slug: "refunds",
        title: "Refunds",
        created: "2026-10-20T09:00:00Z",
        stage: "planned",
        needs_human: null,
        branch: "feat/refunds",
        base: "main",
        repos: {},
        stack: { state: "none" },
        agents: {},
        ...patch,
    };
}

function pr(patch: Partial<PullRequest>): PullRequest {
    return {
        number: 41,
        url: "https://github.com/acme/web/pull/41",
        author: "you",
        state: "merged",
        head: "abc",
        checks: "green",
        approval_check: "pass",
        approvals: { required: ["peer"], peer: ["p"], owner: false },
        threads: { bots_open: 0, humans_open: 0, resolved: 0 },
        review: "approved",
        bot_reviewed_head: "abc",
        queue: "none",
        last_activity: "2026-10-21T16:02:00Z",
        ...patch,
    };
}

describe("round_of", () => {
    it("reads session.round, else the -r<n> branch suffix, else 1", () => {
        expect(round_of(session({ round: 4, branch: "feat/x-r2" }))).toBe(4);
        expect(round_of(session({ branch: "feat/refunds-r3" }))).toBe(3);
        expect(round_of(session())).toBe(1);
    });
});

describe("parse_previous_rounds", () => {
    it("reads one round with its PRs and Log", () => {
        const text = archive_round(MISSION, 1, "feat/refunds · PRs: web#41 (merged)");
        expect(parse_previous_rounds(text)).toEqual([
            {
                round: 1,
                branch: "feat/refunds",
                prs: [{ repo: "web", number: 41, state: "merged" }],
                log: "- 10:00 lead: began",
            },
        ]);
    });

    it("reads two rounds, PRs: none and several PRs", () => {
        const one = archive_round(MISSION, 1, "feat/refunds · PRs: none");
        const logged = one.replace("## Log\n", "## Log\n- 11:00 lead: round two\n");
        const two = archive_round(
            logged,
            2,
            "feat/refunds-r2 · PRs: web#57 (merged), api#9 (closed)",
        );
        const rounds = parse_previous_rounds(two);
        expect(rounds.map((round) => [round.round, round.branch, round.prs.length])).toEqual([
            [1, "feat/refunds", 0],
            [2, "feat/refunds-r2", 2],
        ]);
        expect(rounds[1]?.prs[1]).toEqual({ repo: "api", number: 9, state: "closed" });
        expect(rounds[1]?.log).toBe("- 11:00 lead: round two");
    });

    it("skips a heading that does not match, with its Log", () => {
        const text = archive_round(MISSION, 1, "feat/refunds · PRs: web#41 (merged)").replace(
            "### Round 1 · feat/refunds · PRs: web#41 (merged)",
            "### Round one · feat/refunds · PRs: web#41 (landed)",
        );
        expect(parse_previous_rounds(text)).toEqual([]);
        expect(parse_previous_rounds(MISSION)).toEqual([]);
    });
});

describe("rounds_of", () => {
    it("merges a record for round 2 with a round 1 parsed from MISSION.md", () => {
        const text = archive_round(MISSION, 1, "feat/refunds · PRs: web#41 (merged)");
        const record = {
            round: 2,
            branch: "feat/refunds-r2",
            prs: [],
            started: "2026-10-22T09:00:00Z",
            ended: "2026-10-23T09:00:00Z",
        };
        const views = rounds_of(session({ rounds: [record] }), text);
        expect(views).toEqual([
            {
                round: 1,
                branch: "feat/refunds",
                prs: [{ repo: "web", number: 41, state: "merged", url: null, merged_at: null }],
                started: null,
                ended: null,
                source: "mission",
            },
            { ...record, source: "record" },
        ]);
        // A record wins over the parsed round with the same number.
        const same = rounds_of(session({ rounds: [{ ...record, round: 1 }] }), text);
        expect(same.map((view) => view.source)).toEqual(["record"]);
        expect(rounds_of(session(), null)).toEqual([]);
    });
});

describe("round_record", () => {
    it("records a merged PR with merged_at and a closed one without", () => {
        const ended = new Date("2026-10-21T17:10:00Z");
        const previous = session({
            repos: {
                web: { path: "~/web", changed: true, pr: pr({}) },
                api: {
                    path: "~/api",
                    changed: true,
                    pr: pr({ number: 9, url: "https://github.com/acme/api/pull/9", state: "closed" }),
                },
                docs: { path: "~/docs", changed: false, pr: null },
            },
        });
        expect(round_record(previous, ended)).toEqual({
            round: 1,
            branch: "feat/refunds",
            prs: [
                {
                    repo: "web",
                    number: 41,
                    url: "https://github.com/acme/web/pull/41",
                    state: "merged",
                    merged_at: "2026-10-21T16:02:00Z",
                },
                {
                    repo: "api",
                    number: 9,
                    url: "https://github.com/acme/api/pull/9",
                    state: "closed",
                    merged_at: null,
                },
            ],
            started: "2026-10-20T09:00:00Z",
            ended: "2026-10-21T17:10:00.000Z",
        });
        const later = session({
            round: 2,
            branch: "feat/refunds-r2",
            rounds: [round_record(previous, ended)],
        });
        expect(round_record(later, new Date("2026-10-23T09:00:00Z"))).toMatchObject({
            round: 2,
            prs: [],
            started: "2026-10-21T17:10:00.000Z",
        });
    });
});
