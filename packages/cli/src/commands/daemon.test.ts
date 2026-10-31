// Goal: `spinner daemon start|status|stop` manage a real background spinnerd on a scratch
// home and a free port: start answers `/health` with the build, a second start is a no-op,
// a stale pid file does not block a start, and stop ends the process. Method: the built
// `packages/daemon/dist/main.js` (the build runs before the tests), a temporary SPINNER_HOME
// and a port the OS hands out, through the public `run_cli` entry.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run_cli, type CliIo } from "../cli.js";

const daemon_dir = join(import.meta.dirname, "..", "..", "..", "daemon");
const main_js = join(daemon_dir, "dist", "main.js");
/** The daemon reports its package version; the test reads the same file. */
const daemon_version = (
    JSON.parse(readFileSync(join(daemon_dir, "package.json"), "utf8")) as { version: string }
).version;

let root: string;
let out: string[];
let err: string[];
let io: CliIo;

/** A port the OS says is free now; the daemon binds it a moment later. */
function free_port(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") {
                reject(new Error("no address"));
                return;
            }
            server.close(() => resolve(address.port));
        });
    });
}

async function setup(): Promise<void> {
    root = mkdtempSync(join(tmpdir(), "spinner-daemon-"));
    out = [];
    err = [];
    const port = await free_port();
    io = {
        env: {
            SPINNER_HOME: root,
            SPINNER_PORT: String(port),
            SPINNER_POLL_SECONDS: "0",
            SPINNER_NOTIFY: "off",
            SPINNER_OPERATOR: "off",
            SPINNER_SESSION_IDS: "home",
            PATH: process.env["PATH"] ?? "",
        },
        out: (line) => out.push(line),
        err: (line) => err.push(line),
    };
}

afterEach(async () => {
    // A daemon left behind would hold its port and its pid across tests.
    await run_cli(["daemon", "stop"], io);
});

describe.skipIf(!existsSync(main_js))("spinner daemon", () => {
    it("starts once, reports its build, and stops", async () => {
        await setup();
        expect(await run_cli(["daemon", "status"], io)).toBe(1);
        expect(out[0]).toMatch(/not running/);

        expect(await run_cli(["daemon", "start"], io)).toBe(0);
        expect(out.at(-2)).toMatch(/started \(pid \d+\) at http:\/\/127\.0\.0\.1:\d+/);
        expect(out.at(-1)).toMatch(new RegExp(`build ${daemon_version.replace(/\./g, "\\.")} \\(`));
        const pid = Number.parseInt(readFileSync(join(root, "daemon.pid"), "utf8"), 10);
        expect(pid).toBeGreaterThan(0);

        expect(await run_cli(["daemon", "start"], io)).toBe(0);
        expect(out.at(-1)).toBe(`spinner daemon: already running (pid ${pid}) at ${url()}`);

        expect(await run_cli(["daemon", "status"], io)).toBe(0);
        expect(out.at(-3)).toBe(`spinner daemon: running (pid ${pid}) at ${url()}`);
        expect(out.at(-2)).toMatch(/, ui (none|\w+)$/);
        expect(out.at(-1)).toMatch(new RegExp(`home ${root}$`));

        expect(await run_cli(["daemon", "logs", "--no-follow"], io)).toBe(0);
        expect(out.at(-1)).toMatch(/spinnerd listening on/);

        expect(await run_cli(["daemon", "stop"], io)).toBe(0);
        expect(out.at(-1)).toBe(`spinner daemon: stopped (pid ${pid})`);
        expect(existsSync(join(root, "daemon.pid"))).toBe(false);
        expect(await run_cli(["daemon", "status"], io)).toBe(1);
        expect(err).toEqual([]);
    });

    it("removes a stale pid file and starts", async () => {
        await setup();
        // The largest pid macOS and Linux hand out is below this; the process cannot exist.
        writeFileSync(join(root, "daemon.pid"), "4194304\n");
        expect(await run_cli(["daemon", "status"], io)).toBe(1);
        expect(out.at(-1)).toMatch(/stale pid file for 4194304 removed/);
        expect(await run_cli(["daemon", "start"], io)).toBe(0);
        expect(out.at(-2)).toMatch(/started \(pid \d+\)/);
    });

    it("rejects a config.yaml with a secret in it before starting anything", async () => {
        await setup();
        writeFileSync(join(root, "config.yaml"), "slack:\n  token: xoxp-not-here\n");
        expect(await run_cli(["daemon", "start"], io)).toBe(1);
        expect(err[0]).toMatch(/"slack.token" looks like a secret/);
        expect(existsSync(join(root, "daemon.pid"))).toBe(false);
    });
});

function url(): string {
    return `http://127.0.0.1:${io.env["SPINNER_PORT"] ?? ""}`;
}
