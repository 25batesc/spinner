// Runs external commands (`docker`, `git`) and returns their output. Spinner shells out
// instead of linking a Docker SDK so that what it does is the same thing an operator would
// type, and so `spinner` can print the exact command when one fails.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";

export interface RunOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Data written to stdin, for commands that read a file from it. */
    input?: string | Buffer;
    /** `buffer` keeps stdout as bytes, for a binary dump. */
    encoding?: "utf8" | "buffer";
    /** Upper bound on wall-clock time. A command that runs longer is killed. */
    timeout_ms?: number;
}

export interface RunResult {
    code: number;
    /** A string, or a Buffer when `encoding: "buffer"` was asked for. */
    stdout: string | Buffer;
    stderr: string;
}

/** Default bound on one command. Image builds and pulls are the slow ones. */
const TIMEOUT_MS_DEFAULT = 10 * 60_000;

/** Largest output kept from one command. `docker compose logs` streams and does not use this. */
const OUTPUT_BYTES_MAX = 64 * 1024 * 1024;

/** Runs a command and resolves with its exit code and output. A non-zero exit still resolves. */
export function run(
    command: string,
    args: string[],
    options: RunOptions = {},
): Promise<RunResult> {
    assert.ok(command.length > 0, "command must not be empty");
    return new Promise((resolve) => {
        const child = execFile(
            command,
            args,
            {
                cwd: options.cwd,
                env: options.env ?? process.env,
                timeout: options.timeout_ms ?? TIMEOUT_MS_DEFAULT,
                maxBuffer: OUTPUT_BYTES_MAX,
                encoding: options.encoding ?? "utf8",
            },
            (error, stdout, stderr) => {
                const code = error === null ? 0 : exit_code(error.code);
                resolve({ code, stdout, stderr: String(stderr) });
            },
        );
        if (options.input !== undefined) {
            child.stdin?.end(options.input);
        }
    });
}

/** Runs a command and throws with its stderr when it exits non-zero. */
export async function run_ok(
    command: string,
    args: string[],
    options: RunOptions = {},
): Promise<string> {
    const result = await run(command, args, { ...options, encoding: "utf8" });
    const stdout = String(result.stdout);
    if (result.code !== 0) {
        const stderr = result.stderr.trim();
        const detail = stderr.length > 0 ? stderr : stdout.trim();
        throw new Error(`${command} ${args.join(" ")} failed (${result.code}): ${detail}`);
    }
    return stdout;
}

/** Runs a command with the terminal attached, for `logs -f` and `exec`. Resolves with the code. */
export function run_attached(
    command: string,
    args: string[],
    cwd?: string,
    env?: NodeJS.ProcessEnv,
): Promise<number> {
    return new Promise((resolve) => {
        const child = spawn(command, args, { cwd, env: env ?? process.env, stdio: "inherit" });
        child.on("exit", (code) => resolve(code ?? 1));
        child.on("error", () => resolve(1));
    });
}

function exit_code(code: unknown): number {
    // `execFile` sets `code` to the exit status for a normal failure and to a string such as
    // `ENOENT` when the binary is missing. Both are failures; 127 is the shell's "not found".
    return typeof code === "number" ? code : 127;
}
