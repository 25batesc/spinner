// `spinner down <session>`: stop the containers. Volumes and the database stay.
import { stack_down, type SpinnerHome } from "@spinner/daemon";
import { describe_error, type CliIo, type Command } from "./command.js";
import { session_arg } from "./session-arg.js";

export const down_command: Command = {
    name: "down",
    usage: "<session>",
    summary: "compose stop (volumes and database kept)",
    run: run_down,
};

async function run_down(args: string[], home: SpinnerHome, io: CliIo): Promise<number> {
    const summary = session_arg("down", args[0], home, io);
    if (summary === null) {
        return 1;
    }
    try {
        await stack_down(summary, io.out);
        return 0;
    } catch (error) {
        io.err(`spinner down: ${describe_error(error)}`);
        return 1;
    }
}
