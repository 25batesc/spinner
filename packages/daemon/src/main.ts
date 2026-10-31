#!/usr/bin/env node
// Binary entry point: `spinnerd`. Reads `<home>/config.yaml` once (`config.ts`), then the
// environment on top: SPINNER_HOME, SPINNER_PI, SPINNER_PORT, SPINNER_DEFAULT_MODEL,
// SPINNER_SLACK_CHANNEL, SPINNER_UI_DIR, SPINNER_POLL_SECONDS, SPINNER_NOTIFY,
// SPINNER_OPERATOR (`off` keeps the operator agent from starting at boot) and
// SPINNER_GITHUB_FIXTURE. Writes `<home>/daemon.pid` once it listens, so `spinner daemon
// status|stop` find it, and refuses to start while another daemon holds that file. Stops on
// SIGINT or SIGTERM.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
    build_identity,
    describe_build,
    load_config,
    pid_alive,
    read_daemon_pid,
    remove_daemon_pid,
    write_daemon_pid,
    type LoadedConfig,
} from "./config.js";
import { resolve_home } from "./home.js";
import { github_fixture } from "./pipeline/github-fixture.js";
import { silent_notifier } from "./pipeline/notify.js";
import { start_daemon, type DaemonOptions } from "./server.js";

const home = resolve_home(process.env);
mkdirSync(home.root, { recursive: true });

let loaded: LoadedConfig;
try {
    loaded = load_config(home, process.env);
} catch (error) {
    console.error(`spinnerd: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
}
const config = loaded.config;

// The settings go into the process environment where the environment was unset, so every
// module that already reads `SPINNER_PI` or `SPINNER_SLACK_CHANNEL` sees the file's value
// without a second code path. The environment wins because `load_config` applied it last.
if (config.pi_bin !== undefined) {
    process.env["SPINNER_PI"] = config.pi_bin;
}
if (config.slack.channel !== undefined) {
    process.env["SPINNER_SLACK_CHANNEL"] = config.slack.channel;
}

const previous = read_daemon_pid(home);
if (previous !== null && previous !== process.pid && pid_alive(previous)) {
    console.error(`spinnerd: another spinnerd (pid ${previous}) runs on ${home.root}`);
    process.exit(3);
}

const build = build_identity();
const options: DaemonOptions = { home, build };
if (config.port !== undefined) {
    options.port = config.port;
}
if (config.default_model !== undefined) {
    options.default_model = config.default_model;
}
const poll_seconds = integer_env("SPINNER_POLL_SECONDS");
if (poll_seconds !== undefined) {
    options.poll_seconds = poll_seconds;
}
const ui_dir = process.env["SPINNER_UI_DIR"];
if (ui_dir !== undefined && ui_dir !== "") {
    options.ui_dir = resolve(ui_dir);
}
if (process.env["SPINNER_NOTIFY"] === "off") {
    options.notify = silent_notifier;
}
if (process.env["SPINNER_OPERATOR"] === "off") {
    options.operator = false;
}
const github_fixture_dir = process.env["SPINNER_GITHUB_FIXTURE"]; // engine: fake gh for UI/ext runs
if (github_fixture_dir !== undefined && github_fixture_dir !== "") {
    const fixture = github_fixture(resolve(github_fixture_dir));
    options.gh = fixture.gh;
    options.writer = fixture.writer;
}

console.error(`spinnerd: build ${describe_build(build)}`);
console.error(`spinnerd: config ${loaded.path}${loaded.found ? "" : " (absent, defaults)"}`);
const daemon = await start_daemon(options);
write_daemon_pid(home, process.pid);

const stop = (signal: string): void => {
    console.error(`spinnerd: ${signal}, shutting down`);
    daemon.close().then(
        () => {
            remove_daemon_pid(home, process.pid);
            process.exit(0);
        },
        (error) => {
            console.error("spinnerd: shutdown failed:", error);
            remove_daemon_pid(home, process.pid);
            process.exit(1);
        },
    );
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

function integer_env(name: string): number | undefined {
    const text = process.env[name];
    if (text === undefined || text === "") {
        return undefined;
    }
    const value = Number.parseInt(text, 10);
    if (Number.isNaN(value) || value < 0) {
        console.error(`spinnerd: ${name} "${text}" is not a non-negative integer`);
        process.exit(2);
    }
    return value;
}
