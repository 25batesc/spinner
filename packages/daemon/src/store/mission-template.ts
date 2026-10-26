// The MISSION.md a new session starts with. It follows the template in
// docs/SESSION_PROTOCOL.md, section "MISSION.md", with the operator-owned sections empty.

export interface MissionTemplateInput {
    id: string;
    title: string;
    /** Local time `HH:MM` for the first Log line. */
    time: string;
}

export function render_mission(input: MissionTemplateInput): string {
    return [
        `# ${input.id} · ${input.title}`,
        "",
        "## Goal",
        "(One paragraph. Operator-owned.)",
        "",
        "## Done when",
        "- [ ] ",
        "",
        "## Plan",
        "- [ ] 1. ",
        "",
        "## Roster",
        "| Agent | Owns | Doing | Blocked? | Updated |",
        "|-------|------|-------|----------|---------|",
        "",
        "## Contracts & decisions",
        "",
        "## Open questions",
        "",
        "## Log",
        `- ${input.time} operator: session created`,
        "",
    ].join("\n");
}

export interface AgentsFileInput {
    id: string;
    dir: string;
}

/**
 * The session-level AGENTS.md. Harnesses that read context files from parent directories
 * pick it up from any worktree under the session, which is how the mission reaches an agent
 * without a plugin.
 */
export function render_agents_file(input: AgentsFileInput): string {
    return [
        `# Spinner session ${input.id}`,
        "",
        `This directory is a Spinner session (\`${input.dir}\`).`,
        "",
        "1. Read `MISSION.md` in this directory in full at the start of every turn.",
        "2. Read your brief at `agents/<your-name>/BRIEF.md` once.",
        "3. Follow the editing rules in the brief for `MISSION.md`.",
        "",
    ].join("\n");
}
