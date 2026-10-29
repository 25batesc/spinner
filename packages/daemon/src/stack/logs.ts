// A service's last log lines for `GET /sessions/:dir/stack/logs/:service`. A host service
// has a log file under the session's `log/` (`stack.processes.<name>.log` names it while the
// stack is up; `log/<name>.log` is the same file after `down`); a container has
// `docker compose logs --tail`. `spinner logs` keeps its own attached `tail -f` and
// `compose logs --follow`; this route is the snapshot an agent or the UI reads.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServiceWhere, SessionSummary, StackLogsResponse } from "@spinner/protocol";
import { STACK_LOGS_LINES_MAX } from "@spinner/protocol";
import { session_spec_or_null } from "../views/session-view.js";
import { compose, type ComposeTarget } from "./docker.js";
import { compose_target } from "./runner.js";

export class StackLogsError extends Error {
    constructor(
        readonly status: 404 | 502,
        message: string,
    ) {
        super(message);
    }
}

export interface StackLogsDeps {
    /** `docker compose logs`; tests pass a fake. */
    compose?: (target: ComposeTarget, args: string[]) => Promise<string>;
}

/**
 * The last `lines` lines of the service's log. Throws `StackLogsError` 404 when the session
 * has no such service and no log file for it, 502 when docker fails.
 */
export async function service_log_lines(
    summary: SessionSummary,
    service: string,
    lines: number,
    deps: StackLogsDeps = {},
): Promise<StackLogsResponse> {
    assert.ok(Number.isInteger(lines) && lines >= 1 && lines <= STACK_LOGS_LINES_MAX);
    assert.ok(/^[a-z0-9][a-z0-9_-]*$/i.test(service), `service name ${service}`);
    const where = where_of(summary, service);
    if (where === null) {
        throw new StackLogsError(404, `${summary.dir} has no service "${service}"`);
    }
    if (where === "host") {
        const file = host_log_file(summary, service);
        if (file === null) {
            throw new StackLogsError(404, `${service} has no log file yet; is the stack up?`);
        }
        const text = readFileSync(file, "utf8");
        return { service, where, lines: last_lines(text, lines) };
    }
    const target = compose_target(summary);
    const run = deps.compose ?? compose;
    let text: string;
    try {
        text = await run(target, ["logs", "--tail", String(lines), "--no-log-prefix", service]);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new StackLogsError(502, `docker compose logs ${service}: ${reason}`);
    }
    return { service, where, lines: last_lines(text, lines) };
}

/** Where the service runs: from the spec; from a log file when the session has no spec copy. */
function where_of(summary: SessionSummary, service: string): ServiceWhere | null {
    const spec = session_spec_or_null(summary);
    const entry = spec?.services[service];
    if (entry !== undefined) {
        return entry.runtime === "host" ? "host" : "container";
    }
    return host_log_file(summary, service) === null ? null : "host";
}

function host_log_file(summary: SessionSummary, service: string): string | null {
    const recorded = summary.session.stack?.processes?.[service]?.log;
    const candidates = [recorded, join("log", `${service}.log`)];
    for (const relative of candidates) {
        if (relative === undefined) {
            continue;
        }
        const path = join(summary.path, relative);
        if (existsSync(path)) {
            return path;
        }
    }
    return null;
}

/** The last `count` lines, oldest first, without a trailing empty line. */
export function last_lines(text: string, count: number): string[] {
    const all = text.split("\n");
    if (all.length > 0 && all[all.length - 1] === "") {
        all.pop();
    }
    return all.slice(-count);
}
