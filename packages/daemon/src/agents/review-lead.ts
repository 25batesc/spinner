// The review lead (MISSION.md s016, Plan item 2): the `reviews` job, after `create_reviews`
// made the session, starts the agent `lead` in the PR worktree with the review lead's brief
// (the operator's `pr-review` skill, `store/review-brief.ts`), sends it the PR as its first
// message, and starts the swarm. The lead writes the briefing while the reviewers read, and
// the swarm notifies it when the last verdict lands. The model is `settings.default_model`
// (the manager applies it when the request names none). An ordinary session's `review` does
// not come through here: its lead is the session's own, and the swarm's notice reaches it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionSummary } from "@spinner/protocol";
import { LEAD_NAME } from "@spinner/protocol";
import { parse_pr_url } from "../pipeline/github.js";
import { render_review_lead_brief, review_lead_kickoff } from "../store/review-brief.js";
import { agent_brief_path } from "./harness.js";
import type { AgentManager } from "./manager.js";
import type { ReviewSwarm } from "./swarm.js";

export interface ReviewLeadDeps {
    agents: AgentManager;
    swarm: ReviewSwarm;
}

/**
 * Starts the lead of a review session and its swarm. A failure to start the lead is logged
 * and the swarm still runs: the verdicts land either way, and the operator can add the lead.
 */
export async function start_review_lead(
    deps: ReviewLeadDeps,
    summary: SessionSummary,
    log: (line: string) => void,
): Promise<void> {
    const [key, repo] = Object.entries(summary.session.repos)[0] ?? [];
    assert.ok(key !== undefined && repo !== undefined, "a review session has one repo");
    const pr = repo.pr;
    assert.ok(pr !== null && pr !== undefined, "a review session tracks its PR");
    const ref = parse_pr_url(pr.url);
    assert.ok(ref !== null, `${pr.url} is not a GitHub PR URL`);
    const skill = deps.swarm.skill_dir();
    const input = { pr: ref, url: pr.url, skill, models: deps.swarm.models() };
    const brief_file = agent_brief_path(summary.path, LEAD_NAME);
    if (!existsSync(brief_file)) {
        mkdirSync(dirname(brief_file), { recursive: true });
        writeFileSync(brief_file, render_review_lead_brief(input));
    }
    try {
        const handle = await deps.agents.add(summary, { name: LEAD_NAME, repo: key });
        log(`${LEAD_NAME} started (pid ${handle.pid}) in the ${key} worktree`);
        const message = review_lead_kickoff(input, pr.head);
        try {
            const disposition = await handle.prompt(message);
            log(`${LEAD_NAME}: first message delivered (${disposition})`);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            deps.agents.queue_for_next_prompt(summary.dir, LEAD_NAME, message);
            log(`${LEAD_NAME}: first message not delivered (${reason}); it goes with the next ` +
                "prompt");
        }
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log(`${LEAD_NAME} did not start: ${reason}`);
    }
    const result = await deps.swarm.start(summary, {}, log);
    const total = result.started.length + result.queued.length + result.failed.length;
    const counts = `${result.started.length} started, ${result.queued.length} queued`;
    const failed = result.failed.length === 0 ? "" : `, ${result.failed.length} failed`;
    log(`swarm of ${total}: ${counts}${failed}`);
}
