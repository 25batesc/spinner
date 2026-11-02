#!/usr/bin/env node
/* global process, setTimeout */
// A stand-in for `diffview` that tests run instead of the real viewer: it serves one HTTP
// port, registers itself the way the viewer does (`<DIFFVIEW_HOME>/servers/<pid>.json`), and
// answers the `comments` verbs from a JSON file of threads the test writes
// (`FAKE_DIFFVIEW_THREADS`). The shapes follow `lib/comments-cli.mjs` at the pinned commit:
// `list --json` and `wait --json` print an array of
// `{ entry, threads: [{ id, status, waitingOn, path, startLine, endLine, messages }] }`.
// `reply` and `suggest-resolve` append a message, turn the thread to the human, and append
// one line to `FAKE_DIFFVIEW_ACTIONS` with the cwd and `DIFFVIEW_AUTHOR` they ran with.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
const home = process.env.DIFFVIEW_HOME ?? "";
const threads_file = process.env.FAKE_DIFFVIEW_THREADS ?? "";
const actions_file = process.env.FAKE_DIFFVIEW_ACTIONS ?? "";
const author = process.env.DIFFVIEW_AUTHOR ?? "agent";

function read_threads() {
    if (threads_file === "" || !fs.existsSync(threads_file)) {
        return [];
    }
    return JSON.parse(fs.readFileSync(threads_file, "utf8"));
}

function write_threads(threads) {
    fs.writeFileSync(threads_file, JSON.stringify(threads));
}

function record_action(action) {
    if (actions_file === "") {
        return;
    }
    const line = { ...action, cwd: process.cwd(), author, session: process.env.DIFFVIEW_SESSION };
    fs.appendFileSync(actions_file, `${JSON.stringify(line)}\n`);
}

function listing(threads) {
    return [{ repo: "fake", entry: "fake-branch", version: null, source: "git", threads }];
}

function newest(threads) {
    return Math.max(0, ...threads.flatMap((t) => t.messages.map((m) => m.id)));
}

function flag(rest, name) {
    const index = rest.indexOf(name);
    return index === -1 ? undefined : rest[index + 1];
}

function headline(t) {
    return `#${t.id} ${t.status} · waiting on ${t.waitingOn} · ${t.path} line ${t.startLine}`;
}

function run_comments(verb, rest) {
    const json = rest.includes("--json");
    if (verb === "list") {
        const threads = read_threads().filter((t) => t.status !== "resolved");
        const text = threads.map(headline).join("\n");
        const out = json ? `${JSON.stringify(listing(threads))}\n` : `${text}\n`;
        process.stdout.write(out);
        return 0;
    }
    if (verb === "show") {
        const ids = rest.filter((a) => /^\d+$/.test(a)).map(Number);
        const threads = read_threads().filter((t) => ids.includes(t.id));
        const text = threads
            .map((t) => {
                const body = t.messages.map((m) => `${m.author}: ${m.body}`).join("\n");
                return `#${t.id} ${t.status}\n${body}`;
            })
            .join("\n---\n");
        process.stdout.write(`${text}\n`);
        return threads.length === ids.length ? 0 : 1;
    }
    if (verb === "reply" || verb === "suggest-resolve") {
        const id = Number(rest[0]);
        const message = flag(rest, "-m");
        const threads = read_threads();
        const thread = threads.find((t) => t.id === id);
        if (thread === undefined) {
            process.stderr.write(`diffview comments ${verb}: no thread #${id}\n`);
            return 1;
        }
        thread.messages.push({ id: newest(threads) + 1, author, body: message });
        thread.waitingOn = "human";
        if (verb === "suggest-resolve") {
            thread.status = "suggested";
        }
        write_threads(threads);
        record_action({ verb, id, message });
        const said = verb === "reply" ? "Replied to" : "Suggested resolving";
        process.stdout.write(`${said} #${id}.\n`);
        return 0;
    }
    if (verb === "wait") {
        run_wait(Number(flag(rest, "--after") ?? 0));
        return null;
    }
    process.stderr.write(`diffview comments: unknown verb ${verb}\n`);
    return 2;
}

/** Polls the thread file until a thread waits on the agent with a message newer than `after`. */
function run_wait(after) {
    const timeout_ms = Number(process.env.FAKE_DIFFVIEW_WAIT_TIMEOUT_MS ?? 30_000);
    const started = Date.now();
    const poll = () => {
        const all = read_threads();
        const waiting = all.filter(
            (t) =>
                t.status !== "resolved" &&
                t.waitingOn === "agent" &&
                t.messages.some((m) => m.id > after),
        );
        if (waiting.length > 0) {
            process.stderr.write(`Next: diffview comments wait --after ${newest(all)}\n`);
            process.stdout.write(`${JSON.stringify(listing(waiting))}\n`);
            process.exit(0);
        }
        if (Date.now() - started > timeout_ms) {
            process.stdout.write(`${JSON.stringify({ timedOut: true })}\n`);
            process.exit(3);
        }
        setTimeout(poll, 50);
    };
    poll();
}

function serve(root, want) {
    const server = http.createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<html><body>fake diffview ${root}</body></html>`);
    });
    const listen = (port) => {
        server.once("error", (error) => {
            if (error.code === "EADDRINUSE") {
                listen(port + 1);
            } else {
                throw error;
            }
        });
        server.listen(port, "127.0.0.1", () => {
            const dir = path.join(home, "servers");
            fs.mkdirSync(dir, { recursive: true });
            const started_at = new Date().toISOString();
            const entry = { pid: process.pid, port, root, source: null, startedAt: started_at };
            fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify(entry));
            process.stdout.write(`diffview serving ${root}\n  http://127.0.0.1:${port}/\n`);
        });
    };
    listen(want);
    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.on(signal, () => process.exit(0));
    }
}

if (args[0] === "comments") {
    const code = run_comments(args[1], args.slice(2));
    if (code !== null) {
        process.exit(code);
    }
} else if (args[0] === "--help") {
    process.stdout.write("Usage: diffview [repo-dir] [options]\n");
    process.exit(0);
} else if (process.env.FAKE_DIFFVIEW_EXIT !== undefined) {
    process.stderr.write(`diffview: ${process.env.FAKE_DIFFVIEW_EXIT}\n`);
    process.exit(1);
} else {
    serve(path.resolve(args[0] ?? "."), Number(args[args.indexOf("--port") + 1]));
}
