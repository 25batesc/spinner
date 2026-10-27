// Goal: prove that the collector turns real (scrubbed) GraphQL responses into the `pr:` facts
// of session.yaml the way docs/ARCHITECTURE.md describes: checks split from the approval
// check, threads bucketed by first author, approvals on the current head, bot_reviewed_head,
// merge-queue state. Method: load each fixture under test/fixtures/github, run the pure
// `pr_facts_from_response` with the Knit-like configuration, assert the facts, then feed the
// facts to `derive_stage` and assert the stage the fixture's `_shape` note claims.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GithubConfig, PipelineFacts, PullRequest } from "@spinner/protocol";
import { derive_stage } from "./derive-stage.js";
import {
    is_bot_login,
    is_write_call,
    parse_pr_url,
    pr_facts_from_response,
    type PrResponse,
} from "./github.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "..", "..", "test", "fixtures", "github");

function load(name: string): PrResponse {
    return JSON.parse(readFileSync(resolve(fixtures, `${name}.json`), "utf8")) as PrResponse;
}

const config: GithubConfig = {
    bot_logins: ["devin-ai-integration[bot]", "sonarqubecloud[bot]"],
    approval_check: "Independent Approval",
    approval_policy: { human_author: ["peer"], bot_author: ["peer", "owner"] },
    merge_queue: "github",
    poll_seconds: 60,
};
const context = { config, owner_login: "owner-1" };

function facts(pr: PullRequest, verified: boolean): PipelineFacts {
    return {
        now: "2026-10-27T00:00:00Z",
        has_commits: true,
        closed: false,
        prs: [{ repo: "backend", ...pr }],
        pipeline: {
            verified_locally: verified,
            verified_heads: verified ? { backend: pr.head } : {},
            slack_post: null,
        },
        bots_expected: true,
        stale_after_hours: 3,
    };
}

describe("pr-approving fixture", () => {
    const pr = pr_facts_from_response(load("pr-approving"), context);

    it("splits the approval check out of a green rollup", () => {
        expect(pr.checks).toBe("green");
        // The org's approval check is a status context that reads FAILURE while it waits.
        expect(pr.approval_check).toBe("fail");
    });

    it("counts resolved bot threads and finds the latest bot review head", () => {
        expect(pr.threads).toEqual({ bots_open: 0, humans_open: 0, resolved: 2 });
        expect(pr.bot_reviewed_head).toBe("e8f0d1038970a76b457776a5028ba08263405a44");
        expect(pr.review).toBe("none");
        expect(pr.queue).toBe("none");
    });

    it("is verifying until the tick, then peer-review (no reviewer activity yet)", () => {
        expect(derive_stage(facts(pr, false)).stage).toBe("verifying");
        const result = derive_stage(facts(pr, true));
        expect(result.stage).toBe("peer-review");
    });
});

describe("pr-fixing fixture", () => {
    const pr = pr_facts_from_response(load("pr-fixing"), context);

    it("buckets two open bot threads and a human author", () => {
        expect(pr.threads).toEqual({ bots_open: 2, humans_open: 0, resolved: 0 });
        expect(pr.author).toBe("human-1");
        expect(pr.approvals.required).toEqual(["peer"]);
    });

    it("derives fixing", () => {
        expect(derive_stage(facts(pr, true)).stage).toBe("fixing");
    });
});

describe("pr-bot-authored fixture", () => {
    const pr = pr_facts_from_response(load("pr-bot-authored"), context);

    it("applies the bot-author approval rule", () => {
        expect(pr.author).toBe("devin-ai-integration");
        expect(pr.approvals).toEqual({ required: ["peer", "owner"], peer: [], owner: false });
        expect(pr.checks).toBe("green");
        expect(pr.threads).toEqual({ bots_open: 0, humans_open: 0, resolved: 0 });
    });

    it("records the bot review on an earlier head, and derives verifying", () => {
        expect(pr.bot_reviewed_head).not.toBeNull();
        expect(pr.bot_reviewed_head).not.toBe(pr.head);
        const result = derive_stage(facts(pr, false));
        expect(result.needs_human).toBe(`verify locally (backend#${pr.number})`);
    });
});

