// `spinner approve <session> [--pr <repo>] [--yes]`: show head, diff stat and open-thread
// count per PR, then submit the operator's approving review on confirmation.
import { parseArgs } from "node:util";
import { actions, gh_runner, type SpinnerHome } from "@spinner/daemon";
import { describe_error, type CliIo, type Command } from "./command.js";
import { confirm_on_terminal } from "./confirm.js";
import { session_arg } from "./session-arg.js";

export const approve_command: Command = {
    name: "approve",
    usage: "<session> [--pr <repo>] [--yes]",
    summary: "show head, diff stat and open threads, then approve as you",
    run: (args, home, io) => run_approve(args, home, io),
};

async function run_approve(args: string[], home: SpinnerHome, io: CliIo): Promise<number> {
    const parsed = parseArgs({
        args,
        options: { pr: { type: "string" }, yes: { type: "boolean" } },
        allowPositionals: true,
        strict: true,
    });
    const summary = session_arg("approve", parsed.positionals[0], home, io);
    if (summary === null) {
        return 1;
    }
    const ctx = { home, cwd: process.cwd(), gh: gh_runner };
    const repo = parsed.values.pr;
    try {
        const view = await actions.approve_preview(ctx, summary);
        const shown = view.prs.filter((pr) => repo === undefined || pr.repo === repo);
        for (const pr of shown) {
            const stat = `${pr.diff.files} files +${pr.diff.additions} -${pr.diff.deletions}`;
            const state = pr.blocked === null ? "approvable" : `blocked: ${pr.blocked}`;
            const head = `${pr.repo}#${pr.number} @ ${pr.head.slice(0, 7)}`;
            io.out(`${head} · ${stat} · ${pr.open_threads} open threads · ${state}`);
        }
        if (shown.every((pr) => pr.blocked !== null)) {
            io.err("spinner approve: nothing to approve");
            return 1;
        }
        if (parsed.values.yes !== true && !(await confirm_on_terminal(io, "approve? [y/N] "))) {
            io.out("not approved");
            return 1;
        }
        const confirm_true = { confirm: true as const };
        const request = repo === undefined ? confirm_true : { ...confirm_true, pr: repo };
        await actions.approve(ctx, summary, request, io.out);
        return 0;
    } catch (error) {
        io.err(`spinner approve: ${describe_error(error)}`);
        return 1;
    }
}
