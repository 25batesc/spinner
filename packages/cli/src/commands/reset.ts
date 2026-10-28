// `spinner reset <session> [--branch <name>]`: start the next round after the merge: a new
// branch from fresh base in every worktree, facts cleared, the Log kept under Previous rounds.
import { parseArgs } from "node:util";
import { actions, gh_runner, type SpinnerHome } from "@spinner/daemon";
import { describe_error, type CliIo, type Command } from "./command.js";
import { session_arg } from "./session-arg.js";

export const reset_command: Command = {
    name: "reset",
    usage: "<session> [--branch <name>]",
    summary: "start the next round: new branch from fresh base, facts cleared",
    run: (args, home, io) => run_reset(args, home, io),
};

async function run_reset(args: string[], home: SpinnerHome, io: CliIo): Promise<number> {
    const parsed = parseArgs({
        args,
        options: { branch: { type: "string" } },
        allowPositionals: true,
        strict: true,
    });
    const summary = session_arg("reset", parsed.positionals[0], home, io);
    if (summary === null) {
        return 1;
    }
    const request = parsed.values.branch === undefined ? {} : { branch: parsed.values.branch };
    try {
        const ctx = { home, cwd: process.cwd(), gh: gh_runner };
        const result = await actions.reset(ctx, summary, request, io.out);
        io.out(`round ${result.session.round ?? 1} on ${result.session.branch}`);
        return 0;
    } catch (error) {
        io.err(`spinner reset: ${describe_error(error)}`);
        return 1;
    }
}
