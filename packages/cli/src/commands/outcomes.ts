// `spinner outcomes`: the outcome comparison of the EGM Goal (docs/designs/egm-adoption.md,
// entry 6.21). It reads every `session.yaml` under `<home>/sessions` and `<home>/archive`,
// keeps the sessions that have `outcomes`, a `design` block and at least one PR, and prints
// one row per track: sessions, PRs, and the mean fixer rounds and operator steers per PR.
// The PR set of a session is its current PRs plus every PR of its earlier rounds, because
// `reset` clears `repos[*].pr` while `outcomes` keeps counting across rounds.
import type { SpinnerHome } from "@spinner/daemon";
import { list_sessions } from "@spinner/daemon";
import type { DesignTrack, Session } from "@spinner/protocol";
import type { CliIo, Command } from "./command.js";

export const outcomes_command: Command = {
    name: "outcomes",
    usage: "",
    summary: "compare fixer rounds and operator steers per PR, design track vs direct",
    run: (args, home, io) => Promise.resolve(run_outcomes(args, home, io)),
};

/** One printed row: the totals of one track. */
export interface OutcomeRow {
    track: DesignTrack;
    sessions: number;
    prs: number;
    fix_rounds: number;
    operator_steers: number;
}

const TRACKS: readonly DesignTrack[] = ["design", "direct"];

function run_outcomes(args: string[], home: SpinnerHome, io: CliIo): number {
    if (args.length > 0) {
        io.err(`spinner outcomes: takes no arguments, got "${args.join(" ")}"`);
        return 1;
    }
    const live = list_sessions(home);
    // `list_sessions` reads `home.sessions`; the archive has the same layout.
    const archived = list_sessions({ ...home, sessions: home.archive });
    for (const { dir, error } of [...live.errors, ...archived.errors]) {
        io.err(`skipped ${dir}: ${error}`);
    }
    const sessions = [...live.sessions, ...archived.sessions].map((entry) => entry.session);
    for (const line of render_outcomes(outcome_rows(sessions))) {
        io.out(line);
    }
    return 0;
}

/** The `<repo>#<number>` keys of the session's current PRs and its earlier rounds' PRs. */
export function pr_set(session: Session): Set<string> {
    const keys = new Set<string>();
    for (const [repo, entry] of Object.entries(session.repos)) {
        if (entry.pr !== undefined && entry.pr !== null) {
            keys.add(`${repo}#${entry.pr.number}`);
        }
    }
    for (const round of session.rounds ?? []) {
        for (const pr of round.prs) {
            keys.add(`${pr.repo}#${pr.number}`);
        }
    }
    return keys;
}

/** Pure: the totals per track over the sessions that count. Both tracks are always present. */
export function outcome_rows(sessions: readonly Session[]): OutcomeRow[] {
    const rows = TRACKS.map(
        (track): OutcomeRow => ({ track, sessions: 0, prs: 0, fix_rounds: 0, operator_steers: 0 }),
    );
    for (const session of sessions) {
        const outcomes = session.outcomes;
        const track = session.design?.track;
        if (outcomes === undefined || track === undefined) {
            continue;
        }
        const prs = pr_set(session).size;
        if (prs === 0) {
            continue;
        }
        const row = rows.find((entry) => entry.track === track);
        if (row === undefined) {
            continue;
        }
        row.sessions += 1;
        row.prs += prs;
        row.fix_rounds += outcomes.fix_rounds;
        row.operator_steers += outcomes.operator_steers;
    }
    return rows;
}

/** The table: a header and one line per track; a mean over 0 PRs prints `-`. */
export function render_outcomes(rows: readonly OutcomeRow[]): string[] {
    const table = [["track", "sessions", "PRs", "fix_rounds/PR", "operator_steers/PR"]];
    for (const row of rows) {
        table.push([
            row.track,
            String(row.sessions),
            String(row.prs),
            mean(row.fix_rounds, row.prs),
            mean(row.operator_steers, row.prs),
        ]);
    }
    const widths = table[0]?.map((_, column) =>
        Math.max(...table.map((cells) => cells[column]?.length ?? 0)),
    );
    return table.map((cells) =>
        cells
            .map((cell, column) => cell.padEnd(widths?.[column] ?? 0))
            .join("  ")
            .trimEnd(),
    );
}

function mean(sum: number, prs: number): string {
    return prs === 0 ? "-" : (sum / prs).toFixed(2);
}
