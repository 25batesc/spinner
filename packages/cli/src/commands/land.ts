// `spinner land <session> [--pr <repo>]`: enqueue each PR with its verified head, watch the
// queue, rebase and re-enqueue on a pop-out, and report the merge.
import { parseArgs } from "node:util";
import { actions, gh_runner, type SpinnerHome } from "@spinner/daemon";
import { describe_error, type CliIo, type Command } from "./command.js";
import { session_arg } from "./session-arg.js";

export const land_command: Command = {
    name: "land",
    usage: "<session> [--pr <repo>]",
    summary: "enqueue the PRs with their heads, watch, rebase on pop-out, report the merge",
    run: (args, home, io) => run_land(args, home, io),
};

async function run_land(args: string[], home: SpinnerHome, io: CliIo): Promise<number> {
    const parsed = parseArgs({
        args,
        options: { pr: { type: "string" } },
        allowPositionals: true,
        strict: true,
    });
    const summary = session_arg("land", parsed.positionals[0], home, io);
    if (summary === null) {
        return 1;
    }
    const request = parsed.values.pr === undefined ? {} : { pr: parsed.values.pr };
    try {
        const ctx = { home, cwd: process.cwd(), gh: gh_runner };
        const merged = await actions.land(ctx, summary, request, io.out);
        io.out(`merged: ${merged.join(", ")}`);
        return 0;
    } catch (error) {
        io.err(`spinner land: ${describe_error(error)}`);
        return 1;
    }
}
