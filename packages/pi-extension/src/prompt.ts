// The `spinner_session` system-prompt section (docs/SESSION_PROTOCOL.md, "What the pi
// extension provides"): session id, hostnames, the agent's brief, the full `MISSION.md` and
// one digest line per other agent from the Roster. Built fresh on every run from the files
// in the session directory, so the agent never works from a stale mission. The hosts come
// from the daemon's view when it answers, because `session.yaml` is YAML and the extension
// has no YAML parser; the rest is read from disk.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    DESIGN_STATE_FILE,
    EGM_ARTIFACT_DIR,
    SESSION_VERSION,
    type SessionView,
} from "@spinner/protocol";
import type { SpinnerEnv } from "./env.js";

/** Upper bound on the mission text in the prompt; the protocol targets < 400 lines. */
const MISSION_CHARS_MAX = 120_000;

export interface SessionFiles {
    /** `version:` of `session.yaml`, or null when unreadable. */
    version: number | null;
    id: string;
    title: string;
    brief: string;
    mission: string;
    /** `name → URL` from the daemon's stack view; empty when the daemon did not answer. */
    hosts: Record<string, string>;
    /**
     * `designs_dir` of `<session>/design/.state.json` while its `track` is `design`, else null
     * (3.6). The tracker writes that file; the extension reads JSON, not `session.yaml`.
     */
    designs_dir: string | null;
    /** `track` of the same file: `design` or `direct`; null when the file is absent. */
    track: string | null;
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
        mission: read_or_empty(join(env.session_dir, "MISSION.md")).slice(0, MISSION_CHARS_MAX),
        hosts,
        designs_dir: design_designs_dir(env.session_dir),
        track: design_track(env.session_dir),
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
            "You are the lead (MISSION.md s014): you own the mission. `session_title` sets the",
            "title; `mission_goal`, `mission_done_when` and `mission_plan` write Goal, Done when",
            "and the Plan (ids never change; tick an item the moment it is done); `agent_add`",
            "and `agent_steer` run the other agents; `adopt` brings a pull request in.",
        );
        lines.push(...github_lines(env.github));
        if (env.egm_root !== null && files.track === "design") {
            lines.push(...egm_lines(env.egm_root, env.egm_artifacts ?? "", files.designs_dir));
        } else {
            lines.push(...fast_path_lines(env.egm_root));
        }
    }
    const hosts = Object.entries(files.hosts);
    if (hosts.length > 0) {
        lines.push("", "Hosts:", ...hosts.map(([name, url]) => `- ${name}: ${url}`));
    }
    const digests = roster_digests(files.mission, env.agent);
    if (digests.length > 0) {
        lines.push("", "Other agents:", ...digests.map((line) => `- ${line}`));
    }
    if (files.brief.length > 0) {
        lines.push("", `## Your brief (agents/${env.agent}/BRIEF.md)`, "", files.brief.trim());
    }
    lines.push(
        "",
        "## MISSION.md (read in full; this is the current file)",
        "",
        files.mission.trim(),
    );
    return lines.join("\n");
}

/** `track` of the tracker's `.state.json`; null when the file is absent or unreadable. */
function design_track(session_dir: string): string | null {
    const text = read_or_empty(join(session_dir, EGM_ARTIFACT_DIR, DESIGN_STATE_FILE));
    if (text.length === 0) {
        return null;
    }
    try {
        const state: unknown = JSON.parse(text);
        const track = (state as { track?: unknown } | null)?.track;
        return typeof track === "string" ? track : null;
    } catch {
        return null;
    }
}

/**
 * The designs directory of a design-track session, from the tracker's `.state.json`. Null when
 * the file is absent or unreadable, when its `track` is not `design`, or when the session has
 * no worktree of the designs repo (`designs_dir: null`).
 */
function design_designs_dir(session_dir: string): string | null {
    const text = read_or_empty(join(session_dir, EGM_ARTIFACT_DIR, DESIGN_STATE_FILE));
    if (text.length === 0) {
        return null;
    }
    let state: unknown;
    try {
        state = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof state !== "object" || state === null) {
        return null;
    }
    const { track, designs_dir } = state as { track?: unknown; designs_dir?: unknown };
    if (track !== "design") {
        return null;
    }
    return typeof designs_dir === "string" && designs_dir.length > 0 ? designs_dir : null;
}

/**
 * The lead's lines off the design track: the fast path is the way of working, and EGM is a
 * tool the operator picks (2026-11-12). With EGM installed, where it is, in case he runs a
 * skill from the menu.
 */
