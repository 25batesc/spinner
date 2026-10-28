// `spinner post <session> [--to <reviewer>] [--yes]`: compose the Slack message for the PR
// set, show it, and post it as the operator on confirmation. Without `--yes` the command
// prints the message and asks on the terminal; a non-interactive run must pass `--yes`.
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { actions, gh_runner, type SpinnerHome } from "@spinner/daemon";
import { describe_error, type CliIo, type Command } from "./command.js";
import { session_arg } from "./session-arg.js";

export const post_command: Command = {
    name: "post",
    usage: "<session> [--to <reviewer>] [--yes]",
    summary: "compose the Slack post, show it, send it as you on confirmation",
    run: (args, home, io) => run_post(args, home, io),
};

async function run_post(args: string[], home: SpinnerHome, io: CliIo): Promise<number> {
    const parsed = parseArgs({
        args,
        options: { to: { type: "string" }, yes: { type: "boolean" } },
        allowPositionals: true,
        strict: true,
    });
    const summary = session_arg("post", parsed.positionals[0], home, io);
    if (summary === null) {
        return 1;
    }
    const ctx = { home, cwd: process.cwd(), gh: gh_runner, env: io.env };
    const to = parsed.values.to;
    try {
        const preview = actions.post_preview(ctx, summary, to);
        io.out(`channel: ${preview.channel ?? "-"} · transport: ${preview.transport}`);
        io.out("---");
        io.out(preview.text);
        io.out("---");
        if (preview.blocked !== null) {
            io.err(`spinner post: ${preview.blocked}`);
            return 1;
        }
        if (parsed.values.yes !== true && !(await confirm(io))) {
            io.out("not posted");
            return 1;
        }
        const confirm_true = { confirm: true as const };
        const request = to === undefined ? confirm_true : { ...confirm_true, to };
        await actions.post(ctx, summary, request, io.out);
        return 0;
    } catch (error) {
        io.err(`spinner post: ${describe_error(error)}`);
        return 1;
    }
}

/** Asks `post it? [y/N]` on the terminal. A non-TTY answers no, so nothing posts by accident. */
async function confirm(io: CliIo): Promise<boolean> {
    if (!process.stdin.isTTY) {
        io.err("spinner post: stdin is not a terminal; pass --yes to post");
        return false;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await rl.question("post it? [y/N] ");
        return /^y(es)?$/i.test(answer.trim());
    } finally {
        rl.close();
    }
}
