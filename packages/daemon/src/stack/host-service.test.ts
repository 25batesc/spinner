// Goal: a `runtime: host` service outlives the command that started it, and that command is
// never held open by it: `start_host_service` returns at once with a live pid, the log file
// receives the output, and `stop_host_process` ends it. Method: a fake service that is a
// shell loop writing to stdout, in a temporary session directory.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    process_alive,
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
