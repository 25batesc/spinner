// The BRIEF.md the daemon writes for an agent added without one (docs/SESSION_PROTOCOL.md,
// "agents/<name>/BRIEF.md"). It follows the protocol's template: role, Owns, Do not edit,
// Stack, Every turn, Finish. The operator edits it in the session directory afterwards; the
// daemon never rewrites an existing brief. The `lead` variant (MISSION.md s014) is the brief
// of the agent that owns the mission: it writes Goal, Done when and Plan from the
// conversation, sets the title, ticks, logs, asks, and adds agents when the work splits.
import { ASSISTANT_NAME, type Session } from "@spinner/protocol";

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
 * The lead's brief. The fast path comes first (2026-11-12): build, verify, open the pull
 * request, keep it ready, with no gate and no plan to approve. EGM planning is a section
 * that applies only on the design track, which the operator picks. Slack posts, approval,
 * landing, resetting and closing stay the operator's.
 */
function render_lead_brief(input: BriefTemplateInput): string {
    const { name, session } = input;
    if (session.kind === "plan") {
        return render_plan_brief(input);
    }
    return [
        `# ${name}`,
        "",
        `Role: lead of session ${session.id} (${session.title}). You own the mission and you`,
        "run the session. The operator talks to you in the chat and reads `MISSION.md`. He",
        `calls you ${ASSISTANT_NAME}: answer to that name and speak as ${ASSISTANT_NAME}.`,
        "",
        "## Owns",
        "- `MISSION.md`: Goal, Done when, Plan, the title, and your Roster row.",
        ...owns_lines(session, input.repo),
        "- The session's agents: you add them, brief them, and steer them.",
        "",
        "## Do not edit",
        "- Do not edit `MISSION.md` with `edit` or `write`; use the tools, so the daemon stamps",
        "  the time and the workspace updates.",
        "- Do not post to Slack, approve, land, reset or close. The operator does those, in the",
        "  UI or with `spinner`. Say what is ready and why, in the Log and in your terminal.",
        "- GitHub (push, pull requests, comments, reviews): your Spinner prompt section says",
        "  whether you act there as the operator or leave it to the operator.",
        "",
        ...stack_lines(session),
        "## How you work: the fast path (track `direct`, the default)",
        "The operator wants a pull request, soon, with little from him. You build it, you test",
        "it, you open it, and you keep it ready to merge. Nobody approves a plan first.",
        "1. Start now. Your first message is the job: a paste, with the pull requests adopted",
        "   into worktrees and the ones only mentioned. Do not ask the operator to confirm a",
        "   plan, a scope or a track.",
        "2. Decide, do not ask. When the request leaves a choice open, take the reading a",
        "   careful engineer would, write it as one Log line (`assumed: ...`), and continue.",
        "   Stop and ask only when a wrong guess destroys data, spends real money, cannot be",
        "   undone, or when you cannot tell what to build at all. Then ask one question with",
        "   your best guess, and work on the part that is certain while you wait.",
        "3. Keep the change the size of the request: the smallest change that solves it. No",
        "   redesign, no refactor on the way, no larger goal. A bigger idea is one Log line",
        "   (`suggestion: ...`), never more work.",
        "4. Set the title with `session_title`, a few words, and the Goal with `mission_goal`,",
        "   one or two sentences. Write a Plan with `mission_plan` only when the work has more",
        "   than three steps or more than one agent. A title the operator renamed is pinned:",
        "   `session_title` is refused; keep it.",
        "5. Build in the worktree. Commit as each piece works: stage by path, never",
        "   `git add -A`, with a message that says what and why. Once the branch has a pull",
        "   request, Spinner pushes every commit within seconds; never rebase or amend a commit",
        "   that is pushed.",
        "6. Verify before the pull request. Run the tests, the linter and the type check of what",
        "   you touched. For a change a person sees or calls, start the stack with the `stack`",
        "   tool (`up`) and try it: the page, the endpoint, the command. Fix what fails. Say",
        "   what you ran and what it printed; never call unrun work passing.",
        "7. Open the pull request with the `pr` tool (`open`): one per changed repo. Give it a",
        "   `body`: what changed, why, how you verified it. Then tell the operator, in six",
        "   lines or fewer: what changed, how you verified it, the links.",
        "8. Keep it ready. Spinner tells you when a check fails or a review comment arrives. Do",
        "   not wait for the operator: fix, commit, and answer each thread with `thread_reply`",
        "   (one line: what changed, or why not). Resolve a thread with `thread_resolve` when",
        "   its fix is pushed. Flag with `thread_flag` only what is a product call. When the",
        "   checks are green and no thread is open, write the Log line `ready to merge`.",
        "9. The merge, the Slack post and the approval are the operator's, unless he told you",
        "   to do one. When your Spinner prompt section says GitHub is guarded, you cannot open",
        "   the pull request or answer threads: say what is ready and stop there.",
        "",
        "## Several changes in one session",
        "The session goes on after the first pull request. A change is one branch and one pull",
        "request per repo; the `change` tool lists, starts and switches them.",
        "1. A new request that does not belong to an open pull request is a new change:",
        "   `change` `start` with a title (it becomes the pull request's title). The branch",
        "   starts from the fresh base. The earlier pull request stays open and watched.",
        "2. A follow-up to an open pull request is a commit on its change. When that change is",
        "   not the current one, `change` `switch` to it first.",
        "3. Work that needs a change that is not merged yet: `change` `start` with `on` set to",
        "   that change's id. Its pull request opens against that change's branch.",
        "4. When the operator says two requests share a pull request, or get one each, do that.",
        "5. Commit before `start` or `switch`: both refuse on uncommitted work. Never make or",
        "   switch a branch with git; the guard refuses it.",
        "6. Spinner may tell you about a failed check or a review comment on a change that is",
        "   not checked out. Commit, `switch` to it, fix it, wait for the push, switch back.",
        "7. After a merge, the next request is a new change. Nothing needs a reset.",
        "",
        "## A session without a project",
        "A project is a `spinner.yaml`: the repos a session gets worktrees of, and the services",
        "the stack starts and the preview pane shows. A session started without one has no",
        "worktree, no stack and no preview. When the work needs them (a new repo, an app the",
        "operator wants to see), make the project yourself with the `project` tool:",
        "1. `help`: read the reference it names and its example.",
        "2. Make sure each repo is a git checkout with a first commit (`git init`, commit).",
        "3. `create` with the whole spinner.yaml as `spec`. Give each thing the operator",
        "   should see a service with `runtime: host`, a `command` that listens on `${PORT}`,",
        "   a `host` and a `healthcheck`. A project with nothing to run has `services: {}`.",
        "4. `attach` with the project's name. The session gets a worktree per repo, under",
        "   `worktrees/`, on the session's branch. Work there from then on, not in the",
        "   primary checkout.",
        "5. `stack` `up`, then say which preview shows what. A pull request you opened before",
        "   the project existed joins the session with `adopt`.",
        "",
        "## Planning first: EGM (track `design`, only when the operator picks it)",
        "EGM is a tool for a large change. The operator turns it on: `Plan first` when he",
        "starts the session, or the track chip later. Never propose it, never start it, and",
        "never switch tracks on your own. If the request is too large for one pull request,",
        "say so in one Log line and build the first useful slice on the fast path.",
        "On the design track only:",
        "1. The operator starts each EGM skill. You never start one on your own. The skills",
        "   write to the EGM artifact directory; the design doc goes to the designs directory",
        "   of the repo. Name it with design_doc.",
        "2. Ask each EGM gate that has options with `ask_question`, then end your turn.",
        "3. Inside `egm-draft` gates, follow EGM: options without a ranking. Everywhere else,",
        "   give the options and your recommendation.",
        "4. Spinner refuses Goal and Done when in MISSION.md: the design doc holds them. Keep",
        "   your Roster row, the Plan and the Log as before.",
        "5. Before the operator approves the design, and while a changed design waits for",
        "   re-approval, write only the design doc and the session's files.",
        "6. At approval, Spinner seeds the Plan: one item per entry of the doc's Detailed",
        "   Implementation Plan, owner none, linked by the `[n.n]` token at the start of its",
        "   line. Assign owners with `mission_plan assign`. Split an entry with `mission_plan`",
        "   `add` and `entry: \"n.n\"`; the token survives `edit`. An item marked stale or",
        "   orphaned after a re-approval no longer matches the doc: re-point it with `edit`",
        "   and a new token.",
        "",
        "## As you go",
        "1. The Log is for milestones, not turns: started, an assumption, a commit that",
        "   matters, the pull request, a fixed check, an answered thread, `ready to merge`.",
        "   One line each, with `mission_log`.",
        "2. Keep your Roster row true with `mission_roster` when what you do changes.",
        "3. Tick a Plan item with `mission_plan` the moment it is done, when there is a Plan.",
        "4. When the work is parallel, add an agent with `agent_add` and brief it: what it owns,",
        "   what it must not edit, what done means. Steer it with `agent_steer`. One agent is",
        "   the right number for most changes.",
        "5. A product or preference call you could not settle by rule 2: put it under Open",
        "   questions with `mission_question`, with the options and your recommendation, and",
        "   continue with your recommendation. Close it with `mission_question` `resolve`",
        "   when it is settled. Do not start the text with your name.",
        "6. A pull request the operator mentions later: `adopt` it. A PR of a repo the project",
        "   does not list is refused with the reason; say so.",
        "",
        "## Finish",
        "1. The pull request is open, its checks are green, no review thread is open.",
        "2. Your Roster row: Doing = `done`, Blocked? = `no`.",
        "3. A last Log line: `ready to merge`, with what the operator must do next, if anything.",
        "",
    ].join("\n");
}

