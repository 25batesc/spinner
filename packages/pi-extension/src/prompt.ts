// The `spinner_session` system-prompt section (docs/SESSION_PROTOCOL.md, "What the pi
// extension provides"): session id, hostnames, the agent's brief, and how to read
// `MISSION.md`. The mission itself stays out: pi appends the whole section to the context
// each time it changes, and a mission that every agent appends to changed on nearly every
// turn (s039: 160 copies, 12 MB, for one agent). The agent reads it with `mission_read`, and
// the daemon's change notices carry the new lines. The hosts come from the daemon's view when
// it answers, because `session.yaml` is YAML and the extension has no YAML parser; the rest
// is read from disk.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    ASSISTANT_NAME,
    SESSION_VERSION,
    type SessionView,
} from "@spinner/protocol";
import type { SpinnerEnv } from "./env.js";

/** Upper bound on the text `mission_read` returns; past it the agent asks for a section. */
export const MISSION_READ_CHARS_MAX = 60_000;

/** Upper bound on the Log lines `mission_read` returns without `lines`. */
export const MISSION_READ_LOG_LINES = 30;

export interface SessionFiles {
    /** `version:` of `session.yaml`, or null when unreadable. */
    version: number | null;
    id: string;
    title: string;
    brief: string;
    /** `name → URL` from the daemon's stack view; empty when the daemon did not answer. */
    hosts: Record<string, string>;
    /**
     * The session's open changes and its current one, from the daemon's view; empty when
     * the daemon did not answer. The operator's `test locally` can switch the worktrees
     * between two turns, so the lead reads which change is checked out at each one.
     */
    changes: {
        id: string;
        title: string;
        branch: string;
        current: boolean;
        state: string;
        /** The name of the change's group, or null: the lead groups what goes together. */
        group: string | null;
        /** The reason the change's group is on hold, or null. */
        hold: string | null;
    }[];
}

/** The states of a change the prompt leaves out, unless the change is the current one. */
const CHANGE_STATES_HIDDEN: readonly string[] = ["merged", "closed", "empty"];

/** One line per change, the checked-out one marked. Empty with one change or none. */
function change_lines(changes: SessionFiles["changes"]): string[] {
    if (changes.length < 2) {
        return [];
    }
    const lines = changes.map((change) => {
        const mark = change.current ? " (checked out now)" : "";
        const group = change.group === null ? "no group" : `group "${change.group}"`;
        const hold = change.hold === null ? "" : ` · ON HOLD: ${change.hold}`;
        const head = `- ${change.id} "${change.title}" · ${change.state} · ${change.branch}`;
        return `${head} · ${group}${hold}${mark}`;
    });
    return ["", "Changes of this session:", ...lines];
}

/** Reads the session files. `view` is the daemon's answer to `GET /sessions/:dir`, if any. */
export function load_session_files(env: SpinnerEnv, view: SessionView | null): SessionFiles {
    const yaml = read_or_empty(join(env.session_dir, "session.yaml"));
    const version_match = /^version:\s*(\d+)\s*$/m.exec(yaml);
    const id_match = /^id:\s*"?([^"\n]+?)"?\s*$/m.exec(yaml);
    const title_match = /^title:\s*"?([^"\n]*?)"?\s*$/m.exec(yaml);
    const hosts: Record<string, string> = {};
    for (const service of view?.stack.services ?? []) {
        if (service.url !== null) {
            hosts[service.name] = service.url;
        }
    }
    return {
        version: version_match?.[1] === undefined ? null : Number(version_match[1]),
        id: id_match?.[1] ?? env.dir,
        title: title_match?.[1] ?? "",
        brief: read_or_empty(join(env.session_dir, "agents", env.agent, "BRIEF.md")),
        hosts,
        changes: (view?.changes ?? [])
            .filter((change) => change.current || !CHANGE_STATES_HIDDEN.includes(change.state))
            .map((change) => {
                const group = (view?.groups ?? []).find((entry) => entry.id === change.group);
                return {
                    id: change.id,
                    title: change.title,
                    branch: change.branch,
                    current: change.current,
                    state: change.state,
                    group: group?.name ?? null,
                    hold: group?.hold?.reason ?? null,
                };
            }),
    };
}

/** Pure: the section text. A newer `session.yaml` than this extension knows is refused. */
/**
 * What the lead may do on GitHub, by the operator's `agents.github` setting. `full` overrides
 * an older brief's "do not push" line, which sessions made before the setting still carry.
 */
