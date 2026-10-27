// Goal: a `runtime: host` service outlives the command that started it, and that command is
// never held open by it: `start_host_service` returns at once with a live pid, the log file
// receives the output, and `stop_host_process` ends it. Method: a fake service that is a
// shell loop writing to stdout, in a temporary session directory.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    diagnose_host_exit,
    host_command_line,
    log_shows_traceback,
    process_alive,
    run_preflight,
    start_host_service,
    stop_host_process,
    write_proxy_routes,
} from "./host-service.js";

describe("host services", () => {
    it("starts detached, logs, and stops", async () => {
        const session_dir = mkdtempSync(join(tmpdir(), "spinner-host-"));
        const started_at = Date.now();
        const record = start_host_service({
            name: "fake",
            service: {
                runtime: "host",
                repo: "app",
                command: 'echo "fake on $PORT"; while true; do sleep 1; done',
            },
            worktree: session_dir,
            session_dir,
            port: 23456,
            env: { EXTRA: "1" },
        });
        // Returning took no time: the loop runs on, in its own process group.
        expect(Date.now() - started_at).toBeLessThan(1_000);
        expect(record.port).toBe(23456);
        expect(record.log).toBe("log/fake.log");
        expect(process_alive(record.pid)).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(readFileSync(join(session_dir, record.log), "utf8")).toContain("fake on 23456");

        expect(await stop_host_process(record.pid)).toBe("stopped");
        expect(process_alive(record.pid)).toBe(false);
        expect(await stop_host_process(record.pid)).toBe("absent");
    });

    it("writes a Traefik file-provider route to host.docker.internal", () => {
        const home = mkdtempSync(join(tmpdir(), "spinner-proxy-"));
        const path = write_proxy_routes(home, "s17", [{ name: "api", host: "api", port: 21700 }]);
        expect(existsSync(path)).toBe(true);
        const text = readFileSync(path, "utf8");
        expect(text).toContain("Host(`api.s17.localhost`)");
        expect(text).toContain("http://host.docker.internal:21700");
    });
});

describe("Spinner's env inside the wrapper", () => {
    it("wins over a value the wrapper sets", async () => {
        const session_dir = mkdtempSync(join(tmpdir(), "spinner-host-"));
        // A fake injector: sets DATABASE_URL and PORT the way Doppler would, then runs the rest.
        const wrapper = join(session_dir, "inject.sh");
        writeFileSync(wrapper, '#!/bin/sh\nDATABASE_URL=from-injector PORT=1 exec "$@"\n');
        chmodSync(wrapper, 0o755);
        const record = start_host_service({
            name: "fake",
            service: {
                runtime: "host",
                repo: "app",
                wrapper: "./inject.sh",
                command: 'echo "db=$DATABASE_URL port=$PORT quote=$QUOTED"',
            },
            worktree: session_dir,
            session_dir,
            port: 23457,
            env: { DATABASE_URL: "postgres://x/spinner_s17", QUOTED: "it's a b" },
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        const log = readFileSync(join(session_dir, record.log), "utf8");
        expect(log).toContain("db=postgres://x/spinner_s17 port=23457 quote=it's a b");
        await stop_host_process(record.pid);
    });

    it("renders env after the wrapper and quotes values", () => {
        const command = { command: "python main.py" };
        const line = host_command_line("/w/run.sh knit3 ", { A: "x y" }, 5, command);
        expect(line).toBe("/w/run.sh knit3 env A='x y' PORT='5' sh -c 'python main.py'");
    });
});

describe("preflight", () => {
    it("passes with the service's env and fails with the output tail", async () => {
        const session_dir = mkdtempSync(join(tmpdir(), "spinner-host-"));
        const base = {
            name: "fake",
            worktree: session_dir,
            session_dir,
            port: 23458,
            env: { DATABASE_URL: "postgres://x/spinner_s17" },
        };
        const ok = await run_preflight({
            ...base,
            service: {
                runtime: "host",
                repo: "app",
                command: "x",
                preflight: 'test "$PORT" = 23458',
            },
        });
        expect(ok).toEqual({ ok: true, tail: "" });
        const failing = await run_preflight({
            ...base,
            service: {
                runtime: "host",
                repo: "app",
                command: "x",
                preflight:
                    'for i in $(seq 1 30); do echo "line $i"; done; ' +
                    'echo "ImportError: nope" >&2; exit 3',
            },
        });
        expect(failing.ok).toBe(false);
        const lines = failing.tail.split("\n");
        expect(lines).toHaveLength(20);
        expect(lines[0]).toBe("line 12");
        expect(lines[19]).toBe("ImportError: nope");
    });
});

describe("diagnose_host_exit", () => {
    it("names the first unresolvable hostname and the dotenv variable that holds it", async () => {
        const log = [
            "connecting to postgresql://u:p@127.0.0.1:54322/spinner_s17",
            'INFO pool host="db.internal.knit.invalid" attempt 1',
            "socket.gaierror: [Errno 8] nodename nor servname provided, or not known",
        ].join("\n");
        const dotenv = "AGENTS_DATABASE_URL=postgresql://u:p@db.internal.knit.invalid:5432/x\n";
        const diagnosis = await diagnose_host_exit(log, dotenv);
        expect(diagnosis.unresolved).toBe("db.internal.knit.invalid");
        expect(diagnosis.variable).toBe("AGENTS_DATABASE_URL");
        expect(diagnosis.tail.split("\n")).toHaveLength(3);
    });

    it("reports nothing unresolved for an ordinary crash", async () => {
        const diagnosis = await diagnose_host_exit("ImportError: nope\n", "");
        expect(diagnosis).toEqual({ tail: "ImportError: nope", unresolved: null, variable: null });
    });
});

describe("log_shows_traceback", () => {
    it("is true for a traceback that ends in an error line, false otherwise", () => {
        const crash = [
            "INFO starting",
            "Traceback (most recent call last):",
            '  File "api.py", line 83, in <module>',
            "    from gateway import create_gateway_app",
            "ImportError: cannot import name 'ModelNotMappedError' from 'litellm.exceptions'",
            "INFO reloader waiting",
        ].join("\n");
        expect(log_shows_traceback(crash)).toBe(true);
        expect(log_shows_traceback("INFO started\nWARNING retrying (gaierror)\n")).toBe(false);
        const json = '{"level": "ERROR", "exc_info": "Traceback (most recent call last):\\n' +
            '  File \\"x\\"\\nRuntimeError: generator didn\'t yield\\n"}';
        expect(log_shows_traceback(json)).toBe(true);
        const uvicorn = '{"message": "Application startup failed. Exiting."}';
        expect(log_shows_traceback(uvicorn)).toBe(true);
        expect(log_shows_traceback("Traceback (most recent call last):\n  File x\n")).toBe(false);
    });
});
