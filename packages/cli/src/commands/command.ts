// The shape every `spinner` subcommand has. `cli.ts` keeps a registry of these and dispatches
// on the first argument, so a new command is one file plus one entry in its track's list
// (`commands/stack.ts` for the stack runner, `commands/pipeline.ts` for the board).
import type { SpinnerHome } from "@spinner/daemon";

export interface CliIo {
    env: NodeJS.ProcessEnv;
    out: (line: string) => void;
    err: (line: string) => void;
}

export interface Command {
    name: string;
    /** Arguments as shown in the usage text, for example `<title> [--slug <slug>]`. */
    usage: string;
    summary: string;
    /** Runs the command and returns the exit code. User errors are printed, never thrown. */
    run: (args: string[], home: SpinnerHome, io: CliIo) => Promise<number>;
}

export function describe_error(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
