// The `spinner_session` system-prompt section (docs/SESSION_PROTOCOL.md, "What the pi
// extension provides"): session id, hostnames, the agent's brief, the full `MISSION.md` and
// one digest line per other agent from the Roster. Built fresh on every run from the files
// in the session directory, so the agent never works from a stale mission. The hosts come
// from the daemon's view when it answers, because `session.yaml` is YAML and the extension
// has no YAML parser; the rest is read from disk.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSION_VERSION, type SessionView } from "@spinner/protocol";
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
    };
}

/** Pure: the section text. A newer `session.yaml` than this extension knows is refused. */
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
            "and `agent_steer` run the other agents; `adopt` brings a pull request in. The",
            "operator pushes, posts, approves, lands, resets and closes; you do not.",
        );
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
