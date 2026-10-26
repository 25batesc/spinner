#!/usr/bin/env node
// Binary entry point: `spinnerd`. Reads SPINNER_HOME and SPINNER_PORT from the environment,
// starts the daemon and stops it on SIGINT or SIGTERM.
import { resolve_home } from "./home.js";
import { start_daemon } from "./server.js";

const home = resolve_home(process.env);
const port_text = process.env["SPINNER_PORT"];
const port = port_text === undefined ? undefined : Number.parseInt(port_text, 10);
if (port !== undefined && Number.isNaN(port)) {
    console.error(`spinnerd: SPINNER_PORT "${port_text}" is not a number`);
    process.exit(2);
}

const daemon = await start_daemon(port === undefined ? { home } : { home, port });

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
