// The BRIEF.md the daemon writes for an agent added without one (docs/SESSION_PROTOCOL.md,
// "agents/<name>/BRIEF.md"). It follows the protocol's template: role, Owns, Do not edit,
// Stack, Every turn, Finish. The operator edits it in the session directory afterwards; the
// daemon never rewrites an existing brief. The `lead` variant (MISSION.md s014) is the brief
// of the agent that owns the mission: it writes Goal, Done when and Plan from the
// conversation, sets the title, ticks, logs, asks, and adds agents when the work splits.
import type { Session } from "@spinner/protocol";

export interface BriefTemplateInput {
    name: string;
    session: Session;
    /** Repo key of `session.repos` the agent works in, when it runs in a worktree. */
    repo?: string;
    /** `lead` for the agent that owns the mission; a worker otherwise. */
    kind?: "worker" | "lead";
}

export function render_brief(input: BriefTemplateInput): string {
    if (input.kind === "lead") {
        return render_lead_brief(input);
    }
    const { name, session } = input;
    const others = Object.keys(session.agents ?? {}).filter((other) => other !== name);
    return [
        `# ${name}`,
        "",
        `Role: engineer for session ${session.id} (${session.title}).`,
        "",
        "## Owns",
        ...owns_lines(session, input.repo),
        "",
        "## Do not edit",
        ...do_not_edit_lines(session, input.repo, others),
        "",
        ...stack_lines(session),
        "## Every turn",
        "1. Read `.spinner/MISSION.md` in full.",
        "2. Update your Roster row when your task or your blocked state changes. Name the",
        "   Plan item you are on as `#<id>` in the Doing cell, so the board shows it as doing.",
        `3. Append one Log line when something happens: \`HH:MM ${name}: <what>\`.`,
        "4. Put an API change under Contracts before you implement it.",
        "5. A Plan item that cannot be built as its design entry says goes under Open",
        "   questions with the entry id (the `[n.n]` token on the item) and what you built.",
        "6. Stage by path. Never `git add -A`. Never push.",
        "",
        "## Finish",
        "1. Make the tests green.",
        "2. Tick each of your Plan items with `mission_plan` `tick` the moment it is done.",
        "3. Set your Roster row: Doing = `done`, Blocked? = `no`.",
        "",
    ].join("\n");
}

/**
 * The lead's brief: it owns the mission and the session's agents, works in the worktrees,
 * and leaves pushing, posting, approving, landing, resetting and closing to the operator.
 */
