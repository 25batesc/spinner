// `spinner new <title> [--slug <slug>] [--project <name|path>]`: create a session; with a
// project, copy its spec in and make one worktree per repo on the session branch.
import { parseArgs } from "node:util";
import {
    attach_project,
    create_session,
    find_spec,
    load_spec,
    type SpinnerHome,
} from "@spinner/daemon";
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
        const loaded =
            parsed.values.project === undefined
                ? null
                : load_spec(find_spec(parsed.values.project, home, process.cwd()));
        const slug = parsed.values.slug;
        const summary = create_session(home, slug === undefined ? { title } : { title, slug });
        io.out(`created ${summary.path}`);
        if (loaded !== null) {
            await attach_project(summary, loaded, io.out);
            io.out(`project ${loaded.spec.name} attached; next: spinner up ${summary.session.id}`);
        }
        return 0;
    } catch (error) {
        io.err(`spinner new: ${describe_error(error)}`);
        return 1;
    }
}
