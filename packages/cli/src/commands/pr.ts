// `spinner pr <session> [--repo <key>]... [--draft]`: push every repo with commits ahead of
// its base and open one PR per repo as the operator, body from the mission doc.
import { parseArgs } from "node:util";
import { actions, gh_runner, type SpinnerHome } from "@spinner/daemon";
import type { PrRequest } from "@spinner/protocol";
import { describe_error, type CliIo, type Command } from "./command.js";
import { session_arg } from "./session-arg.js";

export const pr_command: Command = {
    name: "pr",
    usage: "<session> [--repo <key>]... [--draft]",
    summary: "push changed repos and open one PR per repo as you",
    run: (args, home, io) => run_pr(args, home, io),
};

async function run_pr(args: string[], home: SpinnerHome, io: CliIo): Promise<number> {
    const parsed = parseArgs({
        args,
        options: { repo: { type: "string", multiple: true }, draft: { type: "boolean" } },
        allowPositionals: true,
        strict: true,
    });
    const summary = session_arg("pr", parsed.positionals[0], home, io);
    if (summary === null) {
        return 1;
    }
    const request: PrRequest = {};
    if (parsed.values.repo !== undefined && parsed.values.repo.length > 0) {
        request.repos = parsed.values.repo;
    }
    if (parsed.values.draft === true) {
        request.draft = true;
    }
    try {
        await actions.pr({ home, cwd: process.cwd(), gh: gh_runner }, summary, request, io.out);
        return 0;
    } catch (error) {
        io.err(`spinner pr: ${describe_error(error)}`);
        return 1;
    }
}