function render_lead_brief(input: BriefTemplateInput): string {
    const { name, session } = input;
    return [
        `# ${name}`,
        "",
        `Role: lead of session ${session.id} (${session.title}). You own the mission and you`,
        "run the session. The operator talks to you in your terminal and reads `MISSION.md`.",
        "",
        "## Owns",
        "- `MISSION.md`: Goal, Done when, Plan, the title, and your Roster row.",
        ...owns_lines(session, input.repo),
        "- The session's agents: you add them, brief them, and steer them.",
        "",
        "## Do not edit",
        "- Do not edit `MISSION.md` with `edit` or `write`; use the tools, so the daemon stamps",
        "  the time and the workspace updates.",
        "- Do not push, post, approve, land, reset or close. The operator does those, in the UI",
        "  or with `spinner`. Say what is ready and why, in the Log and in your terminal.",
        "",
        ...stack_lines(session),
        "## First message",
        "1. Your first message is what the session is about: a paste, with the pull requests",
        "   adopted into worktrees and the ones only mentioned. If it does not say what the",
        "   work is, ask the operator in your terminal before you write anything.",
        "2. Set the title with `session_title`, a few words. Retitle it at a round boundary,",
        "   after an approval, and when the work's focus moves, so it names what is worked on",
        "   now. A title the operator renamed is pinned: `session_title` is refused; keep it.",
        "3. On the `direct` track, write the Goal with `mission_goal` (one paragraph), the Done",
        "   when list with `mission_done_when` (what must be true at the end), and the Plan with",
        "   `mission_plan` (one owner per item; yourself until the work splits). On the `design`",
        "   track, skip this step: Spinner writes the Goal and Done when, and seeds the Plan",
        "   from the design doc at approval.",
        "",
        "## Design (EGM)",
        "1. In your first answer, propose a track: `design` (EGM: brainstorm, draft, review,",
        "   approve, then build) or `direct` (a small fix). Say why in one sentence. The",
        "   operator switches it on the track chip.",
        "2. On the design track, the operator starts each EGM skill. You never start one on",
        "   your own. The skills write to the EGM artifact directory; the design doc goes to",
        "   the designs directory of the repo. Name it with design_doc.",
        "3. Ask each EGM gate that has options with `ask_question`, then end your turn.",
        "4. Inside `egm-draft` gates, follow EGM: options without a ranking. Everywhere else,",
        "   give the options and your recommendation.",
        "5. On the design track, Spinner refuses Goal and Done when in MISSION.md. The design",
        "   doc holds them. Keep your Roster row, the Plan and the Log as before.",
        "6. Before the operator approves the design, and while a changed design waits for",
        "   re-approval, write only the design doc and the session's files.",
        "7. At approval, Spinner seeds the Plan: one item per entry of the doc's Detailed",
        "   Implementation Plan, owner none, linked by the `[n.n]` token at the start of its",
        "   line. Assign owners with `mission_plan assign`. Split an entry with `mission_plan`",
        "   `add` and `entry: \"n.n\"`; the token survives `edit`. An item marked stale or",
        "   orphaned after a re-approval no longer matches the doc: re-point it with `edit`",
        "   and a new token.",
        "",
        "## Every turn",
        "1. Read `MISSION.md` in full; the operator and the workspace write to it too.",
        "2. Keep your Roster row current with `mission_roster`: what you do, and what blocks you.",
        "3. Append one Log line with `mission_log` for each thing that happened.",
        "4. Tick a Plan item with `mission_plan` the moment it is done, and a Done when item",
        "   with `mission_done_when` the moment it holds. Never renumber.",
        "5. When the work is parallel, add an agent with `agent_add` and brief it: what it owns,",
        "   what it must not edit, what done means. Steer it with `agent_steer`.",
        "6. A product, UX or preference call is the operator's: put it under Open questions with",
        "   `mission_question`, with the options and your recommendation, and continue elsewhere.",
        "   Do not start the text with your name; the daemon stamps the time and the author. When",
        "   a question is settled, close it with `mission_question` `resolve`, its id and why.",
        "7. A pull request the operator mentions later: `adopt` it. A PR of a repo the project",
        "   does not list is refused with the reason; say so.",
        "8. Stage by path. Never `git add -A`. Never push.",
        "",
        "## Finish",
        "1. Every Done when item ticked, or an Open question that says why not.",
        "2. Your Roster row: Doing = `done`, Blocked? = `no`.",
        "3. A last Log line: what exists and what the operator must do next.",
        "",
    ].join("\n");
}

/** One line per repo of the session; the agent's own repo first when it has one. */
function owns_lines(session: Session, own: string | undefined): string[] {
    const repos = Object.entries(session.repos);
    if (repos.length === 0) {
        return ["- The session directory. The session has no repo worktree yet."];
    }
    const mine = own === undefined ? repos : repos.filter(([key]) => key === own);
    const lines = mine.map(([key, repo]) => {
        const where =
            repo.worktree === undefined ? "no worktree yet" : `worktree \`${repo.worktree}\``;
        return `- \`${key}\` (${where}, branch \`${session.branch}\`).`;
    });
    return lines.length === 0 ? ["- Nothing yet. The operator fills this in."] : lines;
}

function do_not_edit_lines(session: Session, own: string | undefined, others: string[]): string[] {
    const lines: string[] = [];
    if (own !== undefined) {
        const rest = Object.keys(session.repos).filter((key) => key !== own);
        if (rest.length > 0) {
            lines.push(`- The other repos: ${rest.map((key) => `\`${key}\``).join(", ")}.`);
        }
    }
    for (const other of others) {
        lines.push(`- What \`${other}\` owns (its Roster row). Send it an inbox message instead.`);
    }
    if (lines.length === 0) {
        lines.push("- Files outside your Roster row. Log it first when you must.");
    }
    return lines;
}

function stack_lines(session: Session): string[] {
    const hosts = Object.entries(session.stack.hosts ?? {});
    if (hosts.length === 0) {
        return [];
    }
    return [
        "## Stack",
        ...hosts.map(([service, host]) => `- ${service}: http://${host}`),
        `- Logs: \`spinner logs ${session.id} <service>\`.`,
        "",
    ];
}
