// The briefs of a review (MISSION.md s016): the reviewer's and the lead's, and the notice the
// lead gets when the last verdict lands. The reviewer's brief is the operator's `reviewer`
// role (`~/.pi/agent/agents/reviewer.md`), word for word, with the Spinner facts in front:
// the PR, the detached checkout, no posting, no edits, and the `VERDICT` contract last,
// which the daemon reads the verdict file from. The lead's brief is the operator's
// `pr-review` skill, word for word, with one change: where the skill launches three
// `subagent` calls, the daemon has started the reviewers, and where the skill posts after
// the user's yes, the lead writes the draft with `review_draft` and the operator posts from
// the review pane. The rulebook (`engineer-conventions`, `backend-conventions`,
// `lead-judgment.md`) is named by path, next to `settings.review.skill`, so both agents read
// the operator's own copies.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { REVIEW_SEVERITY_LABELS, REVIEW_VERDICTS_DIR } from "@spinner/protocol";
import type { PrRef } from "../pipeline/github.js";

/** The operator's `pr-review` skill, the default when `settings.review.skill` names none. */
export function default_review_skill(): string {
    return join(homedir(), ".pi", "agent", "skills", "pr-review");
}

/** The rulebook files, resolved next to the skill directory; absent ones are named as such. */
export interface Rulebook {
    engineer_conventions: string;
    anti_slop: string;
    backend_conventions: string;
    principles: string;
    lead_judgment: string;
}

/**
 * The paths of the rulebook, from the skill directory: `<config>/skills/<name>/...` where
 * `<config>` is the skill's grandparent. With no skill, the operator's default config.
 */
export function rulebook_of(skill: string | null): Rulebook {
    const skills = dirname(skill ?? default_review_skill());
    return {
        engineer_conventions: join(skills, "engineer-conventions", "SKILL.md"),
        anti_slop: join(skills, "engineer-conventions", "references", "anti-slop.md"),
        backend_conventions: join(skills, "backend-conventions", "SKILL.md"),
        principles: join(skills, "principles", "SKILL.md"),
        lead_judgment: join(skills, "interrogate", "references", "lead-judgment.md"),
    };
}

/** The skill directories a reviewer loads with `--skill`: the `reviewer` role's two, if present. */
export function reviewer_skill_dirs(skill: string | null): string[] {
    const skills = dirname(skill ?? default_review_skill());
    return ["engineer-conventions", "principles"]
        .map((name) => join(skills, name))
        .filter((dir) => existsSync(join(dir, "SKILL.md")));
}

export interface ReviewBriefInput {
    name: string;
    model: string;
    pr: PrRef;
    url: string;
    /** The `pr-review` skill's directory; null when none is configured and none is installed. */
    skill: string | null;
}

function path_line(label: string, path: string): string {
    const state = existsSync(path) ? "" : " (not installed here; follow the rules you know)";
    return `- ${label}: \`${path}\`${state}`;
}

/** The `reviewer` role, word for word (`~/.pi/agent/agents/reviewer.md`, the body). */
const REVIEWER_ROLE = [
    "You are a read-only code reviewer. Inspect the code or diff you were given; do **not** modify",
    "project/source files. Be concise. Prefer evidence (`file:line`) over vibe.",
    "",
    "## What to look for",
    "Prioritize concrete, actionable findings. In rough priority order:",
    "1. **Correctness**. Bugs, broken edge cases, logic errors, off-by-ones, race conditions",
    "2. **Acceptance / contract**. Fails the stated criteria, verify commands, or scope boundaries",
    "3. **Regressions**. Behavior that used to work and now doesn't; missing tests for the change",
    "4. **Security**. Injection, authz gaps, secret leakage, unsafe defaults",
    "5. **Scope**. Edits outside the owned files / opportunistic refactors folded into the change",
    "6. **Anti-slop (TS/JS, changed lines)**. `Unknown`/`object`/`any` contracts, chained or",
    "   unjustified assertions, widen-then-assert, `vi.mock`/`jest.mock`, ad-hoc `typeof`, unsafe",
    "   dictionaries. **BLOCKING** on new/changed code. Spacing and `shape`-in-name nits are",
    "   **NON-BLOCKING** unless the repo's lint already errors on them.",
    "",
    "Style and polish otherwise stay secondary. If the task supplies a narrower rubric (e.g. " +
        "security-only,",
    "plan-only), follow that rubric but keep the output contract below.",
    "",
    "## Output contract (required)",
    "End every review with exactly this shape. No prose wrapper around the verdict block:",
    "",
    "```",
    "VERDICT: BLOCKING | CLEAR",
    "BLOCKING:",
    "- <file:line. Concrete correctness, acceptance-contract, regression, security, or scope " +
        "finding>",
    "NON-BLOCKING:",
    "- <optional observation>",
    "```",
    "",
    "Rules:",
    "- `VERDICT: CLEAR` only when there are zero BLOCKING items (omit the BLOCKING list, or " +
        "leave it empty).",
    "- **BLOCKING** = must fix before merge/continue. Concrete enough that a builder can act " +
        "without re-asking.",
    "- **NON-BLOCKING** = optional polish, nits, questions, taste. Never spends a repair round " +
        "on its own.",
    "- Do not restate the full diff. Do not propose drive-by refactors outside the change under " +
        "review.",
    "- If you run tests or commands, cite exit codes / relevant output briefly above the " +
        "verdict block.",
];

