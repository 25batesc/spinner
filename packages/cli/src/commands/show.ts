// `spinner show [<session>]`: list sessions, or show one in detail.
import assert from "node:assert/strict";
import { list_sessions, type SpinnerHome } from "@spinner/daemon";
import type { SessionSummary } from "@spinner/protocol";
import type { CliIo, Command } from "./command.js";

export const show_command: Command = {
    name: "show",
    usage: "[<session>]",
    summary: "list sessions, or show one",
    run: async (args, home, io) => run_show(args, home, io),
};

function run_show(args: string[], home: SpinnerHome, io: CliIo): number {
    const result = list_sessions(home);
    const wanted = args[0];
    if (wanted !== undefined) {
        const match = result.sessions.find((entry) => matches(entry, wanted));
        if (match === undefined) {
            io.err(`spinner show: no session "${wanted}" under ${home.sessions}`);
            return 1;
        }
        io.out(format_session_detail(match));
        return 0;
    }
    if (result.sessions.length === 0) {
        io.out(`no sessions under ${home.sessions}`);
    }
    for (const entry of result.sessions) {
        io.out(format_session_line(entry));
    }
    for (const failure of result.errors) {
        io.err(`skipped ${failure.dir}: ${failure.error}`);
    }
    return 0;
}

/** A session is named by its directory (`s17-refund-flow`) or by its id (`s17`). */
export function matches(entry: SessionSummary, wanted: string): boolean {
    return entry.dir === wanted || entry.session.id === wanted;
}

/** One line per session: dir, stage, stack state, needs_human. */
export function format_session_line(entry: SessionSummary): string {
    const needs = entry.session.needs_human ?? "-";
    const stage = entry.session.stage.padEnd(12);
    return `${entry.dir.padEnd(32)} ${stage} ${entry.session.stack.state.padEnd(8)} ${needs}`;
}

function worktree_suffix(worktree: string | undefined): string {
    return worktree === undefined ? "" : ` → ${worktree}`;
}

function db_suffix(db: string | undefined): string {
    return db === undefined ? "" : ` (db ${db})`;
}

function format_session_detail(entry: SessionSummary): string {
    const session = entry.session;
    assert.ok(session.id.length > 0);
    const agents = Object.entries(session.agents).map(
        ([name, spec]) => `  ${name}: ${spec.model} (${spec.process})`,
    );
    const repos = Object.entries(session.repos).map(
        ([name, repo]) => `  ${name}: ${repo.path}${worktree_suffix(repo.worktree)}`,
    );
    const hosts = Object.entries(session.stack.hosts ?? {}).map(
        ([name, host]) => `  ${name}: http://${host}`,
    );
    return [
        `${session.id} · ${session.title}`,
        `path:        ${entry.path}`,
        `stage:       ${session.stage}`,
        `needs_human: ${session.needs_human ?? "-"}`,
        `branch:      ${session.branch} (base ${session.base})`,
        `repos:${repos.length === 0 ? " -" : `\n${repos.join("\n")}`}`,
        `stack:       ${session.stack.state}${db_suffix(session.stack.db)}`,
        `hosts:${hosts.length === 0 ? " -" : `\n${hosts.join("\n")}`}`,
        `agents:${agents.length === 0 ? " -" : `\n${agents.join("\n")}`}`,
    ].join("\n");
}
