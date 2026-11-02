// The Reviews panel's rules: a review session never shows among the ordinary sessions and
// the reverse; the cards order by last activity; the CI pill names the failing checks; the
// swarm line counts. Checked through the functions the components call.
import { expect, it } from "vitest";

import type { PrFacts, ReviewFields, SessionView } from "@spinner/protocol";

import {
    ciPill,
    decisionPill,
    ordinarySessions,
    reviewFacts,
    reviewsByActivity,
    swarmDot,
    swarmLine,
} from "./review.ts";

function pr(partial: Partial<PrFacts> = {}): PrFacts {
    return {
        repo: "peanut", number: 51, url: "https://github.com/example/peanut/pull/51",
        author: "casey", state: "open", head: "abc1234", checks: "green",
        approval_check: "pending", approvals: { required: ["peer"], peer: [], owner: false },
        threads: { bots_open: 1, humans_open: 2, resolved: 3 }, review: "none",
        bot_reviewed_head: null, queue: "none", last_activity: "2026-11-02T10:00:00Z",
        ...partial,
    };
}

function view(
    dir: string, kind: "session" | "review", prs: PrFacts[], review?: ReviewFields,
): SessionView {
    const session = {
        version: 1 as const, created: "2026-11-01T09:00:00Z", stage: "peer-review" as const,
        needs_human: null, branch: "fix/retry", base: "main", repos: {},
        stack: { state: "none" as const }, agents: {},
        pipeline: { verified_locally: false, slack_post: null }, id: dir, slug: dir,
        title: `Title ${dir}`,
    };
    const typed: SessionView = {
        summary: { dir, path: `/home/x/${dir}`, session },
        board: prs.length === 0
            ? null
            : { stage: "peer-review", needs_human: null, stale: false, prs },
        stack: {
            state: "none", project: null, database: null, services: [], observed: null,
            last_job: null,
        },
        agents_running: [], can_verify: false, kind,
        cost: { usd: 1.5, tokens_in: 10, tokens_out: 5, agents: {} },
        ...(review === undefined ? {} : { review }),
    };
    return typed;
}

const fields: ReviewFields = {
    checks: "red", failing: ["lint", "e2e"], review_decision: "changes_requested", threads: 7,
    swarm: [
        { name: "review-opus", model: "anthropic/opus", state: "posted", usd: 0.4, pr: "peanut" },
        { name: "review-gpt", model: "openai/gpt", state: "failed", usd: 0.1, pr: "peanut" },
        { name: "review-grok", model: "x-ai/grok", state: "queued", usd: 0, pr: "peanut" },
    ],
};

it("keeps reviews out of the sessions list and ordinary sessions out of the reviews", () => {
    const all: [string, SessionView][] = [
        ["r1", view("r1", "review", [pr()], fields)],
        ["s1", view("s1", "session", [pr()])],
    ];
    expect(ordinarySessions(all).map(([dir]) => dir)).toEqual(["s1"]);
    expect(reviewsByActivity(all).map((facts) => facts.dir)).toEqual(["r1"]);
    expect(reviewFacts(all[1]![1])).toBeNull();
});

it("orders the reviews by the PR's last activity, the latest first", () => {
    const all: [string, SessionView][] = [
        ["old", view("old", "review", [pr({ last_activity: "2026-11-01T10:00:00Z" })], fields)],
        ["new", view("new", "review", [pr({ last_activity: "2026-11-02T10:00:00Z" })], fields)],
    ];
    expect(reviewsByActivity(all).map((facts) => facts.dir)).toEqual(["new", "old"]);
});

it("reads the review fields over the PR facts, and falls back to the PR facts", () => {
    const full = reviewFacts(view("r1", "review", [pr()], fields));
    expect(full).toMatchObject({
        title: "Title r1", author: "casey", branch: "fix/retry", base: "main", checks: "red",
        failing: ["lint", "e2e"], decision: "changes_requested", threads: 7, usd: 1.5,
        url: "https://github.com/example/peanut/pull/51",
    });
    expect(full?.swarm).toHaveLength(3);
    const bare = reviewFacts(view("r2", "review", [pr({ review: "approved" })]));
    expect(bare).toMatchObject({ checks: "green", decision: "approved", threads: 6, swarm: [] });
});

it("names the failing checks in the red pill's tooltip", () => {
    expect(ciPill("red", ["lint", "e2e"])).toEqual({
        text: "CI red", tone: "pill-fail", title: "Failing: lint, e2e",
    });
    expect(ciPill("green", []).tone).toBe("pill-ok");
    expect(ciPill("pending", []).tone).toBe("pill-warn");
    expect(decisionPill("approved").tone).toBe("pill-ok");
    expect(decisionPill("none").tone).toBe("");
});

it("gives each swarm state its dot and counts the swarm in one line", () => {
    expect(swarmDot("reading")).toBe("dot-working");
    expect(swarmDot("posted")).toBe("dot-up");
    expect(swarmDot("failed")).toBe("dot-failed");
    expect(swarmLine(fields.swarm)).toBe("1 of 3 posted, 1 failed");
    expect(swarmLine([])).toBe("no reviewers yet");
});
