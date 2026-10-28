// `spinner down <session>`: stop the containers. Volumes and the database stay.
// `spinner down --shared`: remove the shared proxy and Postgres containers once no stack is up.
import { actions, gh_runner, shared_down, type SpinnerHome } from "@spinner/daemon";
import { describe_error, type CliIo, type Command } from "./command.js";
import { session_arg } from "./session-arg.js";

export const down_command: Command = {
    name: "down",
    usage: "<session> | --shared [--force]",
    summary: "compose stop (volumes and database kept); --shared removes proxy and postgres",
    run: run_down,
};

async function run_down(args: string[], home: SpinnerHome, io: CliIo): Promise<number> {
    if (args[0] === "--shared") {
        try {
            await shared_down(home, { force: args.includes("--force") }, io.out);
            return 0;
        } catch (error) {
            io.err(`spinner down: ${describe_error(error)}`);
            return 1;
        }
    }
    const summary = session_arg("down", args[0], home, io);
    if (summary === null) {
        return 1;
    }
    try {
        await actions.down({ home, cwd: process.cwd(), gh: gh_runner }, summary, io.out);
        return 0;
    } catch (error) {
        io.err(`spinner down: ${describe_error(error)}`);
        return 1;
    }
}
