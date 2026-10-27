// `spinner seed rebuild (<session> | --project <name|path>) [--copy-only]`: rebuild the
// template database. `--copy-only` copies `seed.source` without running the seed commands.
import { parseArgs } from "node:util";
import {
    find_spec,
    load_spec,
    read_session_spec,
    seed_rebuild,
    type LoadedSpec,
    type SpinnerHome,
} from "@spinner/daemon";
import { describe_error, type CliIo, type Command } from "./command.js";
import { session_arg } from "./session-arg.js";

export const seed_command: Command = {
    name: "seed",
    usage: "rebuild (<session> | --project <name|path>) [--copy-only]",
    summary: "rebuild the template database from the spec's seed",
    run: run_seed,
};

async function run_seed(args: string[], home: SpinnerHome, io: CliIo): Promise<number> {
    const parsed = parseArgs({
        args,
        options: { project: { type: "string" }, "copy-only": { type: "boolean" } },
        allowPositionals: true,
        strict: true,
    });
    const [verb, session_name] = parsed.positionals;
    if (verb !== "rebuild") {
        io.err("spinner seed: usage: spinner seed rebuild (<session> | --project <name|path>)");
        return 1;
    }
    try {
        let loaded: LoadedSpec;
        if (parsed.values.project !== undefined) {
            loaded = load_spec(find_spec(parsed.values.project, home, process.cwd()));
        } else {
            const summary = session_arg("seed", session_name, home, io);
            if (summary === null) {
                return 1;
            }
            loaded = read_session_spec(summary);
        }
        const copy_only = parsed.values["copy-only"] === true;
        await seed_rebuild(home, loaded, { copy_only }, io.out);
        return 0;
    } catch (error) {
        io.err(`spinner seed: ${describe_error(error)}`);
        return 1;
    }
}