/** The skill's "What to judge", word for word. */
const WHAT_TO_JUDGE = [
    "## What to judge",
    "",
    "Correctness, races, regressions, and missing tests come first. Approach comes next. Prefer " +
        "the smallest change that solves the goal. Name cruft such as a duplicate copy, an " +
        "empty wrapper, a broken lock, or a cast at a trust boundary.",
    "",
    "Skip drive-by refactors. Skip a finding the author already answered on this PR unless the " +
        "current head still has the bug.",
];

/** The skill's "Comment format", word for word. */
const COMMENT_FORMAT = [
    "## Comment format",
    "",
    "Target about 80% of ASD-STE100 for GitHub line comments. Do not enforce the aerospace " +
        "dictionary. Do enforce the sentence rules:",
    "",
    "- One finding per line comment.",
    "- First sentence: imperative action in 20 words or fewer.",
    "- Second sentence: the impact in 20 words or fewer.",
    "- Active voice. Present tense for the code. No hedging words such as maybe, consider, " +
        "should, quite, or nit.",
    "- No contractions. No `e.g.`, `i.e.`, `via`, or phrasal verbs.",
    "- Keep identifiers exact. Do not restate the diff.",
    "- Start the action sentence with one severity label, followed by a colon:",
    "  - `BLOCKING:` for a verified issue that must be fixed before merge.",
    "  - `BUG:` for a verified bug that does not block merge.",
    "  - `NIT:` for a minor, worthwhile cleanup.",
    "  - `SUPER NIT:` for a very minor, optional cleanup.",
    "- Do not use `DOC` or the old `BLOCK` or `NOTE` labels.",
    "",
    "```text",
    "BLOCKING: Load this row with populate_existing before FOR UPDATE.",
    "",
    "The session already holds this row. get() then skips the lock.",
    "```",
];

/** The reviewer's brief: Spinner's facts, the rulebook by path, the role word for word. */
export function render_review_brief(input: ReviewBriefInput): string {
    const { owner, name, number } = input.pr;
    const rules = rulebook_of(input.skill);
    return [
        `# ${input.name}`,
        "",
        `Role: reviewer of ${owner}/${name}#${number} (${input.url}) with the model ` +
            `${input.model},`,
        "one of several reviewers of a Spinner review. The worktree you start in is a read-only",
        "checkout detached at the PR head. Read the diff with `gh pr diff` and `gh pr view`, and",
        "the code it hooks into with `git show` and the read tools. Do not edit files. Do not",
        "checkout, switch, commit or push. Do not comment, review or post on GitHub: a lead",
        "reconciles the verdicts into one review and the operator posts it. Nobody reads this",
        "terminal while you work: do not ask, do not wait; review, then end with the verdict",
        "block. The daemon saves your last message as your verdict file under",
        `\`${REVIEW_VERDICTS_DIR}/\`; a last message without the block counts as no verdict.`,
        "",
        "## Load the rulebook first",
        "",
        "Read these before you review. Apply them.",
        "",
        path_line("engineer-conventions", rules.engineer_conventions),
        path_line("anti-slop (for any TypeScript or JavaScript in the diff)", rules.anti_slop),
        path_line(
            "backend-conventions (when the diff touches queries, handlers, or services)",
            rules.backend_conventions,
        ),
        path_line("principles", rules.principles),
        "",
        ...WHAT_TO_JUDGE,
        "",
        "Write each finding as a line comment would read, so the lead can carry it over:",
        `\`path:line\` on the right side of the diff, then the comment in the format below.`,
        "",
        ...COMMENT_FORMAT,
        "",
        "## The role",
        "",
        ...REVIEWER_ROLE,
        "",
    ].join("\n");
}

