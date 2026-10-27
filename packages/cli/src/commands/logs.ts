// `spinner logs <session> [<service>]`: follow the compose logs in the terminal, or the log
// file of a service that runs on the host.
import {
    compose_attached_for,
    host_service_log,
    run_attached,
    type SpinnerHome,
} from "@spinner/daemon";
import type { CliIo, Command } from "./command.js";
import { session_arg } from "./session-arg.js";

export const logs_command: Command = {
    name: "logs",
    usage: "<session> [<service>]",
    summary: "compose logs -f",
    run: run_logs,
};

async function run_logs(args: string[], home: SpinnerHome, io: CliIo): Promise<number> {
    const summary = session_arg("logs", args[0], home, io);
    if (summary === null) {
        return 1;
    }
    const service = args[1];
    const host_log = service === undefined ? null : host_service_log(summary, service);
    if (host_log !== null) {
        return run_attached("tail", ["-n", "100", "-f", host_log]);
    }
    const selection = service === undefined ? [] : [service];
    return compose_attached_for(summary, ["logs", "--follow", ...selection]);
}
