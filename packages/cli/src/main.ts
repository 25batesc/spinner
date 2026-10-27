#!/usr/bin/env node
// Binary entry point: `spinner ...`. Keeps process wiring out of `cli.ts` so tests can call
// `run_cli` with a fake environment and capture its output.
import { run_cli } from "./cli.js";

const code = await run_cli(process.argv.slice(2), {
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
});
process.exitCode = code;
