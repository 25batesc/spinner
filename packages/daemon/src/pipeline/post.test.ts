// Goal: prove that `spinner post` composes the message from the PR set and the Goal, refuses
// while anything blocks it (no channel, not verified, already posted), posts only with
// `confirm: true`, stores the permalink, and that the activity poll reads replies into the
// facts. Method: the fixture Slack client (no token in the environment) against a temporary
// SPINNER_HOME; the canned replies under `test/fixtures/slack/`.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { beforeEach, describe, expect, it } from "vitest";
import type { PipelineConfig, Session, SessionSummary } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { create_session, read_session, write_session } from "../store/session-store.js";
import { pipeline_config_from_spec } from "./config.js";
import { compose_post, poll_slack_activity, post_message, post_view } from "./post.js";
import { fixture_client, parse_permalink, slack_client_from_env } from "./slack.js";

let home: SpinnerHome;

function config_with(slack: Record<string, unknown>): PipelineConfig {
    return pipeline_config_from_spec({ pipeline: { slack } });
}

function session_with_pr(verified: boolean): SessionSummary {
    const created = create_session(home, { title: "Refund flow" });
    const session: Session = {
        ...created.session,
        repos: {
            backend: {
                path: "~/code/backend",
                changed: true,
                pr: {
                    number: 412,
                    url: "https://github.com/acme/backend/pull/412",
                    title: "Refund workflow",
                    author: "owner-1",
                    state: "open",
                    head: "9f3c1e2",
                    checks: "green",
                    approval_check: "pending",
                    approvals: { required: ["peer"], peer: [], owner: false },
                    threads: { bots_open: 0, humans_open: 0, resolved: 0 },
                    review: "none",
                    bot_reviewed_head: "9f3c1e2",
                    queue: "none",
                    last_activity: "2026-10-27T00:00:00Z",
                },
            },
        },
        pipeline: {
            verified_locally: verified,
            verified_heads: verified ? { backend: "9f3c1e2" } : {},
            slack_post: null,
        },
    };
    write_session({ ...created, session });
    writeFileSync(
        join(created.path, "MISSION.md"),
        "# s1\n\n## Goal\nCustomers can request a refund.\nMore detail.\n\n## Log\n",
    );
    const read = read_session(home, created.dir);
    if (!read.ok) {
        throw new Error(read.error);
    }
    return read.summary;
}

function read_yaml(dir: string): Session {
    return parse(readFileSync(join(home.sessions, dir, "session.yaml"), "utf8")) as Session;
}

beforeEach(() => {
    home = resolve_home({ SPINNER_HOME: join(mkdtempSync(join(tmpdir(), "spinner-post-")), "h") });
});

describe("compose_post", () => {
    it("is each PR's title with its link under it, then the tagged reviewer", () => {
        const summary = session_with_pr(true);
        const config = config_with({ channel: "C0TEST" });
        const fixture = { transport: "fixture" as const };
        const view = compose_post(summary, config, fixture, "U0REVIEWER1");
        expect(view.text).toBe(
            [
                "Refund workflow",
                "https://github.com/acme/backend/pull/412",
                "<@U0REVIEWER1> could you review?",
            ].join("\n"),
        );
        expect(view.channel).toBe("C0TEST");
        expect(view.blocked).toBeNull();
        expect(view.posted).toBeNull();
        expect(view.prs).toHaveLength(1);
    });

    it("keeps the design doc out of the message: the PR body names it (6.9)", () => {
        const created = session_with_pr(true);
        const worktree = "worktrees/backend";
        const doc_path = "docs/designs/refunds.md";
        const dir = join(created.path, worktree, "docs", "designs");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "refunds.md"), "# Refunds\n\n## Overview\nOne click.\n");
        const backend = created.session.repos["backend"];
        if (backend === undefined) {
            throw new Error("no backend");
        }
        const approved = {
            path: doc_path,
            repo: "backend",
            sha256: "ab",
            at: "2026-11-03T00:00:00Z",
            blockers: 0,
            round: 1,
        };
        const session: Session = {
            ...created.session,
            repos: { backend: { ...backend, worktree } },
            design: { track: "design", doc: doc_path, repo: "backend", approved },
        };
        write_session({ ...created, session });
        const read = read_session(home, created.dir);
        if (!read.ok) {
            throw new Error(read.error);
        }
        const fixture = { transport: "fixture" as const };
        const config = config_with({ channel: "C0TEST" });
        const view = post_view(read.summary, config, fixture, undefined);
        expect(view.text).toBe(
            ["Refund workflow", "https://github.com/acme/backend/pull/412"].join("\n"),
        );
        expect(view.text).not.toContain("refunds.md");
    });

    it("keeps the Goal out of the message too, with or without a design block", () => {
        const summary = session_with_pr(true);
        const fixture = { transport: "fixture" as const };
        const view = post_view(summary, config_with({ channel: "C0TEST" }), fixture, undefined);
        expect(view.text.split("\n")).toEqual([
            "Refund workflow",
            "https://github.com/acme/backend/pull/412",
        ]);
    });

    it("names what blocks the post", () => {
        const fixture = { transport: "fixture" as const };
        const unverified = session_with_pr(false);
        const no_channel = config_with({});
        expect(compose_post(unverified, no_channel, fixture, undefined).blocked).toBe(
            "no pipeline.slack.channel configured",
        );
        const config = config_with({ channel: "C0TEST" });
        expect(compose_post(unverified, config, fixture, undefined).blocked).toBe(
            "not verified: run spinner verify first",
        );
        const never = config_with({ channel: "C0TEST", post: "never" });
        const verified = session_with_pr(true);
        expect(compose_post(verified, never, fixture, undefined).blocked).toBe(
            "pipeline.slack.post is never",
        );
    });
});

