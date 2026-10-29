// The BRIEF.md the daemon writes for an agent added without one (docs/SESSION_PROTOCOL.md,
// "agents/<name>/BRIEF.md"). It follows the protocol's template: role, Owns, Do not edit,
// Stack, Every turn, Finish. The operator edits it in the session directory afterwards; the
// daemon never rewrites an existing brief.
import type { Session } from "@spinner/protocol";

export interface BriefTemplateInput {
    name: string;
    session: Session;
    /** Repo key of `session.repos` the agent works in, when it runs in a worktree. */
    repo?: string;
}

export function render_brief(input: BriefTemplateInput): string {
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
        "2. Update your Roster row when your task or your blocked state changes.",
        `3. Append one Log line when something happens: \`HH:MM ${name}: <what>\`.`,
        "4. Put an API change under Contracts before you implement it.",
        "5. Stage by path. Never `git add -A`. Never push.",
        "",
        "## Finish",
        "1. Make the tests green.",
        "2. Tick your Plan items.",
        "3. Set your Roster row: Doing = `done`, Blocked? = `no`.",
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
