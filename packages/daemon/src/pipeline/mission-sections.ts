// Reads the sections of MISSION.md the pipeline commands need (`pr` builds a PR body from
// Goal, Done when and the Log; `reset` moves the round's history under `## Previous rounds`)
// and appends Log lines for them. Pure functions over the file text; the callers read and
// write the file. The daemon's serialized mission writer (ext, `store/mission-*.ts`) owns
// tool writes; these are the pipeline's own, made from inside a job.
import assert from "node:assert/strict";

/** A `## ` heading and the lines under it, up to the next `## ` heading. */
export interface MissionBlock {
    heading: string;
    body: string;
}

/** Upper bound on headings; a mission has seven sections plus a few rounds. */
const BLOCKS_MAX = 100;

/** Splits the text at `## ` headings. Text before the first heading is the title block. */
export function split_mission(text: string): MissionBlock[] {
    const blocks: MissionBlock[] = [];
    let current: MissionBlock = { heading: "", body: "" };
    for (const line of text.split("\n")) {
        if (line.startsWith("## ")) {
            blocks.push(current);
            assert.ok(blocks.length < BLOCKS_MAX, `more than ${BLOCKS_MAX} sections`);
            current = { heading: line.slice(3).trim(), body: "" };
            continue;
        }
        current.body += `${line}\n`;
    }
    blocks.push(current);
    return blocks;
}

export function join_mission(blocks: readonly MissionBlock[]): string {
    return blocks
        .map((block) => (block.heading === "" ? block.body : `## ${block.heading}\n${block.body}`))
        .join("");
}

/** The body of the section with `heading`, trimmed, or "" when the section is absent. */
export function mission_section(text: string, heading: string): string {
    const block = split_mission(text).find((entry) => entry.heading === heading);
    return block === undefined ? "" : block.body.trim();
}

/** Appends `- HH:MM author: text` at the end of the Log section. */
export function append_log_line(text: string, time: string, author: string, line: string): string {
    assert.ok(/^\d\d:\d\d$/.test(time), `time must be HH:MM, got "${time}"`);
    const blocks = split_mission(text);
    const log = blocks.find((entry) => entry.heading === "Log");
    const entry = `- ${time} ${author}: ${line}\n`;
    if (log === undefined) {
        blocks.push({ heading: "Log", body: entry });
        return join_mission(blocks);
    }
    log.body = `${log.body.replace(/\n+$/, "")}\n${entry}`;
    return join_mission(blocks);
}

/** The PR body `spinner pr` writes: Goal, Done when and the Log of the session. */
export function pr_body_from_mission(text: string, session_id: string): string {
    const goal = mission_section(text, "Goal");
    const done_when = mission_section(text, "Done when");
    const log = mission_section(text, "Log");
    const parts = [
        "## Goal",
        goal.length > 0 ? goal : "(no goal written)",
        "",
        "## Done when",
        done_when.length > 0 ? done_when : "(no acceptance list written)",
        "",
        "## Log",
        log.length > 0 ? log : "(empty)",
        "",
        `_Opened by Spinner from session ${session_id}._`,
        "",
    ];
    return parts.join("\n");
}

/**
 * `reset`: moves the Log and the Roster's Doing cells of the round that ended under
 * `## Previous rounds` and starts a fresh Log. Goal, Done when, Plan, Contracts and Open
 * questions stay, because the next round continues the same mission.
 */
export function archive_round(text: string, round: number, summary: string): string {
    assert.ok(round >= 1, "round must be at least 1");
    const blocks = split_mission(text);
    const log = blocks.find((entry) => entry.heading === "Log");
    const old_log = log === undefined ? "" : log.body.trim();
    const history = `### Round ${round} · ${summary}\n${old_log}\n\n`;
    const previous = blocks.find((entry) => entry.heading === "Previous rounds");
    if (previous === undefined) {
        blocks.push({ heading: "Previous rounds", body: `${history}` });
    } else {
        previous.body = `${previous.body.replace(/\n+$/, "")}\n\n${history}`;
    }
    if (log !== undefined) {
        log.body = "\n";
    }
    return join_mission(blocks);
}
