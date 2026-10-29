// Runs `spinner daemon start` from the checkout: `node packages/cli/dist/main.js daemon start`.
// The CLI spawns the daemon with its own `process.execPath`, so the Node that runs the CLI
// is the Node that runs the daemon. `node` on PATH wins; when the app was launched from
// Finder with no PATH to speak of, Electron's own Node runs it (`ELECTRON_RUN_AS_NODE`),
// which is the same major version. The checkout is the package's grandparent in development
// and `dist/repo.json`, written by `scripts/package.ts`, in the packaged app.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_MAIN = join("packages", "cli", "dist", "main.js");
/** The CLI's own wait for `/health` is 20 s; this bounds a CLI that hangs for another reason. */
const START_COMMAND_TIMEOUT_MS = 40_000;

export interface StartCommand {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
}

/** The checkout this app runs from. `SPINNER_REPO` overrides, for a packaged app moved. */
export function repo_root(env: NodeJS.ProcessEnv = process.env): string {
    const override = env["SPINNER_REPO"];
    if (override !== undefined && override !== "") {
        return resolve(override);
    }
    const dist = dirname(fileURLToPath(import.meta.url));
    const baked = join(dist, "repo.json");
    if (existsSync(baked)) {
        const parsed = JSON.parse(readFileSync(baked, "utf8")) as { root?: unknown };
        assert.equal(typeof parsed.root, "string", "repo.json must hold { root }");
        return parsed.root as string;
    }
    return resolve(dist, "..", "..", "..");
}

export function find_node_on_path(env: NodeJS.ProcessEnv): string | null {
    const path = env["PATH"] ?? "";
    for (const dir of path.split(delimiter)) {
        if (dir === "") {
            continue;
        }
        const candidate = join(dir, "node");
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        } catch {
            continue;
        }
    }
    return null;
}

export function start_command(
    root: string,
    env: NodeJS.ProcessEnv,
    electron_exec_path: string,
): StartCommand {
    const main = join(root, CLI_MAIN);
    assert.ok(existsSync(main), `${main} is missing: run pnpm -r build first`);
    const node = find_node_on_path(env);
    if (node !== null) {
        return { command: node, args: [main, "daemon", "start"], env, cwd: root };
    }
    return {
        command: electron_exec_path,
        args: [main, "daemon", "start"],
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
        cwd: root,
    };
}

/** Resolves when the CLI exits 0; rejects with its last output otherwise. */
export function run_start_command(command: StartCommand, log: (line: string) => void) {
    return new Promise<void>((resolve_promise, reject) => {
        log(`${command.command} ${command.args.join(" ")} (cwd ${command.cwd})`);
        const child = spawn(command.command, command.args, {
            cwd: command.cwd,
            env: command.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const output: string[] = [];
        const collect = (chunk: Buffer) => {
            for (const line of chunk.toString("utf8").split("\n")) {
                if (line !== "") {
                    output.push(line);
                    log(line);
                }
            }
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        const timer = setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error(`spinner daemon start: no exit after ${START_COMMAND_TIMEOUT_MS} ms`));
        }, START_COMMAND_TIMEOUT_MS);
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("exit", (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve_promise();
            } else {
                const tail = output.slice(-5).join("\n");
                reject(new Error(`spinner daemon start exited ${code}:\n${tail}`));
            }
        });
    });
}