describe("pr-merged-after-popout fixture", () => {
    const response = load("pr-merged-after-popout");
    const pr = pr_facts_from_response(response, context);

    it("is merged, not popped: the last removal reason is `merged`", () => {
        expect(pr.state).toBe("merged");
        expect(pr.queue).toBe("none");
        expect(derive_stage(facts(pr, true))).toEqual({
            stage: "merged",
            needs_human: "close or reset",
            stale: false,
        });
    });

    it("reads a pop-out from the timeline while the rejected head is still the head", () => {
        // Rewind the fixture to the moment after the first removal: the PR is open and its
        // head is the commit the queue rejected.
        const node = response.data.repository.pullRequest;
        const removal = node.timelineItems.nodes[1];
        expect(removal?.__typename).toBe("RemovedFromMergeQueueEvent");
        const rejected =
            removal?.__typename === "RemovedFromMergeQueueEvent"
                ? removal.beforeCommit?.oid
                : undefined;
        expect(rejected).toBeDefined();
        const popped: PrResponse = {
            data: {
                repository: {
                    pullRequest: {
                        ...node,
                        state: "OPEN",
                        headRefOid: rejected as string,
                        timelineItems: { nodes: node.timelineItems.nodes.slice(0, 2) },
                    },
                },
            },
        };
        const facts_popped = pr_facts_from_response(popped, context);
        expect(facts_popped.queue).toBe("popped");
        expect(facts_popped.queue_reason).toBe("failed_checks");
        const result = derive_stage(facts(facts_popped, true));
        expect(result.stage).toBe("queued");
        expect(result.needs_human).toMatch(/^popped out of queue: failed_checks/);
    });

    it("goes back to the normal path once a new head is pushed after the pop-out", () => {
        const node = response.data.repository.pullRequest;
        const pushed: PrResponse = {
            data: {
                repository: {
                    pullRequest: {
                        ...node,
                        state: "OPEN",
                        timelineItems: { nodes: node.timelineItems.nodes.slice(0, 2) },
                    },
                },
            },
        };
        expect(pr_facts_from_response(pushed, context).queue).toBe("none");
    });

    it("counts approvals only on the current head", () => {
        // The peer approved an earlier commit; GitHub kept the approval but the board does
        // not, so a push asks for it again.
        expect(pr.review).toBe("approved");
        expect(pr.approvals.peer).toEqual([]);
    });
});

describe("helpers", () => {
    it("matches bot logins with and without the [bot] suffix", () => {
        expect(is_bot_login("devin-ai-integration", config.bot_logins)).toBe(true);
        expect(is_bot_login("sonarqubecloud[bot]", config.bot_logins)).toBe(true);
        expect(is_bot_login("human-1", config.bot_logins)).toBe(false);
    });

    it("parses PR URLs and rejects anything else", () => {
        expect(parse_pr_url("https://github.com/acme/backend/pull/412")).toEqual({
            owner: "acme",
            name: "backend",
            number: 412,
        });
        expect(parse_pr_url("https://github.com/acme/backend/issues/412")).toBeNull();
        expect(parse_pr_url("acme/backend#412")).toBeNull();
    });

    it("refuses gh write calls", () => {
        const read = ["api", "graphql", "-f", "query=query { viewer { login } }"];
        expect(is_write_call(read)).toBe(false);
        expect(is_write_call(["api", "graphql", "-f", "query=mutation { x }"])).toBe(true);
        expect(is_write_call(["api", "-X", "POST", "repos/a/b/issues"])).toBe(true);
        expect(is_write_call(["pr", "merge", "1"])).toBe(true);
        expect(is_write_call(["pr", "view", "1", "--json", "state"])).toBe(false);
    });
});
