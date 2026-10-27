// `spinner exec <session> <service> -- <cmd...>`: run a command inside a service container.
import { compose_attached_for, type SpinnerHome } from "@spinner/daemon";
import type { CliIo, Command } from "./command.js";
import { session_arg } from "./session-arg.js";

export const exec_command: Command = {
    name: "exec",
    usage: "<session> <service> -- <cmd...>",
    summary: "run a command in a service container",
    run: run_exec,
};

async function run_exec(args: string[], home: SpinnerHome, io: CliIo): Promise<number> {
    const summary = session_arg("exec", args[0], home, io);
    if (summary === null) {
        return 1;
    }
    const service = args[1];
    const command = args.slice(2).filter((arg, index) => !(index === 0 && arg === "--"));
    if (service === undefined || command.length === 0) {
        io.err("spinner exec: usage: spinner exec <session> <service> -- <cmd...>");
        return 1;
    }
    return compose_attached_for(summary, ["exec", service, ...command]);
}
