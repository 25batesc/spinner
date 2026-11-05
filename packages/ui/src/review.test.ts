// The Reviews panel's rules: a review session never shows among the ordinary sessions and
// the reverse; the cards order by last activity; the CI pill names the failing checks; the
// swarm line counts; the lead's fields and chip (s016) read from the view. Checked through
// the functions the components call; the approve and cancel buttons (#22) through markup.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import type { PrFacts, ReviewFields, SessionView } from "@spinner/protocol";

import {
    ciPill,
    decisionPill,
    draftPill,
    leadChip,
    leadDot,
    ordinarySessions,
    prRef,
    reviewFacts,
    reviewStatePill,
    reviewsByActivity,
    swarmDot,
    swarmLine,
} from "./review.ts";
import { ReviewActions } from "./ReviewPane.tsx";

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
        { name: "review-opus", model: "anthropic/opus", state: "done", usd: 0.4, pr: "peanut" },
        { name: "review-gpt", model: "openai/gpt", state: "failed", usd: 0.1, pr: "peanut" },
        { name: "review-grok", model: "x-ai/grok", state: "queued", usd: 0, pr: "peanut" },
    ],
    briefing: true,
    draft: {
        event: "COMMENT", body: "Two things.",
        comments: [{ path: "src/a.ts", line: 3, body: "BUG: off by one" }],
    },
    posted_url: null,
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
    expect(full).toMatchObject({
        briefing: true, posted_url: null, lead: null,
        draft: { event: "COMMENT", comments: [{ path: "src/a.ts", line: 3 }] },
        // The s018 progress fields, derived when the daemon leaves them out.
        state: "drafted", comment_count: 1, event: "COMMENT",
    });
    const bare = reviewFacts(view("r2", "review", [pr({ review: "approved" })]));
    expect(bare).toMatchObject({
        checks: "green", decision: "approved", threads: 6, swarm: [],
        briefing: false, draft: null, posted_url: null,
        state: "idle", comment_count: 0, event: null,
    });
    const sent = reviewFacts(view("r3", "review", [pr()], {
        ...fields, draft: null, state: "reviewing", comment_count: 0, event: null,
    }));
    expect(sent).toMatchObject({ state: "reviewing", comment_count: 0, event: null });
    const posted = reviewFacts(view("r4", "review", [pr()], {
        ...fields, draft: null, posted_url: "https://github.com/x/y/pull/1#r1",
    }));
    expect(posted).toMatchObject({ state: "posted", comment_count: 0, event: null });
});

it("names the PR as owner/repo#n for the approve question and reads `cancelled` (#22)", () => {
    const facts = reviewFacts(view("r1", "review", [pr()], fields));
    expect(facts).toMatchObject({ pr_ref: "example/peanut#51", cancelled: false });
    const stopped = reviewFacts(view("r2", "review", [pr()], {
        ...fields, swarm: [], draft: null, state: "idle", cancelled: true,
    }));
    expect(stopped).toMatchObject({ state: "idle", cancelled: true });
    expect(prRef("https://github.com/acme/peanut/pull/9#pullrequestreview-1")).toBe(
        "acme/peanut#9",
    );
    expect(prRef("https://gitlab.com/acme/peanut/-/merge_requests/9")).toBeNull();
    expect(prRef(null)).toBeNull();
});

it("pills the review state and the draft: a count, or approve with no comment", () => {
    expect(reviewStatePill("idle")).toBeNull();
    expect(reviewStatePill("idle", true)).toMatchObject({ text: "cancelled", tone: "" });
    // A later run, draft or post is the next action: the word goes with it.
    expect(reviewStatePill("reviewing", true)?.text).toBe("reviewing");
    expect(reviewStatePill("reviewing")?.tone).toBe("pill-accent");
    expect(reviewStatePill("drafted")?.tone).toBe("pill-warn");
    expect(reviewStatePill("posted")).toMatchObject({ text: "posted", tone: "pill-ok" });
    expect(draftPill({ state: "reviewing", comment_count: 0, event: null })).toBeNull();
    expect(draftPill({ state: "drafted", comment_count: 2, event: "COMMENT" }))
        .toMatchObject({ text: "2 comments", tone: "" });
    expect(draftPill({ state: "drafted", comment_count: 1, event: "APPROVE" }))
        .toMatchObject({ text: "1 comment", tone: "" });
    expect(draftPill({ state: "drafted", comment_count: 0, event: "APPROVE" }))
        .toMatchObject({ text: "approve", tone: "pill-ok" });
    // After `post` the draft is gone and so is its pill; `posted` says it all.
    expect(draftPill({ state: "posted", comment_count: 0, event: null })).toBeNull();
});

it("reads the lead's chip from the `lead` agent: running, idle between turns, or stopped", () => {
    const base = view("r1", "review", [pr()], fields);
    expect(leadChip(base)).toBeNull();
    const lead = { harness: "tty" as const, model: "anthropic/opus", process: "running" as const };
    const withLead = (process: "running" | "idle", running: string[]): SessionView => ({
        ...base,
        summary: {
            ...base.summary,
            session: { ...base.summary.session, agents: { lead: { ...lead, process } } },
        },
        agents_running: running,
        cost: { usd: 1.5, tokens_in: 10, tokens_out: 5, agents: {
            lead: { usd: 0.7, tokens_in: 5, tokens_out: 2, model: "anthropic/opus" },
        } },
    });
    expect(leadChip(withLead("running", ["lead"]))).toEqual({
        name: "lead", model: "anthropic/opus", state: "running", usd: 0.7,
    });
    expect(leadChip(withLead("idle", ["lead"]))?.state).toBe("idle");
    expect(leadChip(withLead("idle", []))?.state).toBe("stopped");
    expect(leadDot("running")).toBe("dot-working");
    expect(leadDot("stopped")).toBe("dot-off");
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
    expect(swarmDot("done")).toBe("dot-up");
    expect(swarmDot("failed")).toBe("dot-failed");
    expect(swarmLine(fields.swarm)).toBe("1 of 3 done, 1 failed");
    expect(swarmLine([])).toBe("no reviewers yet");
});

it("offers approve on a PR and cancel review only while reviewing (#22)", () => {
    const actions = (overrides: Partial<ReviewFields>) => {
        const facts = reviewFacts(view("r1", "review", [pr()], { ...fields, ...overrides }));
        if (facts === null) {
            throw new Error("a review session has facts");
        }
        return renderToStaticMarkup(createElement(ReviewActions, { facts }));
    };
    const running = actions({ draft: null, state: "reviewing" });
    expect(running).toContain("Post APPROVE &quot;LGTM&quot; on example/peanut#51 as you");
    expect(running).toContain(">cancel review</button>");
    const drafted = actions({ state: "drafted" });
    expect(drafted).toContain(">approve</button>");
    expect(drafted).not.toContain("cancel review");
});
