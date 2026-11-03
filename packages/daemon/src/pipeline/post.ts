// `spinner post <session>`: composes the Slack message for the session's PR set (the PR
// links, the Goal in one line or the approved design doc's first sentence and path, a tagged
// reviewer when one is named), shows it, and posts it as the operator only on confirmation.
// The permalink goes into `pipeline.slack_post`; the poller then reads replies and reactions
// under it into `pipeline.slack_activity`, which is what tells the board a reviewer
// responded. The daemon never posts on its own.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
    PipelineConfig,
    PostRequest,
    PostView,
    PrLink,
    Session,
    SessionSummary,
    SlackActivity,
} from "@spinner/protocol";
import { approved_doc_of, overview_line } from "../egm/pr-body.js";
import type { SpinnerHome } from "../home.js";
import { read_session, write_session } from "../store/session-store.js";
import { append_log_line, mission_section } from "./mission-sections.js";
import { clock } from "./pr.js";
import { parse_permalink, type SlackClient } from "./slack.js";
import { refresh_session, session_prs } from "./tracker.js";

export interface PostDeps {
    config: PipelineConfig;
    slack: SlackClient;
    log?: (line: string) => void;
    now?: () => Date;
}

/** The approved design doc as `post` reads it: the repo-relative path and the text. */
export interface PostDesign {
    path: string;
    text: string;
}

/**
 * Pure: what `post` would send, and why it would refuse. With an approved design doc, the
 * summary line is the doc's first Overview sentence and a line names the doc (6.10); else
 * the summary line is the Goal's first line.
 */
export function compose_post(
    summary: SessionSummary,
    mission: string,
    design: PostDesign | null,
    config: PipelineConfig,
    slack: Pick<SlackClient, "transport">,
    to: string | undefined,
): PostView {
    const session = summary.session;
    const prs: PrLink[] = session_prs(session).map((pr) => ({
        repo: pr.repo,
        number: pr.number,
        url: pr.url,
        title: pr.title ?? `${pr.repo}#${pr.number}`,
        state: pr.state,
    }));
    const reviewer = to ?? session.pipeline?.reviewer ?? null;
    const goal =
        design === null
            ? first_line(mission_section(mission, "Goal"))
            : overview_line(design.text);
    const lines = [`*${session.title}* (${session.id})`];
    if (goal.length > 0) {
        lines.push(goal);
    }
    if (design !== null) {
        lines.push(`Design: \`${design.path}\``);
    }
    for (const pr of prs) {
        lines.push(`• ${pr.repo}: <${pr.url}|#${pr.number} ${pr.title}>`);
    }
    if (reviewer !== null) {
        lines.push(`${mention(reviewer)} could you review?`);
    }
    return {
        channel: config.slack.channel ?? null,
        text: lines.join("\n"),
        reviewer,
        prs,
        transport: slack.transport,
        blocked: blocked_reason(session, prs, config),
        posted: session.pipeline?.slack_post ?? null,
    };
}

function blocked_reason(session: Session, prs: PrLink[], config: PipelineConfig): string | null {
    if (config.slack.post === "never") {
        return "pipeline.slack.post is never";
    }
    if (config.slack.channel === undefined) {
        return "no pipeline.slack.channel configured";
    }
    if (prs.filter((pr) => pr.state === "open").length === 0) {
        return "no open PR to post";
    }
    if (session.pipeline?.verified_locally !== true) {
        return "not verified: run spinner verify first";
    }
    const posted = session.pipeline.slack_post;
    if (posted !== null && posted !== undefined) {
        return `already posted: ${posted}`;
    }
    return null;
}

/** `<@U123>` for a user id, `@name` as typed otherwise. */
function mention(reviewer: string): string {
    if (/^[UW][A-Z0-9]{6,}$/.test(reviewer)) {
        return `<@${reviewer}>`;
    }
    return reviewer.startsWith("@") ? reviewer : `@${reviewer}`;
}

function first_line(text: string): string {
    return text.split("\n")[0]?.trim() ?? "";
}

