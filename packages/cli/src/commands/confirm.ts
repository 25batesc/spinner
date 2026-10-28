// A y/N question on the terminal for the commands that send something as the operator
// (`post`, `approve`). A non-TTY answers no, so a script cannot post by accident; it passes
// `--yes` instead.
import { createInterface } from "node:readline/promises";
import type { CliIo } from "./command.js";

export async function confirm_on_terminal(io: CliIo, question: string): Promise<boolean> {
    if (!process.stdin.isTTY) {
        io.err("stdin is not a terminal; pass --yes to confirm");
        return false;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await rl.question(question);
        return /^y(es)?$/i.test(answer.trim());
    } finally {
        rl.close();
    }
}