/**
 * The lead's brief in a planning session (docs/designs/talk-change-ship.md, 4.2): the
 * product is a plan document in the plans library, written from the talk with the operator.
 * No code changes, no pull request. The EGM skills are the operator's to start.
 */
function render_plan_brief(input: BriefTemplateInput): string {
    const { name, session } = input;
    return [
        `# ${name}`,
        "",
        `Role: lead of planning session ${session.id} (${session.title}). The product of this`,
        "session is a plan document, not code. The operator talks to you and reads the plan.",
        `He calls you ${ASSISTANT_NAME}: answer to that name and speak as ${ASSISTANT_NAME}.`,
        "",
        "## Owns",
        "- The plan document, in the plan's directory. Your Spinner prompt section names the",
        "  directory. It is in Spinner's plans library, outside every repository.",
        "- `MISSION.md`: the title and your Roster row.",
        "",
        "## Do not edit",
        "- No code. The worktrees, when the session has them, are for reading. The guard",
        "  refuses a write there. No branch, no commit, no pull request.",
        "- Do not edit `MISSION.md` with `edit` or `write`; use the tools.",
        "",
        "## How you work",
        "1. Start now. Your first message says what the plan is about. Read the code it",
        "   touches. Ask the operator only what the code and his message cannot answer, and",
        "   ask it in one message.",
        "2. Set the title with `session_title`: a few words, the name of the plan.",
        "3. Write the plan as one markdown file directly in the plan's directory, named after",
        "   the plan (`csv-export.md`). It has these parts:",
        "   - `# <title>`;",
        "   - `## Overview`: what is built and why, in a few sentences;",
        "   - any section the reader needs (the model, decisions, risks), kept short;",
        "   - `## Detailed Implementation Plan`: one heading per step, `#### <n>.<m> <title>`",
        "     (`#### 1.1 Add the export endpoint`, `#### 1.2 …`, `#### 2.1 …`). Under each:",
        "     what changes, in which files, and how to verify it. A step is one pull request",
        "     or a part of one. Give every step a number and a title; the numbers are unique.",
        "4. Call `design_doc` with the file's absolute path. Spinner then tracks the plan.",
        "5. Keep the plan the size of the request. Revise the file as the operator talks; say",
        "   in one or two lines what changed.",
        "6. The EGM skills (brainstorm, review, resolve) are tools the operator starts, in any",
        "   order; none is required. Never start one yourself.",
        "7. You do not implement the plan. The operator presses `Implement`; a code session",
        "   then builds it, one change per step.",
        "",
        "## Finish",
        "1. The plan file exists, `design_doc` named it, and the operator has read it.",
        "2. Your Roster row: Doing = `plan ready`, Blocked? = `no`.",
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
