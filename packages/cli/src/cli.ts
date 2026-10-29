// The `spinner` command. Each subcommand lives in `commands/<name>.ts`; this file only keeps
// the registry and the dispatch. The stack runner's commands come from `commands/stack.ts`;
// the pipeline board's come from `commands/pipeline.ts`. The CLI works on the session tree
// directly through the daemon's library, so no daemon needs to run for it.
import { resolve_home } from "@spinner/daemon";
import type { CliIo, Command } from "./commands/command.js";
import { approve_command } from "./commands/approve.js";
import { daemon_command } from "./commands/daemon.js";
import { fix_command } from "./commands/fix.js";
import { land_command } from "./commands/land.js";
import { PIPELINE_COMMANDS } from "./commands/pipeline.js";
import { post_command } from "./commands/post.js";
import { pr_command } from "./commands/pr.js";
import { reset_command } from "./commands/reset.js";
import { STACK_COMMANDS } from "./commands/stack.js";

export type { CliIo } from "./commands/command.js";

const COMMANDS: Command[] = [
    ...STACK_COMMANDS,
    ...PIPELINE_COMMANDS,
    pr_command,
    fix_command,
    post_command,
    approve_command,
    land_command,
    reset_command,
    daemon_command,
];

export const USAGE = render_usage(COMMANDS);

/** Runs one CLI invocation and returns the exit code. Never throws for user errors. */
export async function run_cli(argv: string[], io: CliIo): Promise<number> {
    const name = argv[0];
    const rest = argv.slice(1);
    const home = resolve_home(io.env);
    if (name === undefined || name === "help" || name === "--help") {
        io.out(USAGE);
        return name === undefined ? 1 : 0;
    }
    const command = COMMANDS.find((entry) => entry.name === name);
    if (command === undefined) {
        io.err(`spinner: unknown command "${name}"`);
        io.err(USAGE);
        return 1;
    }
    return command.run(rest, home, io);
}

function render_usage(commands: Command[]): string {
    const width = Math.max(...commands.map((entry) => `${entry.name} ${entry.usage}`.length));
    const lines = commands.map((entry) => {
        const left = `${entry.name} ${entry.usage}`.padEnd(width);
        return `  spinner ${left}  ${entry.summary}`;
    });
    const help = `  spinner ${"help".padEnd(width)}  print this text`;
    return ["usage:", ...lines, help].join("\n");
}
