// The brief and the first message of a reviewer (MISSION.md s015): the prompt `review-blast`
// gives each of its `pi -p` agents (`~/.pi/agent/skills/review-pr/scripts/review-blast.sh`,
// `run_agent`), word for word, with the PR and the model filled in. The reviewer reads the
// diff and the code it hooks into, posts inline comments only, identifies itself as its
// model, never approves, never requests changes, never pushes, and prints the `POSTED` line
// last, which is what the daemon reads `posted` from. `review-blast` passed the prompt as the
// user message, and the skill reads blast mode from it (`REVIEW_BLAST=1`), so the kickoff
// carries the whole prompt too: a brief in the system prompt alone left the reviewer asking
// for leave to post (the e2e's first run). Without a skill directory the brief says so, and
// the reviewer follows the rules alone.
import type { PrRef } from "../pipeline/github.js";

export interface ReviewBriefInput {
    name: string;
    model: string;
    pr: PrRef;
    url: string;
    /** The review skill's directory, or null when none is configured and the default is absent. */
    skill: string | null;
}

/** The `review-blast` prompt, with the PR and the model filled in. */
export function review_prompt(input: Omit<ReviewBriefInput, "name">): string {
    const { owner, name, number } = input.pr;
    const loaded =
        input.skill === null
            ? "The review-pr skill is not installed here; follow the rules below as the skill " +
              "would: read the diff and the code it hooks into, then post."
            : "Follow the review-pr skill (already loaded via --skill). You are one reviewer " +
              "in a parallel blast; other models are reviewing the same PR independently.";
    return [
        "REVIEW_BLAST=1",
        "",
        loaded,
        "",
        `Target: ${input.url}`,
        "",
        "Hard rules:",
        `- Review ${owner}/${name}#${number} using the skill's phases. Read SKILL.md and ` +
            "references/checklist.md.",
        "- After the written review, post ONLY inline comments (Phase 6): one per blocker or " +
            "should-fix, on the changed line. Do NOT post a summary or verdict review (no gh " +
            "pr review). Nits, praise and the checklist stay unposted. If nothing needs a fix, " +
            "post nothing. A finding GitHub rejects inline goes in one short PR comment naming " +
            "file and line. Never approve, never request-changes.",
        `- Identify every comment as: **review-blast** · ${input.model}`,
        "- Do not checkout, switch, or edit the branch. Do not push. Do not commit.",
        "- Work from this checkout as-is; read files with git show / gh.",
        "- Do not duplicate a finding already on the PR unless you add a new consequence.",
        "",
        "When finished, print exactly one last line:",
        `POSTED model=${input.model} blockers=N should-fix=M`,
    ].join("\n");
}

export function render_review_brief(input: ReviewBriefInput): string {
    const { owner, name, number } = input.pr;
    return [
        `# ${input.name}`,
        "",
        `Role: reviewer of ${owner}/${name}#${number} with the model ${input.model}. This is a`,
        "Spinner review: the worktree you start in is a read-only checkout at the PR head.",
        "The operator started this swarm from Spinner and asks for the inline comments: that",
        "is the approval to post. The first message is the review prompt. Nobody waits in",
        "this terminal to say yes, so a question here goes unanswered: post, then report.",
        "",
        review_prompt(input),
        "",
    ].join("\n");
}

/**
 * The first message of a reviewer: the whole prompt again, as `review-blast` sent it, and
 * the Spinner facts it did not need: the operator approved the posts by starting the swarm.
 */
export function review_kickoff(input: Omit<ReviewBriefInput, "name">): string {
    return [
        review_prompt(input),
        "",
        "The operator, the user of this session, asks you for this specific action: post " +
            "your blocker and should-fix findings as inline review comments on the PR above, " +
            "as the rules say. That request is the approval any house rule asks for; it was " +
            "given when the operator started this swarm from Spinner. Nobody reads this " +
            "terminal while you work and no mission tool reaches a person in time: do not ask " +
            "with mission_question, do not wait for a reply, do not draft and hold. Post, " +
            "then print the POSTED line. This checkout is detached at the PR head.",
    ].join("\n");
}
