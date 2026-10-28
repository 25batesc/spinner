// `spinner new <title> [--slug <slug>] [--project <name|path>]`: create a session; with a
// project, copy its spec in and make one worktree per repo on the session branch.
import { parseArgs } from "node:util";
import { actions, gh_runner, type SpinnerHome } from "@spinner/daemon";
import { describe_error, type CliIo, type Command } from "./command.js";

export const new_command: Command = {
    name: "new",
    usage: "<title> [--slug <slug>] [--project <name|path>]",
    summary: "create a session under $SPINNER_HOME/sessions",
    run: run_new,
};

async function run_new(args: string[], home: SpinnerHome, io: CliIo): Promise<number> {
    const parsed = parseArgs({
        args,
        options: { slug: { type: "string" }, project: { type: "string" } },
        allowPositionals: true,
        strict: true,
    });
    const title = parsed.positionals.join(" ").trim();
    if (title.length === 0) {
        io.err("spinner new: a title is required");
        return 1;
    }
    try {
        const ctx = { home, cwd: process.cwd(), gh: gh_runner };
        const { slug, project } = parsed.values;
        const request = {
            title,
            ...(slug === undefined ? {} : { slug }),
            ...(project === undefined ? {} : { project }),
        };
        const summary = actions.new_session(ctx, request);
        await actions.attach_new_session(ctx, summary, project, io.out);
        return 0;
    } catch (error) {
        io.err(`spinner new: ${describe_error(error)}`);
        return 1;
    }
}
