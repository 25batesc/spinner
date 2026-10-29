// The MISSION.md a new session starts with. It follows the template in
// docs/SESSION_PROTOCOL.md, section "MISSION.md", with the operator-owned sections empty.

export interface MissionTemplateInput {
    id: string;
    title: string;
    /** Local time `HH:MM` for the first Log line. */
    time: string;
    /** PR URLs the session was adopted from, when `spinner adopt` created it. */
    adopted?: string[];
}

export function render_mission(input: MissionTemplateInput): string {
    const adopted = input.adopted ?? [];
    const goal =
        adopted.length === 0
            ? ["(One paragraph. Operator-owned.)"]
            : [
                  "Adopted by `spinner adopt`: drive these PRs home.",
                  ...adopted.map((url) => `- ${url}`),
              ];
    const first_log =
        adopted.length === 0
            ? "session created"
            : `session adopted from ${adopted.length} PR${adopted.length === 1 ? "" : "s"}`;
    return [
        `# ${input.id} · ${input.title}`,
        "",
        "## Goal",
        ...goal,
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
        `- ${input.time} operator: ${first_log}`,
        "",
    ].join("\n");
}

export interface AgentsFileInput {
    id: string;
    dir: string;
    /** Service name to hostname, once the session has a stack. */
    hosts?: Record<string, string>;
    /** Absolute path of the session directory, so an agent in a worktree can find the mission. */
    path?: string;
}

/**
 * The session-level AGENTS.md (docs/SESSION_PROTOCOL.md, "Context chain"): the session id,
 * the hostnames, and where the mission and the brief are. Harnesses that read context files
 * from parent directories pick it up from any worktree under the session, which is how the
 * mission reaches an agent without a plugin. The daemon rewrites it when an agent starts, so
 * the hostnames are current.
 */
export function render_agents_file(input: AgentsFileInput): string {
    const mission = input.path === undefined ? "MISSION.md" : `${input.path}/MISSION.md`;
    const briefs = input.path === undefined ? "agents" : `${input.path}/agents`;
    const hosts = Object.entries(input.hosts ?? {});
    const stack =
        hosts.length === 0
            ? ["This session has no stack yet."]
            : ["## Stack", "", ...hosts.map(([name, host]) => `- ${name}: http://${host}`)];
    return [
        `# Spinner session ${input.id}`,
        "",
        `This directory is a Spinner session (\`${input.dir}\`). The mission is \`${mission}\`.`,
        "",
        `1. Read \`${mission}\` in full at the start of every turn.`,
        `2. Read your brief at \`${briefs}/<your-name>/BRIEF.md\` once.`,
        "3. Follow the editing rules in the brief for `MISSION.md`.",
        "",
        ...stack,
        "",
    ].join("\n");
}