describe("post_message", () => {
    it("posts through the fixture, stores the permalink, logs it, refuses twice", async () => {
        const summary = session_with_pr(true);
        const config = config_with({ channel: "C0TEST" });
        const at = (): Date => new Date(1_761_600_000_000);
        const slack = fixture_client(join(summary.path, "artifacts"), at);
        const log: string[] = [];
        const result = await post_message(home, summary, { confirm: true, to: "@sam" }, {
            config,
            slack,
            log: (line) => log.push(line),
        });
        const permalink = "https://fixture.slack.invalid/archives/C0TEST/p1761600000000100";
        expect(result.view.posted).toBe(permalink);
        const session = read_yaml(summary.dir);
        expect(session.pipeline?.slack_post).toBe(permalink);
        expect(session.pipeline?.reviewer).toBe("@sam");
        expect(session.pipeline?.slack_activity?.replies).toBe(0);
        expect(session.stage).toBe("peer-review");
        expect(existsSync(join(summary.path, "artifacts", "slack-post.json"))).toBe(true);
        const recorded = JSON.parse(
            readFileSync(join(summary.path, "artifacts", "slack-post.json"), "utf8"),
        ) as { text: string; channel: string };
        expect(recorded.channel).toBe("C0TEST");
        expect(recorded.text).toContain("@sam could you review?");
        expect(readFileSync(join(summary.path, "MISSION.md"), "utf8")).toMatch(
            /- \d\d:\d\d spinner: post: https:\/\/fixture/,
        );
        expect(log.some((line) => line.startsWith("posted https://fixture"))).toBe(true);

        const again = read_session(home, summary.dir);
        if (!again.ok) {
            throw new Error(again.error);
        }
        await expect(
            post_message(home, again.summary, { confirm: true }, { config, slack }),
        ).rejects.toThrow(/post refused: already posted/);
    });

    it("picks the fixture without SLACK_USER_TOKEN, the API with it", () => {
        const client = slack_client_from_env({}, "/tmp/unused");
        expect(client.transport).toBe("fixture");
        expect(slack_client_from_env({ SLACK_USER_TOKEN: "xoxp-test" }, "/tmp/x").transport).toBe(
            "slack",
        );
    });
});

describe("slack activity", () => {
    it("polls the canned replies into pipeline.slack_activity", async () => {
        const summary = session_with_pr(true);
        const config = config_with({ channel: "C0TEST" });
        const slack = fixture_client(join(summary.path, "artifacts"));
        const posted = await post_message(home, summary, { confirm: true }, { config, slack });
        const activity = await poll_slack_activity(posted.summary, slack, config, new Date());
        expect(activity).toEqual({
            replies: 2,
            reactions: 1,
            last_activity: new Date(1_761_601_200_000).toISOString(),
            polled_at: expect.any(String) as string,
        });
        expect(read_yaml(summary.dir).pipeline?.slack_activity?.replies).toBe(2);
    });

    it("parses channel and ts from a permalink", () => {
        const link = "https://acme.slack.com/archives/C0ABC/p1761600000000100";
        expect(parse_permalink(link)).toEqual({ channel: "C0ABC", ts: "1761600000.000100" });
        expect(parse_permalink("https://example.com/x")).toBeNull();
    });
});
