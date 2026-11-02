// A shallow clone of one pinned commit, shared by the diff viewer fetch (`diff/fetch.ts`) and
// the EGM fetch (`egm/fetch.ts`). `git clone` cannot take a sha, so the clone is an init, a
// remote, a depth-1 fetch of the sha and a checkout of `FETCH_HEAD`. Every step runs inside
// what is left of the caller's deadline.
import { mkdirSync, rmSync } from "node:fs";
import { run as run_command, type RunOptions, type RunResult } from "../stack/shell.js";

export type Log = (line: string) => void;

/** The command runner, injectable so a test fetches nothing. */
export type Runner = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;

/** The default runner. */
export const run: Runner = run_command;

export interface CloneInput {
    /** The checkout directory. It is removed first, so a moved pin never leaves a mixed tree. */
    dir: string;
    /** `owner/name` on GitHub. */
    repo: string;
    sha: string;
    log: Log;
    runner: Runner;
    /** `Date.now()` value after which no step starts. */
    deadline: number;
    /** The whole bound, for the error message. */
    timeout_ms: number;
    /** The fetch's name in the error message, for example `diffview` or `EGM`. */
    what: string;
}

export async function clone_at_sha(input: CloneInput): Promise<void> {
    const { dir } = input;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const url = `https://github.com/${input.repo}.git`;
    input.log(`clone ${input.repo} at ${input.sha.slice(0, 12)} into ${dir}`);
    const steps: string[][] = [
        ["init", "--quiet"],
        ["remote", "add", "origin", url],
        ["fetch", "--quiet", "--depth", "1", "origin", input.sha],
        ["checkout", "--quiet", "FETCH_HEAD"],
    ];
    for (const args of steps) {
        await run_step({
            runner: input.runner,
            command: "git",
            args,
            cwd: dir,
            deadline: input.deadline,
            timeout_ms: input.timeout_ms,
            what: input.what,
        });
    }
}

export interface StepInput {
    runner: Runner;
    command: string;
    args: string[];
    cwd: string;
    deadline: number;
    timeout_ms: number;
    what: string;
}

/** Runs one command inside what is left of the bound; a non-zero exit is an error. */
export async function run_step(input: StepInput): Promise<void> {
    const left = input.deadline - Date.now();
    if (left <= 0) {
        const minutes = Math.ceil(input.timeout_ms / 60_000);
        throw new Error(`the ${input.what} fetch passed its ${minutes} minute bound`);
    }
    const { command, args, cwd } = input;
    const result = await input.runner(command, args, { cwd, timeout_ms: left });
    if (result.code !== 0) {
        const output = `${String(result.stdout)}\n${result.stderr}`.trim();
        throw new Error(`${command} ${args.join(" ")} exited ${result.code} in ${cwd}:\n${output}`);
    }
}
