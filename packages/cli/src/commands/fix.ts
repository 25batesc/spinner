// `spinner fix <session> [--pr <repo>]`: render `threads/` from GitHub and start or steer
// the fixer agent on every open thread. The CLI works on the session tree directly, so the
// fixer agent (which lives in the daemon) is only reached when the daemon runs the job;
// here the command renders the threads and prints what the fixer would get.
import { parseArgs } from "node:util";
import { actions, gh_runner, type SpinnerHome } from "@spinner/daemon";
import type { FixRequest } from "@spinner/protocol";
import { describe_error, type CliIo, type Command } from "./command.js";
import { session_arg } from "./session-arg.js";

export const fix_command: Command = {
    name: "fix",
    usage: "<session> [--pr <repo>]",
    summary: "render threads/ from GitHub and start or steer the fixer on them",
    run: (args, home, io) => run_fix(args, home, io),
};

async function run_fix(args: string[], home: SpinnerHome, io: CliIo): Promise<number> {
    const parsed = parseArgs({
        args,
        options: { pr: { type: "string" } },
        allowPositionals: true,
        strict: true,
    });
    const summary = session_arg("fix", parsed.positionals[0], home, io);
    if (summary === null) {
        return 1;
    }
    const request: FixRequest = parsed.values.pr === undefined ? {} : { pr: parsed.values.pr };
    try {
        const ctx = { home, cwd: process.cwd(), gh: gh_runner };
        const result = await actions.fix(ctx, summary, request, io.out);
        for (const pr of result.view.prs) {
            for (const thread of pr.threads.filter((entry) => entry.state === "open")) {
                const where = thread.path === null ? "" : ` ${thread.path}:${thread.line ?? "-"}`;
                const flag = thread.flagged === null ? "" : ` ⚑ ${thread.flagged}`;
                io.out(`${pr.repo}#${pr.number} ${thread.label} ${thread.author}${where}${flag}`);
            }
        }
        return 0;
    } catch (error) {
        io.err(`spinner fix: ${describe_error(error)}`);
        return 1;
    }
}