/** The first message of a reviewer: the PR, the head, the contract again in one line. */
export function review_kickoff(input: Omit<ReviewBriefInput, "name">, head: string): string {
    const { owner, name, number } = input.pr;
    return [
        `Review ${owner}/${name}#${number}: ${input.url}. This checkout is detached at the PR ` +
            `head ${head}. The operator started this review from Spinner and reads only your ` +
            "verdict file: do not post on GitHub, do not edit files, do not ask in this " +
            "terminal. Read the rulebook named in your brief, read the diff and the code it " +
            "hooks into, then end your message with the VERDICT block, exactly in the shape " +
            "the brief gives, each finding as `path:line` and a comment in the comment format.",
    ].join("\n");
}

export interface LeadBriefInput {
    pr: PrRef;
    url: string;
    skill: string | null;
    /** The models the swarm runs, for the brief's count. */
    models: readonly string[];
}

/** The skill's briefing section, word for word, with the tool in place of the reply. */
const BRIEFING = [
    "## Deliver the reviewer briefing while the ensemble runs",
    "",
    "Do not wait for the reviewers before you write the briefing. Inspect the PR diff and " +
        "surrounding repository files yourself. Finish that turn by writing the reviewer " +
        "briefing with `review_briefing` right away so the user can read it while the reviewers " +
        "run in the background.",
    "",
    "Write the briefing in ELI5 and ASD-STE100 style:",
    "",
    "- Explain the change in plain, everyday words so a tired engineer gets the mental model on " +
        "the first read.",
    "- Use a concrete analogy when it clarifies a tricky mechanism.",
    "- Put one thought in each sentence. Keep instructions under 20 words and other sentences " +
        "under 25 words.",
    "- Use active voice and name the actor. Keep \"the\" and \"a\".",
    "- Give each word one meaning and keep that word.",
    "- Do not use em dashes. Use a colon only before a list.",
    "- Put the file citation such as `file:line` or the label `measured`, `inferred`, or " +
        "`guess` in the same sentence as the claim.",
    "",
    "Include these five sections in the briefing:",
    "",
    "1. **What this PR does.** Name who or what this PR changes behavior for, and state the " +
        "plain-language before and after.",
    "2. **How it does it.** Walk through the data flow and control flow step by step using the " +
        "real symbols and `file:line` citations.",
    "3. **Design pattern.** Name the category of design pattern the PR uses, such as strategy, " +
        "adapter, repository, state machine, middleware, or inline procedural change. Explain " +
        "how the diff maps to that pattern.",
    "4. **Codebase fit.** State whether the PR matches existing patterns in this repository. " +
        "Cite neighbor files with `file:line` that follow the same pattern or a competing one.",
    "5. **Approach and slop verdict.** State whether the approach is sound or flawed, and " +
        "whether the diff contains code slop or type-evidence slop. Call out trade-offs, hidden " +
        "coupling, blast radius, and missing tests that the reviewer needs to judge the PR.",
    "",
    "Do not post this briefing to GitHub. It belongs only in `review_briefing`.",
];

