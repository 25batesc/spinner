// `spinner verify <session>`: record that the operator tested the session locally. The tick
// names the head SHA of every PR, so a later push clears it.
import { userInfo } from "node:os";
import { config_for, verify_session, type SpinnerHome } from "@spinner/daemon";
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
        const config = config_for(summary.session, home, process.cwd(), io.err);
        const by = userInfo().username;
        const verified = verify_session(home, { dir: summary.dir, by, config });
        const heads = Object.entries(verified.session.pipeline?.verified_heads ?? {})
            .map(([repo, head]) => `${repo}@${head.slice(0, 7)}`)
            .join(", ");
        io.out(`verified ${summary.dir}: ${heads}`);
        const needs = verified.session.needs_human ?? "-";
        io.out(`stage: ${verified.session.stage}; needs_human: ${needs}`);
        return 0;
    } catch (error) {
        io.err(`spinner verify: ${describe_error(error)}`);
        return 1;
    }
}