function github_lines(github: SpinnerEnv["github"]): string[] {
    if (github === "full") {
        return [
            "GitHub access: full. The operator's settings let you act on GitHub as the operator:",
            "`git push` (never a force), `gh pr create`, `gh pr comment`, `gh pr review`,",
            "review-thread replies and resolves, `gh pr merge` when the operator asked for the",
            "merge. This overrides a brief line that says you do not push. Say in the Log what",
            "you posted and where. Slack posts, `spinner approve`, `land`, `reset` and `close`",
            "stay the operator's.",
            "Open a pull request with `pr open` when you can: Spinner tracks it at once. One",
            "you open with `gh pr create` from a worktree under the session directory is found",
            "within a few minutes and tracked as a change of its own.",
        ];
    }
    return ["The operator pushes, posts, approves, lands, resets and closes; you do not."];
}

export function render_prompt_section(env: SpinnerEnv, files: SessionFiles): string {
    if (files.version !== null && files.version > SESSION_VERSION) {
        return [
            `Spinner session ${files.id}: session.yaml is version ${files.version}, this`,
            `extension knows version ${SESSION_VERSION}. Update Spinner before you continue.`,
        ].join(" ");
    }
    const lines = [
        `You are agent \`${env.agent}\` (role ${env.role}) in Spinner session ${files.id}` +
            (files.title.length > 0 ? ` · ${files.title}.` : "."),
        `Session directory: ${env.session_dir} (also \`.spinner/\` from a worktree).`,
        "Write to MISSION.md through the tools `mission_roster`, `mission_log`,",
        "`mission_contract` and `mission_question`; send a message with `message`.",
        "The daemon stamps the time and your name. Do not edit MISSION.md with `edit`.",
    ];
    if (env.role === "lead") {
        lines.push(
            `The operator calls you ${ASSISTANT_NAME}. Answer to that name and speak as`,
            `${ASSISTANT_NAME}, in the first person. In MISSION.md and in the tools your name`,
            "stays `lead`.",
        );
        lines.push(
            "You are the lead (MISSION.md s014): you own the mission. `session_title` sets the",
            "title; `mission_goal`, `mission_done_when` and `mission_plan` write Goal, Done when",
            "and the Plan (ids never change; tick an item the moment it is done); `agent_add`",
            "and `agent_steer` run the other agents; `adopt` brings a pull request in.",
        );
        lines.push(...github_lines(env.github));
        lines.push(...work_lines());
        if (env.egm_root !== null) {
            lines.push(...egm_lines(env.egm_root, env.egm_artifacts ?? ""));
        }
    }
    if (env.role === "lead") {
        lines.push(...change_lines(files.changes));
    }
    const hosts = Object.entries(files.hosts);
    if (hosts.length > 0) {
        lines.push("", "Hosts:", ...hosts.map(([name, url]) => `- ${name}: ${url}`));
    }
    if (files.brief.length > 0) {
        lines.push("", `## Your brief (agents/${env.agent}/BRIEF.md)`, "", files.brief.trim());
    }
    lines.push("", ...MISSION_LINES);
    return lines.join("\n");
}

/** How the agent keeps up with MISSION.md without re-reading it every turn. */
const MISSION_LINES = [
    "## MISSION.md",
    "Read it with `mission_read` once, at your first turn and after a compaction or a",
    "restart. After that, do not re-read it on your own: when it changes, Spinner sends you",
    "the new lines, or names the section to read. Read one section with `mission_read`",
    `(\`section\`), and the latest Log lines with \`lines\`. Other agents' rows are in the Roster.`,
];

/**
 * `mission_read`: the mission from disk, whole or one section, bounded. The Log comes as its
 * last `lines` lines (${MISSION_READ_LOG_LINES} without the parameter): it is the part that
 * grows, and the newest lines are the ones a turn needs.
 */
export function read_mission(
    session_dir: string,
    section: string | undefined,
    lines: number | undefined,
): string {
    if (lines !== undefined && !(Number.isInteger(lines) && lines > 0)) {
        return "`lines` must be a positive whole number";
    }
    const mission = read_or_empty(join(session_dir, "MISSION.md"));
    if (mission.length === 0) {
        return "MISSION.md is empty or absent.";
    }
    if (section !== undefined && section !== "") {
        const heading = SECTION_HEADINGS[section];
        if (heading === undefined) {
            const known = Object.keys(SECTION_HEADINGS).join(", ");
            return `unknown section "${section}"; one of ${known}`;
        }
        const body = section === "log" ? log_tail(mission, lines) : section_body(mission, heading);
        return bounded(`## ${heading}\n${body.trim()}`);
    }
    const without_log = mission.split("\n## Log")[0] ?? mission;
    const tail = log_tail(mission, lines).trim();
    assert.ok(without_log.length <= mission.length);
    return bounded(`${without_log.trim()}\n\n## Log (last lines)\n${tail}`);
}