/** The skill's reconcile rules, word for word, with the daemon's notice in place of the wake. */
function reconcile_lines(rules: Rulebook): string[] {
    return [
        "## Reconcile on completion",
        "",
        "The daemon tells you in this terminal when the last verdict has landed, and names the " +
            `files under \`${REVIEW_VERDICTS_DIR}/\` (one per reviewer, its model in the name). ` +
            "Until then, wait: do not start the reconciliation on a partial set.",
        "",
        "Wait until all results have landed before you reconcile. Read " +
            `\`${rules.lead_judgment}\` and apply it as the lead reviewer.`,
        "",
        "Keep a finding only when the head code supports it. Treat agreement between two or " +
            "more models as a strong signal. Keep a lone-model finding only when you verify the " +
            "exact execution path in the code. Drop hypotheticals, style preferences, and " +
            "findings that fight the author's existing review comments or the repository's " +
            "patterns.",
        "",
        "Write the GitHub review in one voice. Never put model names in any GitHub text.",
    ];
}

/** The skill's post rules, word for word, with `review_draft` in place of the post. */
const DRAFT = [
    "## Draft; the operator posts",
    "",
    "Read the current review comments on the PR first. Do not repeat them.",
    "",
    "Comment only on lines that appear in the pull request diff. If the target line is outside " +
        "the diff, move the comment to the nearest changed line in that hunk, or drop it.",
    "",
    "The operator posts one pull request review from the draft, not issue comments:",
    "",
    "- `commit_id` is the head SHA.",
    "- `event` is `APPROVE` when there are no `BLOCKING:` findings, or `COMMENT` when any " +
        "`BLOCKING:` finding exists.",
    "- `body` is only the summary from the table below. Do not repeat the line comments in `body`.",
    "- `comments[]` holds the line comments with `path`, `line`, `side: RIGHT`, and `body`.",
    "",
    "Pick the event and summary body from the head state:",
    "",
    "| Head state | Event | Body |",
    "|---|---|---|",
    "| No findings | `APPROVE` | `LGTM` |",
    "| Non-blocking notes only | `APPROVE` | `A few nits, but LGTM` |",
    "| Any `BLOCKING:` finding | `COMMENT` | `A few blockers` |",
    "",
    "If the review has no line comments, still write the summary and the event.",
    "",
    "Do not post. You have no way to: `gh pr review` and `gh api` writes are refused in this " +
        "role, and the daemon posts only on the operator's click. When reconciliation finishes, " +
        "write the draft with `review_draft`: the event, the summary body, and each line " +
        "comment with its `path:line`. The daemon checks each label and each line against the " +
        "diff and returns the faults instead of writing; fix them and call it again. Then write " +
        "one Log line with `mission_log`: what the reviewers agreed on and what you dismissed, " +
        "with the reason. The operator reads the draft in the review pane, edits it, and posts " +
        "it or drops it. A later change to the draft is the operator's; do not rewrite a draft " +
        "the operator edited unless asked in this terminal.",
];

/** The lead's brief: the `pr-review` skill, word for word, with the daemon in the loop. */
export function render_review_lead_brief(input: LeadBriefInput): string {
    const { owner, name, number } = input.pr;
    const rules = rulebook_of(input.skill);
    const count = input.models.length;
    return [
        "# lead",
        "",
        `Role: lead reviewer of ${owner}/${name}#${number} (${input.url}), a Spinner review. You`,
        "run the operator's `pr-review` process: the operator pasted the PR into Spinner, which",
        "is the request for this review. The worktree you start in is a read-only checkout",
        "detached at the PR head. You read the PR and the repository, write the operator a",
        "briefing, wait for the reviewers' verdicts, reconcile them into one review in one voice,",
        "and write the draft. You never post, never edit files, never checkout, commit or push,",
        "and never name a model in any text that goes to GitHub.",
        "",
        "## Load the rulebook first",
        "",
        "Read these before you review. Apply them. Do not quote skill names in GitHub comments.",
        "",
        path_line("engineer-conventions", rules.engineer_conventions),
        path_line("anti-slop (for any TypeScript or JavaScript in the diff)", rules.anti_slop),
        path_line(
            "backend-conventions (when the diff touches queries, handlers, or services)",
            rules.backend_conventions,
        ),
        path_line("lead-judgment (for the reconciliation)", rules.lead_judgment),
        "",
        "Match the repository when it already chose a pattern. Do not force styled-components " +
            "onto a Tailwind or existing `components/ui` codebase. Do not tell the author to " +
            "inline a component they already asked to split.",
        "",
        ...WHAT_TO_JUDGE,
        "",
        "## The reviewers",
        "",
        `The daemon runs the ensemble: ${count} read-only reviewer${count === 1 ? "" : "s"} ` +
            `(${input.models.join(", ")}), each in its own pi with the \`reviewer\` role, the ` +
            "rulebook, the PR URL and the comment format; they do not edit files and do not " +
            "comment on GitHub. Do not launch reviewers yourself: no `subagent`, no `pi`. Each " +
            `verdict lands as \`${REVIEW_VERDICTS_DIR}/<model-slug>.md\` and the daemon tells ` +
            "you when the last one is in.",
        "",
        ...BRIEFING,
        "",
        ...reconcile_lines(rules),
        "",
        ...COMMENT_FORMAT,
        "",
        ...DRAFT,
        "",
        "## Every turn",
        "",
        "1. Keep your Roster row current with `mission_roster`: what you do, and what blocks you.",
        "2. Append one Log line with `mission_log` for each thing that happened: the briefing " +
            "written, the verdicts read, the draft written.",
        "3. A question only the operator can answer goes under Open questions with " +
            "`mission_question`; continue with what does not depend on it.",
        "",
    ].join("\n");
}

