// `spinner board [--refresh] [--watch] [--quiet]`: one line per session, the ones that need
// you first. `--refresh` polls GitHub once before printing; `--watch` polls every
// `github.poll_seconds`, redraws, and sends a macOS notification on each transition.
import { parseArgs } from "node:util";
import {
    gh_runner,
    list_sessions,
    macos_notifier,
    poll_once,
    silent_notifier,
    start_poller,
    stage_index,
    type PollOptions,
    type PollReport,
    type SpinnerHome,
} from "@spinner/daemon";
import type { PullRequest, SessionSummary } from "@spinner/protocol";
import { describe_error, type CliIo, type Command } from "./command.js";

export const board_command: Command = {
    name: "board",
    usage: "[--refresh] [--watch] [--quiet]",
    summary: "every session with its stage; what needs you is on top",
    run: (args, home, io) => run_board(args, home, io),
};

/** The default poll interval when no session names a project with its own `poll_seconds`. */
const POLL_SECONDS_DEFAULT = 60;

async function run_board(args: string[], home: SpinnerHome, io: CliIo): Promise<number> {
    const parsed = parseArgs({
        args,
        options: {
            refresh: { type: "boolean", default: false },
            watch: { type: "boolean", default: false },
            quiet: { type: "boolean", default: false },
            interval: { type: "string" },
        },
        strict: true,
    });
    const options: PollOptions = {
        gh: gh_runner,
        notify: parsed.values.quiet ? silent_notifier : macos_notifier,
        cwd: process.cwd(),
        log: io.err,
    };
    if (parsed.values.watch) {
        const seconds = Number.parseInt(parsed.values.interval ?? "", 10) || POLL_SECONDS_DEFAULT;
        return watch_board(home, options, seconds, io);
    }
    if (parsed.values.refresh) {
        try {
            report_errors(await poll_once(home, options), io);
        } catch (error) {
            io.err(`spinner board: ${describe_error(error)}`);
            return 1;
        }
    }
    print_board(home, io);
    return 0;
}

/** Runs until the process is interrupted; each round clears the screen and reprints. */
function watch_board(
    home: SpinnerHome,
    options: PollOptions,
    seconds: number,
    io: CliIo,
): Promise<number> {
    return new Promise((resolve) => {
        const poller = start_poller(home, options, seconds * 1000, (report) => {
            io.out("\u001b[2J\u001b[H");
            report_errors(report, io);
            print_board(home, io);
            const at = new Date().toLocaleTimeString();
            io.out(`polled ${report.polled.length} session(s) at ${at}; next in ${seconds} s`);
        });
        const stop = (): void => {
            poller.stop();
            resolve(0);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
    });
}

function report_errors(report: PollReport, io: CliIo): void {
    for (const failure of report.errors) {
        io.err(`poll ${failure.dir}: ${failure.error}`);
    }
}

export function print_board(home: SpinnerHome, io: CliIo): void {
    const result = list_sessions(home);
    if (result.sessions.length === 0) {
        io.out(`no sessions under ${home.sessions}`);
    }
    for (const entry of sort_board(result.sessions)) {
        io.out(format_board_line(entry));
        for (const line of format_pr_lines(entry)) {
            io.out(line);
        }
    }
    for (const failure of result.errors) {
        io.err(`skipped ${failure.dir}: ${failure.error}`);
    }
}

/** Sessions that need you first; within each group, later stages first, then by name. */
export function sort_board(sessions: SessionSummary[]): SessionSummary[] {
    return [...sessions].sort((a, b) => {
        const a_needs = a.session.needs_human === null ? 1 : 0;
        const b_needs = b.session.needs_human === null ? 1 : 0;
        if (a_needs !== b_needs) {
            return a_needs - b_needs;
        }
        const by_stage = stage_index(b.session.stage) - stage_index(a.session.stage);
        return by_stage !== 0 ? by_stage : a.dir.localeCompare(b.dir);
    });
}

export function format_board_line(entry: SessionSummary): string {
    const session = entry.session;
    const needs = session.needs_human === null ? "" : `  ← ${session.needs_human}`;
    return `${entry.dir.padEnd(32)} ${session.stage.padEnd(12)}${needs}`;
}

function format_pr_lines(entry: SessionSummary): string[] {
    const lines: string[] = [];
    for (const [repo, spec] of Object.entries(entry.session.repos)) {
        if (spec.pr !== undefined && spec.pr !== null) {
            lines.push(`    ${repo}#${spec.pr.number} ${format_pr(spec.pr)}`);
        }
    }
    return lines;
}

function format_pr(pr: PullRequest): string {
    const threads = `threads ${pr.threads.bots_open}b/${pr.threads.humans_open}h open`;
    const given = pr.approvals.peer.length + (pr.approvals.owner ? 1 : 0);
    const approvals = `approvals ${given}/${pr.approvals.required.length}`;
    const queue = pr.queue === "none" ? "" : ` queue ${pr.queue}`;
    return `${pr.state} checks ${pr.checks} ${threads} review ${pr.review} ${approvals}${queue}`;
}
