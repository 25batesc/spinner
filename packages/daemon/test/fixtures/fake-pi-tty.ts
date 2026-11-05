#!/usr/bin/env node
// A stand-in for an interactive `pi` under the tty harness: it runs inside the daemon's pty,
// speaks the extension's half of the tty contract (MISSION.md s009, Contracts) over HTTP, and
// has no model behind it. At start it posts `hello`, prints a banner, then echoes every byte
// it reads back to the terminal (so a test can type and see the keystroke come back). It
// long-polls `commands`: a `prompt` prints `> <text>` and posts `agent_start`, `turn_end`,
// `agent_end` and `agent_settled`; a `steer` prints `steer: <text>`; an `abort` prints
// `aborted`; a `notify` prints `notice: <first line>`. A prompt of `exit` ends the process
// with code 0; SIGTERM ends it with 143 after printing `bye`. The argv and the Spinner
// environment go to FAKE_PI_ARGS_FILE when set.
import { writeFileSync } from "node:fs";

// The swarm's reviewers and a review's lead run headless (s016): the same binary under
// `--mode rpc` is the rpc fake, so one `pi` serves both harnesses in a test.
if (process.argv.includes("--mode") && process.argv[process.argv.indexOf("--mode") + 1] === "rpc") {
    await import("./fake-pi.ts");
} else {
    await run_tty();
}

async function run_tty(): Promise<void> {

const args_file = process.env["FAKE_PI_ARGS_FILE"];
if (args_file !== undefined && args_file !== "") {
    const spinner_env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.startsWith("SPINNER_") || key === "TERM"),
    );
    writeFileSync(
        args_file,
        JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: spinner_env }),
    );
}

const session_dir = process.env["SPINNER_SESSION_DIR"] ?? "";
const dir = session_dir.replace(/\/+$/, "").split("/").pop() ?? "";
const agent = process.env["SPINNER_AGENT"] ?? "";
const daemon_url = process.env["SPINNER_DAEMON_URL"] ?? "";
// The operator agent's routes are `/operator/*`; a session agent's are under its session.
const base =
    process.env["SPINNER_ROLE"] === "operator"
        ? `${daemon_url}/operator`
        : `${daemon_url}/sessions/${dir}/agents/${agent}`;

interface Command {
    id: string;
    type: "prompt" | "steer" | "abort" | "notify";
    text?: string;
}

const print = (text: string): void => {
    process.stdout.write(`${text}\r\n`);
};

async function post(path: string, body: unknown): Promise<void> {
    try {
        await fetch(`${base}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5_000),
        });
    } catch {
        // The daemon is away; the test decides what that means.
    }
}

let busy = false;

async function act(command: Command): Promise<string> {
    if (command.type === "abort") {
        print("aborted");
        return "aborted";
    }
    const text = command.text ?? "";
    if (command.type === "notify") {
        print(`notice: ${text.split("\n")[0] ?? ""}`);
        return busy ? "queued" : "started";
    }
    if (command.type === "steer") {
        print(`steer: ${text}`);
        return busy ? "queued" : "started";
    }
    if (text === "exit") {
        print("exiting");
        setTimeout(() => process.exit(0), 50);
        return "started";
    }
    busy = true;
    print(`> ${text}`);
    await post("/events", { events: [{ type: "agent_start" }] });
    print(`echo: ${text}`);
    await post("/events", {
        events: [
            {
                type: "turn_end",
                turnIndex: 0,
                message: { role: "assistant", content: [{ type: "text", text: `echo: ${text}` }] },
                toolResults: [],
            },
            { type: "agent_end", messages: [] },
            { type: "agent_settled", aborted: false },
        ],
    });
    busy = false;
    return "started";
}

async function poll_loop(): Promise<void> {
    let ack = "";
    // Runs until the process exits; each iteration is one command or one 30 s idle period.
    for (;;) {
        let response: Response;
        try {
            response = await fetch(`${base}/commands${ack}`, {
                signal: AbortSignal.timeout(35_000),
            });
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 200));
            continue;
        }
        ack = "";
        if (response.status !== 200) {
            if (response.status !== 204) {
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
            continue;
        }
        const body = (await response.json()) as { command: Command };
        const disposition = await act(body.command);
        ack = `?ack=${encodeURIComponent(body.command.id)}&disposition=${disposition}`;
    }
}

process.stdin.setRawMode?.(true);
process.stdin.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
});
// The size after each SIGWINCH, as pi's TUI would redraw on one (the attach nudge).
process.stdout.on("resize", () => {
    print(`resize ${process.stdout.columns}x${process.stdout.rows}`);
});
process.on("SIGTERM", () => {
    print("bye");
    setTimeout(() => process.exit(143), 20);
});

// With FAKE_PI_STARTUP_NOTICE set, behave like a pi with a config warning: print the notice
// and wait for one key before anything else. The harness must press it.
if (process.env["FAKE_PI_STARTUP_NOTICE"] === "1") {
    print("Warning: something in the config");
    process.stdout.write("Press any key to continue...");
    await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
    print("");
}
print("fake pi tty ready");
await post("/hello", {
    pid: process.pid,
    commands: [
        { name: "help", description: "Show help", source: "extension" },
        { name: "spinner-reload", source: "extension" },
    ],
});
void poll_loop();
}
