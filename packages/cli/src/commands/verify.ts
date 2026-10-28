// `spinner verify <session>`: record that the operator tested the session locally. The tick
// names the head SHA of every PR, so a later push clears it.
import { actions, gh_runner, type SpinnerHome } from "@spinner/daemon";
import { describe_error, type CliIo, type Command } from "./command.js";
import { session_arg } from "./session-arg.js";

export const verify_command: Command = {
    name: "verify",
    usage: "<session>",
    summary: "record your local test of the session's PRs",
    run: async (args, home, io) => run_verify(args, home, io),
};

function run_verify(args: string[], home: SpinnerHome, io: CliIo): number {
    const summary = session_arg("verify", args[0], home, io);
    if (summary === null) {
        return 1;
    }
    try {
        actions.verify({ home, cwd: process.cwd(), gh: gh_runner }, summary, {}, io.out);
        return 0;
    } catch (error) {
        io.err(`spinner verify: ${describe_error(error)}`);
        return 1;
    }
}
