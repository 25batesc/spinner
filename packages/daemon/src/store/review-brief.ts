// The BRIEF.md of a reviewer (MISSION.md s015): the prompt `review-blast` gives each of its
// `pi -p` agents (`~/.pi/agent/skills/review-pr/scripts/review-blast.sh`, `run_agent`),
// word for word, with the PR and the model filled in. The reviewer reads the diff and the
// code it hooks into, posts inline comments only, identifies itself as its model, never
// approves, never requests changes, never pushes, and prints the `POSTED` line last, which
// is what the daemon reads `posted` from. Without a skill directory the brief says so, and
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

export function render_review_brief(input: ReviewBriefInput): string {
    const { owner, name, number } = input.pr;
    const loaded =
        input.skill === null
            ? "The review-pr skill is not installed here; follow the rules below as the skill " +
              "would: read the diff and the code it hooks into, then post."
            : "Follow the review-pr skill (already loaded via --skill). You are one reviewer " +
              "in a parallel blast; other models are reviewing the same PR independently.";
    return [
        `# ${input.name}`,
        "",
        `Role: reviewer of ${owner}/${name}#${number} with the model ${input.model}. This is a`,
        "Spinner review: the worktree you start in is a read-only checkout at the PR head.",
        "",
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
        "",
    ].join("\n");
}

/** The first message of a reviewer: start the review the brief describes. */
export function review_kickoff(url: string): string {
    return (
        `Review ${url} now, as your brief says. ` +
        "Work from this checkout; it is detached at the PR head."
    );
}
