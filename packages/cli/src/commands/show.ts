// `spinner show [<session>]`: list sessions as a table, or show one with its services. The
// facts come from the session files, the pid files and `docker inspect`; no HTTP probe.
import {
    find_session,
    group_alive,
    list_sessions,
    read_pid_files,
    read_session_spec,
    run,
    type SpinnerHome,
} from "@spinner/daemon";
import type { SessionSummary, StackSpec } from "@spinner/protocol";
import type { CliIo, Command } from "./command.js";
import {
    format_session_detail,
    format_session_table,
    palette_for,
    state_for_missing,
    type ServiceRow,
    type ServiceState,
    type ShowData,
} from "./show-format.js";

export const show_command: Command = {
    name: "show",
    usage: "[<session>]",
    summary: "list sessions, or show one with its services",
    run: run_show,
};

async function run_show(args: string[], home: SpinnerHome, io: CliIo): Promise<number> {
    const palette = palette_for(process.stdout.isTTY === true, io.env);
    const wanted = args[0];
    if (wanted !== undefined) {
        const match = find_session(home, wanted);
        if (match === null) {
            io.err(`spinner show: no session "${wanted}" under ${home.sessions}`);
            return 1;
        }
        io.out(format_session_detail(await collect_show_data(match), palette));
        return 0;
    }
    const result = list_sessions(home);
    if (result.sessions.length === 0) {
        io.out(`no sessions under ${home.sessions}`);
    } else {
        io.out(format_session_table(result.sessions, palette));
    }
    for (const failure of result.errors) {
        io.err(`skipped ${failure.dir}: ${failure.error}`);
    }
    return 0;
}

/** Gathers the rows for one session. A session without a stack gets no service rows. */
export async function collect_show_data(entry: SessionSummary): Promise<ShowData> {
    const session = entry.session;
    const worktrees: Record<string, string> = {};
    for (const [name, repo] of Object.entries(session.repos)) {
        if (repo.worktree !== undefined) {
            worktrees[name] = `${entry.path}/${repo.worktree}`;
        }
    }
    let spec: StackSpec | null = null;
    try {
        spec = read_session_spec(entry).spec;
    } catch {
        spec = null;
    }
    const services: ServiceRow[] = [];
    if (spec !== null) {
        const pids = read_pid_files(entry.path);
        const processes = session.stack.processes ?? {};
        for (const [name, service] of Object.entries(spec.services)) {
            const url = session.stack.hosts?.[name];
            const row: ServiceRow = { name, where: "container", state: "absent", url: url ?? "" };
            if (url !== undefined) {
                row.url = `http://${url}`;
            }
            if (service.runtime === "host") {
                const pgid = pids[name]?.pid ?? processes[name]?.pid;
                const port = processes[name]?.port;
                row.where = port === undefined ? "host" : `host :${port}`;
                row.state = host_state(pgid, session);
            } else {
                const container = `${session.stack.project ?? ""}-${name}-1`;
                row.state = await container_state(container, session);
            }
            services.push(row);
        }
    }
    return { entry, services, worktrees };
}

function host_state(pgid: number | undefined, session: SessionSummary["session"]): ServiceState {
    if (pgid === undefined) {
        return state_for_missing(session);
    }
    return group_alive(pgid) ? "up" : "exited";
}

/** `docker inspect` of one container: running and healthy, starting, up, exited, or gone. */
async function container_state(
    container: string,
    session: SessionSummary["session"],
): Promise<ServiceState> {
    const format = "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}";
    const result = await run("docker", ["inspect", "--format", format, container]);
    if (result.code !== 0) {
        return state_for_missing(session);
    }
    const [status, health] = String(result.stdout).trim().split("|");
    if (status === "running") {
        if (health === "healthy") {
            return "healthy";
        }
        if (health === "starting") {
            return "starting";
        }
        return "up";
    }
    if (status === "exited" || status === "dead") {
        return "exited";
    }
    return "stopped";
}

/** A session is named by its directory (`s17-refund-flow`) or by its id (`s17`). */
export function matches(entry: SessionSummary, wanted: string): boolean {
    return entry.dir === wanted || entry.session.id === wanted;
}
