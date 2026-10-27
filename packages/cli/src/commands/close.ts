// `spinner close <session>`: remove containers, volumes, network, database and worktrees,
// keep the branches, and move the session to the archive.
import { stack_close, type SpinnerHome } from "@spinner/daemon";
import { describe_error, type CliIo, type Command } from "./command.js";
import { session_arg } from "./session-arg.js";

export const close_command: Command = {
    name: "close",
    usage: "<session>",
    summary: "compose down -v, drop the DB, remove worktrees, archive the session",
    run: run_close,
};

async function run_close(args: string[], home: SpinnerHome, io: CliIo): Promise<number> {
    const summary = session_arg("close", args[0], home, io);
    if (summary === null) {
        return 1;
    }
    try {
        const result = await stack_close(home, summary, io.out);
        io.out(`archived to ${result.archived_path}`);
        return 0;
    } catch (error) {
        io.err(`spinner close: ${describe_error(error)}`);
        return 1;
    }
}
