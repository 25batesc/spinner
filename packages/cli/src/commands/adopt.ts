// `spinner adopt <pr-url>... [--project <name|path>] [--title <title>]`: put PRs that were
// opened outside Spinner on the board. Creates the session directory with `session.yaml` and
// a minimal `MISSION.md`; no worktrees, no stack.
import { parseArgs } from "node:util";
import { actions, gh_runner, type SpinnerHome } from "@spinner/daemon";
import { describe_error, type CliIo, type Command } from "./command.js";

export const adopt_command: Command = {
    name: "adopt",
    usage: "<pr-url>... [--project <name|path>] [--title <title>]",
    summary: "track existing PRs as a session (no worktrees)",
    run: (args, home, io) => run_adopt(args, home, io),
};

async function run_adopt(args: string[], home: SpinnerHome, io: CliIo): Promise<number> {
    const parsed = parseArgs({
        args,
        options: { project: { type: "string" }, title: { type: "string" } },
        allowPositionals: true,
        strict: true,
    });
    if (parsed.positionals.length === 0) {
        io.err("spinner adopt: at least one pull request URL is required");
        return 1;
    }
    try {
        const ctx = { home, cwd: process.cwd(), gh: gh_runner };
        const { project, title } = parsed.values;
        const request = {
            urls: parsed.positionals,
            ...(project === undefined ? {} : { project }),
            ...(title === undefined ? {} : { title }),
        };
        await actions.adopt(ctx, request, io.out);
        return 0;
    } catch (error) {
        io.err(`spinner adopt: ${describe_error(error)}`);
        return 1;
    }
}