/** The lead's first message: the PR and the order of work. */
export function review_lead_kickoff(input: LeadBriefInput, head: string): string {
    const { owner, name, number } = input.pr;
    return (
        `Review ${owner}/${name}#${number}: ${input.url}, head ${head}. The reviewers start ` +
        "now in their own terminals. Read the rulebook named in your brief, read the PR diff " +
        "and the repository files around it, and write the briefing with `review_briefing` in " +
        "this turn. Then stop and wait: the daemon tells you here when the verdicts are in."
    );
}

export interface VerdictsNoticeInput {
    pr: PrRef;
    url: string;
    head: string;
    skill: string | null;
    /** The verdict files, relative to the session directory. */
    files: readonly string[];
    /** The reviewers that ended without a verdict. */
    failed: readonly string[];
}

/**
 * The notice the lead gets when the last reviewer lands: self-contained, because the lead of
 * an ordinary session has the lead brief, not the review lead's.
 */
export function verdicts_notice(input: VerdictsNoticeInput): string {
    const { owner, name, number } = input.pr;
    const rules = rulebook_of(input.skill);
    const labels = REVIEW_SEVERITY_LABELS.map((label) => `\`${label}\``).join(", ");
    const failed =
        input.failed.length === 0
            ? ""
            : ` ${input.failed.join(", ")} ended without a verdict; reconcile without ` +
              (input.failed.length === 1 ? "it." : "them.");
    return [
        `Spinner: every reviewer of ${owner}/${name}#${number} (${input.url}, head ` +
            `${input.head}) has landed. ${input.files.length} verdict file` +
            `${input.files.length === 1 ? "" : "s"}: ${input.files.join(", ")}.${failed}`,
        "",
        `Read the verdicts, then read \`${rules.lead_judgment}\` and apply it as the lead ` +
            "reviewer. Keep a finding only when the head code supports it. Treat agreement " +
            "between two or more models as a strong signal. Keep a lone-model finding only " +
            "when you verify the exact execution path in the code. Drop hypotheticals, style " +
            "preferences, and findings that fight the author's existing review comments or " +
            "the repository's patterns. Read the current review comments on the PR first; " +
            "do not repeat them.",
        "",
        "Then write one review in one voice with `review_draft`: `event` is `APPROVE` with no " +
            "`BLOCKING:` finding and `COMMENT` otherwise; `body` is only the summary (`LGTM`, " +
            "`A few nits, but LGTM`, or `A few blockers`); `comments` is a JSON array of " +
            "`{ path, line, body }`, one finding per comment, on a line of the PR diff, the " +
            `body starting with one of ${labels}` +
            ", first sentence an imperative action in 20 words or fewer, second sentence the " +
            "impact in 20 words or fewer, no hedging, no contractions. Never name a model in " +
            "the draft. Do not post: the operator posts from the review pane. Then one " +
            "`mission_log` line: what the reviewers agreed on and what you dismissed, and why.",
    ].join("\n");
}
