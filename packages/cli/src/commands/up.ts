// `spinner up <session> [--build]`: clone the database, start the compose project, wait for
// the healthchecks and print the URLs. Prints the elapsed time, which the 15 s target is about.
import { parseArgs } from "node:util";
import { stack_up, type SpinnerHome } from "@spinner/daemon";
import { describe_error, type CliIo, type Command } from "./command.js";
import { session_arg } from "./session-arg.js";

export const up_command: Command = {
    name: "up",
    usage: "<session> [--build]",
    summary: "clone the DB, compose up, wait for healthchecks, print URLs",
    run: run_up,
};

async function run_up(args: string[], home: SpinnerHome, io: CliIo): Promise<number> {
    const parsed = parseArgs({
        args,
        options: { build: { type: "boolean" } },
        allowPositionals: true,
        strict: true,
    });
    const summary = session_arg("up", parsed.positionals[0], home, io);
    if (summary === null) {
        return 1;
    }
    try {
        const result = await stack_up(summary, { build: parsed.values.build === true }, io.out);
        for (const [service, host] of Object.entries(result.hosts)) {
            io.out(`${service.padEnd(12)} http://${host}`);
        }
        io.out(`up in ${(result.elapsed_ms / 1000).toFixed(1)} s`);
        return 0;
    } catch (error) {
        io.err(`spinner up: ${describe_error(error)}`);
        return 1;
    }
}