function fast_path_lines(egm_root: string | null): string[] {
    const lines = [
        "Track: direct, the fast path. Build the change, verify it yourself, open the pull",
        "request with `pr` `open`, and keep it ready: Spinner sends you failed checks and new",
        "review comments; fix them and answer the threads without waiting for the operator.",
        "Decide open points yourself and log the assumption; do not ask for a plan approval.",
        "One request is one change: one branch, one pull request. A new request that does not",
        "belong to an open pull request is a new change: `change` `start` with a title, then",
        "build, then `pr` `open` with a `body`. A follow-up to an open pull request is a",
        "commit on its change (`change` `switch` to it first when it is not the current one).",
        "Work that needs an unmerged change starts `on` it. Commit before you start or switch.",
        "Never make or switch a branch with git; the operator says when two requests share a PR.",
    ];
    if (egm_root !== null) {
        lines.push(
            "EGM planning is installed but off: only the operator turns it on (the track chip).",
            `If he starts an EGM skill, read ${egm_root}/docs/harnesses.md first.`,
        );
    }
    return lines;
}

/** The lead's EGM lines (docs/designs/egm-adoption.md, 1.23, 3.6). */
function egm_lines(root: string, artifacts: string, designs_dir: string | null): string[] {
    const design_lines =
        designs_dir === null
            ? []
            : [
                  `Designs directory: ${designs_dir}. ` +
                      "Save the design doc there, as an absolute path.",
                  "When the draft's final file is written there, " +
                      "call design_doc with its absolute path.",
              ];
    return [
        "EGM (Elephant-Goldfish Model, Apache-2.0) is loaded. You are the Elephant.",
        `EGM plugin root: ${root}. EGM artifact directory: ${artifacts}.`,
        `You run in pi, not Codex or Claude Code: read ${root}/docs/harnesses.md once.`,
        "EGM skills are /skill:egm-<name>. The subagent tool is `subagent` (pi-subagents).",
        "The Goldfish are registered as egm-zoom-out, egm-design, egm-comprehension,",
        "egm-structural, egm-style, egm-implementation-readiness and egm-codebase-details.",
        "In this harness a Goldfish cannot spawn subagents: egm-synthesizer has no subagent",
        "tool. So use direct dispatch: launch each Goldfish yourself.",
        'Launch them with context "fresh" and the default async launch. Each result arrives',
        "as a completion message. Wait for every Goldfish of a stage, with bg_wait if needed,",
        "before you consolidate.",
        ...design_lines,
        "For an EGM gate with options, call ask_question with the gate's JSON payload, " +
            "then end your turn.",
    ];
}

/**
 * The operator agent's section (MISSION.md s013): who it is, its directory, the tools, and
 * its brief from `<home>/operator/BRIEF.md`. The sessions come from the tools, not the prompt,
 * so a long-lived transcript does not carry a stale list.
 */
export function render_operator_section(env: SpinnerEnv, brief: string): string {
    const lines = [
        "You are the operator agent of this Spinner home (role operator). You have no session",
        `of your own. Your directory is ${env.session_dir}; your cwd is the home.`,
        "Create and run sessions through the tools `session_new`, `session_adopt`,",
        "`session_attach`, `session_list`, `session_show`, `mission_write`, `brief_write`,",
        "`agent_add`, `agent_steer`, `inbox_send`, `stack` and `pr`. Every tool but the first",
        "four takes the session directory `session_list` shows. Do not edit a session's files",
        "with `edit` or `write`; the daemon writes them for you.",
        "A message that starts with a session directory is a notice from the daemon.",
    ];
    if (brief.length > 0) {
        lines.push("", "## Your brief (operator/BRIEF.md)", "", brief.trim());
    }
    return lines.join("\n");
}

/** `name: doing (blocked: what)` for every Roster row but the agent's own. */
export function roster_digests(mission: string, own: string): string[] {
    const roster = section_body(mission, "Roster");
    const digests: string[] = [];
    for (const line of roster.split("\n")) {
        if (!line.startsWith("|")) {
            continue;
        }
        const cells = line
            .replace(/^\|/, "")
            .replace(/\|\s*$/, "")
            .split("|")
            .map((cell) => cell.trim());
        const name = cells[0] ?? "";
        if (name === "" || name === "Agent" || /^-+$/.test(name) || name === own) {
            continue;
        }
        const doing = cells[2] ?? "—";
        const blocked = cells[3] ?? "no";
        digests.push(
            blocked === "no" || blocked === ""
                ? `${name}: ${doing}`
                : `${name}: ${doing} (blocked: ${blocked})`,
        );
    }
    return digests;
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
