#!/usr/bin/env node
// Binary entry point: `spinnerd`. Reads SPINNER_HOME, SPINNER_PORT, SPINNER_UI_DIR,
// SPINNER_POLL_SECONDS and SPINNER_NOTIFY from the environment, starts the daemon and stops
// it on SIGINT or SIGTERM.
import { resolve } from "node:path";
import { resolve_home } from "./home.js";
import { silent_notifier } from "./pipeline/notify.js";
import { start_daemon, type DaemonOptions } from "./server.js";

const home = resolve_home(process.env);
const options: DaemonOptions = { home };
const port = integer_env("SPINNER_PORT");
if (port !== undefined) {
    options.port = port;
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

const daemon = await start_daemon(options);

const stop = (signal: string): void => {
    console.error(`spinnerd: ${signal}, shutting down`);
    daemon.close().then(
        () => process.exit(0),
        (error) => {
            console.error("spinnerd: shutdown failed:", error);
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
