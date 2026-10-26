// The `spinner` command. In the walking skeleton the CLI works on the session tree directly
// through the daemon's session store; the daemon notices new directories through its watcher,
// so no HTTP call is needed for `new`. Later commands that need a running daemon (stacks,
// agents) will talk to it over HTTP.
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { create_session, list_sessions, resolve_home, type SpinnerHome } from "@spinner/daemon";
import type { SessionSummary } from "@spinner/protocol";

export interface CliIo {
    env: NodeJS.ProcessEnv;
    out: (line: string) => void;
    err: (line: string) => void;
}

export const USAGE = [
    "usage:",
    "  spinner new <title> [--slug <slug>]   create a session under $SPINNER_HOME/sessions",
    "  spinner show [<dir>]                   list sessions, or show one",
    "  spinner help                           print this text",
].join("\n");

/** Runs one CLI invocation and returns the exit code. Never throws for user errors. */
export function run_cli(argv: string[], io: CliIo): number {
    const command = argv[0];
    const rest = argv.slice(1);
    const home = resolve_home(io.env);
    if (command === undefined || command === "help" || command === "--help") {
        io.out(USAGE);
        return command === undefined ? 1 : 0;
    }
    if (command === "new") {
        return run_new(rest, home, io);
    }
    if (command === "show") {
        return run_show(rest, home, io);
    }
    io.err(`spinner: unknown command "${command}"`);
    io.err(USAGE);
    return 1;
}

function run_new(args: string[], home: SpinnerHome, io: CliIo): number {
    const parsed = parseArgs({
        args,
        options: { slug: { type: "string" } },
        allowPositionals: true,
        strict: true,
    });
    const title = parsed.positionals.join(" ").trim();
    if (title.length === 0) {
        io.err("spinner new: a title is required");
        return 1;
    }
    try {
        const slug = parsed.values.slug;
        const summary = create_session(home, slug === undefined ? { title } : { title, slug });
        io.out(`created ${summary.path}`);
        return 0;
    } catch (error) {
        io.err(`spinner new: ${describe_error(error)}`);
        return 1;
    }
}

function run_show(args: string[], home: SpinnerHome, io: CliIo): number {
    const result = list_sessions(home);
    const wanted = args[0];
    if (wanted !== undefined) {
        const match = result.sessions.find((entry) => entry.dir === wanted);
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

/** One line per session: dir, stage, needs_human. */
export function format_session_line(entry: SessionSummary): string {
    const needs = entry.session.needs_human ?? "-";
    return `${entry.dir.padEnd(32)} ${entry.session.stage.padEnd(12)} ${needs}`;
}

function format_session_detail(entry: SessionSummary): string {
    const session = entry.session;
    assert.ok(session.id.length > 0);
    const agents = Object.entries(session.agents).map(
        ([name, spec]) => `  ${name}: ${spec.model} (${spec.process})`,
    );
    const repos = Object.keys(session.repos);
    return [
        `${session.id} · ${session.title}`,
        `path:        ${entry.path}`,
        `stage:       ${session.stage}`,
        `needs_human: ${session.needs_human ?? "-"}`,
        `branch:      ${session.branch} (base ${session.base})`,
        `repos:       ${repos.length === 0 ? "-" : repos.join(", ")}`,
        `stack:       ${session.stack.state}`,
        `agents:${agents.length === 0 ? " -" : `\n${agents.join("\n")}`}`,
    ].join("\n");
}

function describe_error(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
