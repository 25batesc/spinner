// A session's rounds (docs/designs/egm-adoption.md, Technical Plan T14, entry 2.41). `reset`
// records each finished round in `session.yaml` `rounds` since the EGM design; rounds before
// that exist only as `### Round <n> · <branch> · PRs: <list>` headings under
// `## Previous rounds` in MISSION.md, which `archive_round` writes. Every function here is
// pure, so the view and the log route read both sources the same way.
import assert from "node:assert/strict";
import type { PrState, RoundPr, RoundRecord, RoundView, Session } from "@spinner/protocol";
import { ROUNDS_MAX } from "@spinner/protocol";
import { split_mission } from "./mission-sections.js";
import { session_prs } from "./tracker.js";

export interface ParsedRound {
    round: number;
    branch: string;
    prs: { repo: string; number: number; state: PrState }[];
    /** The round's Log: the text up to the next `### ` heading, trimmed. */
    log: string;
}

const ROUND_HEADING = /^### Round (\d+) · (.+?) · PRs: (.*)$/;
const ROUND_PR = /^([^\s#]+)#(\d+) \((draft|open|merged|closed)\)$/;

/** `session.round`, else the number of a `-r<n>` branch suffix, else 1. */
export function round_of(session: Session): number {
    if (session.round !== undefined) {
        return session.round;
    }
    const suffix = /-r(\d+)$/.exec(session.branch ?? "");
    return suffix === null ? 1 : Number(suffix[1]);
}

/**
 * One entry per well-formed `### Round` heading under `## Previous rounds`, oldest first. A
 * heading that does not match is skipped. Past `ROUNDS_MAX` entries the oldest drop.
 */
export function parse_previous_rounds(mission: string): ParsedRound[] {
    const block = split_mission(mission).find((entry) => entry.heading === "Previous rounds");
    if (block === undefined) {
        return [];
    }
    const rounds: ParsedRound[] = [];
    let current: Omit<ParsedRound, "log"> | null = null;
    let log: string[] = [];
    const finish = (): void => {
        if (current !== null) {
            rounds.push({ ...current, log: log.join("\n").trim() });
        }
    };
    for (const line of block.body.split("\n")) {
        if (!line.startsWith("### ")) {
            log.push(line);
            continue;
        }
        finish();
        current = parse_heading(line);
        log = [];
    }
    finish();
    return rounds.slice(-ROUNDS_MAX);
}

function parse_heading(line: string): Omit<ParsedRound, "log"> | null {
    const match = ROUND_HEADING.exec(line.trimEnd());
    if (match === null) {
        return null;
    }
    const list = (match[3] ?? "").trim();
    const prs: ParsedRound["prs"] = [];
    if (list !== "none") {
        for (const item of list.split(", ")) {
            const pr = ROUND_PR.exec(item.trim());
            if (pr === null) {
                return null;
            }
            prs.push({ repo: pr[1] ?? "", number: Number(pr[2]), state: pr[3] as PrState });
        }
    }
    return { round: Number(match[1]), branch: match[2] ?? "", prs };
}

/**
 * Every record of `session.rounds` (`source: "record"`), plus each round parsed from
 * MISSION.md whose number has no record (`source: "mission"`), sorted by round.
 */
export function rounds_of(session: Session, mission: string | null): RoundView[] {
    const records: RoundView[] = (session.rounds ?? []).map((record) => ({
        ...record,
        source: "record",
    }));
    const known = new Set(records.map((record) => record.round));
    const parsed: RoundView[] = (mission === null ? [] : parse_previous_rounds(mission))
        .filter((entry) => !known.has(entry.round))
        .map((entry) => ({
            round: entry.round,
            branch: entry.branch,
            prs: entry.prs.map((pr) => ({ ...pr, url: null, merged_at: null })),
            started: null,
            ended: null,
            source: "mission",
        }));
    return [...records, ...parsed].sort((a, b) => a.round - b.round);
}

/**
 * The record of the round that `reset` ends. Spinner does not record GitHub's merge time, so
 * a merged PR's `merged_at` is its `last_activity`. The round started when the last recorded
 * round ended, else when the session was created.
 */
export function round_record(previous: Session, ended: Date): RoundRecord {
    assert.ok(!Number.isNaN(ended.getTime()), "ended must be a valid time");
    const prs: RoundPr[] = session_prs(previous).map((pr) => ({
        repo: pr.repo,
        number: pr.number,
        url: pr.url,
        state: pr.state,
        merged_at: pr.state === "merged" ? pr.last_activity : null,
    }));
    const last = previous.rounds?.at(-1);
    return {
        round: round_of(previous),
        branch: previous.branch,
        prs,
        started: last?.ended ?? previous.created,
        ended: ended.toISOString(),
    };
}