/** The section keys `mission_read` accepts, with the heading each one has in the file. */
const SECTION_HEADINGS: Record<string, string> = {
    goal: "Goal",
    done_when: "Done when",
    plan: "Plan",
    roster: "Roster",
    contracts: "Contracts & decisions",
    open_questions: "Open questions",
    log: "Log",
};

function log_tail(mission: string, lines: number | undefined): string {
    const count = lines ?? MISSION_READ_LOG_LINES;
    const all = section_body(mission, "Log")
        .split("\n")
        .filter((line) => line.trim().length > 0);
    const kept = all.slice(-count);
    const skipped = all.length - kept.length;
    const note = `(${skipped} earlier lines not shown; ask for more with \`lines\`)`;
    const head = skipped > 0 ? [note] : [];
    return [...head, ...kept].join("\n");
}

function bounded(text: string): string {
    if (text.length <= MISSION_READ_CHARS_MAX) {
        return text;
    }
    return (
        text.slice(0, MISSION_READ_CHARS_MAX) +
        `\n\n(cut at ${MISSION_READ_CHARS_MAX} characters; read one section at a time)`
    );
}

/**
 * How the lead works: build the change, verify it, open the pull request, keep it ready.
 * There is one way of working, with no gate and no plan to approve (2026-11-12, and since
 * 2026-11-23 the only one).
 */
function work_lines(): string[] {
    return [
        "Build the change, verify it yourself, open the pull request with `pr` `open`, and",
        "keep it ready: Spinner sends you failed checks and new review comments; fix them and",
        "answer the threads without waiting for the operator. Decide open points yourself and",
        "log the assumption; do not ask for a plan approval.",
        "One request is one change: one branch, one pull request. A new request that does not",
        "belong to an open pull request is a new change: `change` `start` with a title, then",
        "build, then `pr` `open` with a `body`. A follow-up to an open pull request is a",
        "commit on its change (`change` `switch` to it first when it is not the current one).",
        "Work that needs an unmerged change starts `on` it. Commit before you start or switch.",
        "Never make or switch a branch with git; the operator says when two requests share a PR.",
        "A session without a project has no repo worktree, no stack and no preview. When the",
        "work needs one (a new repo, an app to run and show), make the project yourself:",
        "`project` `help`, then `create` and `attach`, then `stack` `up`.",
    ];
}

/**
 * The EGM skills, for a lead that has them: tools the operator asks for, not a stage of the
 * session. The lines say where the skills write and how the Goldfish run in pi, which EGM's
 * own files do not know.
 */
function egm_lines(root: string, artifacts: string): string[] {
    return [
        "The EGM skills are installed as tools: /skill:egm-brainstorm, egm-draft, egm-review,",
        "egm-review-loop, egm-resolve, egm-drift-report. Run one only when the operator asks",
        "for it; never propose one. Nothing in a session needs one.",
        `EGM plugin root: ${root}. EGM artifact directory: ${artifacts}. A skill writes every`,
        "file there, the design doc too, unless the operator names another place.",
        `You run in pi, not Codex or Claude Code: read ${root}/docs/harnesses.md once, before`,
        "the first skill. The Goldfish are pi-subagents agents (the `subagent` tool):",
        "egm-zoom-out, egm-design, egm-comprehension, egm-structural, egm-style,",
        "egm-implementation-readiness and egm-codebase-details. A Goldfish cannot spawn",
        "subagents here, so launch each one yourself, with context \"fresh\" and the default",
        "async launch. Wait for every Goldfish of a stage, with bg_wait if needed, before you",
        "consolidate. Ask a skill's gate in your reply, with its options, and end your turn.",
    ];
}

/** The lines under `## <heading>` up to the next `## `. */
export function section_body(text: string, heading: string): string {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
    if (start === -1) {
        return "";
    }
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (line.startsWith("## ")) {
            break;
        }
        body.push(line);
    }
    return body.join("\n");
}

function read_or_empty(path: string): string {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
}