export function read_mission(summary: SessionSummary): string {
    const path = join(summary.path, "MISSION.md");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function post_view(
    summary: SessionSummary,
    config: PipelineConfig,
    slack: Pick<SlackClient, "transport">,
    to: string | undefined,
): PostView {
    return compose_post(summary, read_mission(summary), read_design(summary), config, slack, to);
}

/** The approved doc from the designs repo's worktree; null without one or when it is missing. */
export function read_design(summary: SessionSummary): PostDesign | null {
    const doc = approved_doc_of(summary);
    if (doc === null || !existsSync(doc.absolute)) {
        return null;
    }
    return { path: doc.path, text: readFileSync(doc.absolute, "utf8") };
}

/**
 * Posts the composed message. The caller has shown it and the operator confirmed
 * (`PostRequest.confirm` is `true` by type; the route refuses anything else).
 */
export async function post_message(
    home: SpinnerHome,
    summary: SessionSummary,
    input: PostRequest,
    deps: PostDeps,
): Promise<{ summary: SessionSummary; view: PostView }> {
    assert.equal(input.confirm, true, "post needs the operator's confirmation");
    const now = deps.now ?? (() => new Date());
    const view = post_view(summary, deps.config, deps.slack, input.to);
    if (view.blocked !== null) {
        throw new Error(`post refused: ${view.blocked}`);
    }
    assert.ok(view.channel !== null);
    deps.log?.(`posting to ${view.channel} via ${view.transport}`);
    const result = await deps.slack.post(view.channel, view.text);
    const at = now();
    const pipeline = summary.session.pipeline ?? { verified_locally: false, slack_post: null };
    const session: Session = {
        ...summary.session,
        pipeline: {
            ...pipeline,
            slack_post: result.permalink,
            posted_at: at.toISOString(),
            reviewer: view.reviewer,
            slack_activity: {
                replies: 0,
                reactions: 0,
                last_activity: null,
                polled_at: at.toISOString(),
            },
        },
    };
    const refreshed = refresh_session(summary.session, session, deps.config, at);
    write_session({ ...summary, session: refreshed.session });
    log_post(summary, result.permalink, at);
    deps.log?.(`posted ${result.permalink}`);
    const check = read_session(home, summary.dir);
    assert.ok(check.ok, "a posted session must read back");
    return { summary: check.summary, view: { ...view, posted: result.permalink } };
}

function log_post(summary: SessionSummary, permalink: string, now: Date): void {
    const path = join(summary.path, "MISSION.md");
    if (!existsSync(path)) {
        return;
    }
    const text = readFileSync(path, "utf8");
    writeFileSync(path, append_log_line(text, clock(now), "spinner", `post: ${permalink}`));
}

/** Pure: the activity counts from one poll of the post's thread. */
export function activity_from_thread(
    thread: { replies: { ts: string }[]; reactions: { count: number }[] },
    now: Date,
): SlackActivity {
    const latest = thread.replies.reduce((max, reply) => Math.max(max, Number(reply.ts)), 0);
    return {
        replies: thread.replies.length,
        reactions: thread.reactions.reduce((sum, reaction) => sum + reaction.count, 0),
        last_activity: latest === 0 ? null : new Date(latest * 1000).toISOString(),
        polled_at: now.toISOString(),
    };
}

/**
 * Reads the replies and reactions under the session's post into `pipeline.slack_activity`.
 * Returns the activity, or null when the session has no post. Read-only on Slack.
 */
export async function poll_slack_activity(
    summary: SessionSummary,
    slack: SlackClient,
    config: PipelineConfig,
    now: Date,
): Promise<SlackActivity | null> {
    const permalink = summary.session.pipeline?.slack_post;
    if (permalink === null || permalink === undefined) {
        return null;
    }
    const ref = parse_permalink(permalink);
    if (ref === null) {
        throw new Error(`slack_post "${permalink}" is not a Slack permalink`);
    }
    const thread = await slack.activity(ref.channel, ref.ts);
    const activity = activity_from_thread(thread, now);
    const pipeline = summary.session.pipeline;
    assert.ok(pipeline !== undefined);
    const session: Session = {
        ...summary.session,
        pipeline: { ...pipeline, slack_activity: activity },
    };
    const refreshed = refresh_session(summary.session, session, config, now);
    const before = JSON.stringify(summary.session);
    if (JSON.stringify(refreshed.session) !== before) {
        write_session({ ...summary, session: refreshed.session });
    }
    return activity;
}
