// The text of `spinner show`: one session in detail, or the list. Pure: the facts come in
// as data, so the snapshot tests need no Docker and no session on disk. Colors are muted
// ANSI codes, used only when the caller says the output is a terminal.
import assert from "node:assert/strict";
import { homedir } from "node:os";
import type { Session, SessionSummary } from "@spinner/protocol";

/** What a service is doing, from its pid file or `docker inspect`. */
export type ServiceState = "up" | "healthy" | "starting" | "exited" | "stopped" | "absent";

export interface ServiceRow {
    name: string;
    /** `host :20100` for a host service, `container` otherwise. */
    where: string;
    state: ServiceState;
    /** `http://<host>.<id>.localhost`, or empty for an internal service. */
    url: string;
}

export interface ShowData {
    entry: SessionSummary;
    /** One row per service of the spec, in spec order; empty when the session has no stack. */
    services: ServiceRow[];
    /** Repo name to absolute worktree path. */
    worktrees: Record<string, string>;
}

export interface Palette {
    dim: (text: string) => string;
    green: (text: string) => string;
    yellow: (text: string) => string;
    red: (text: string) => string;
}

const PLAIN: Palette = {
    dim: (text) => text,
    green: (text) => text,
    yellow: (text) => text,
    red: (text) => text,
};

const ANSI: Palette = {
    dim: (text) => `\u001b[2m${text}\u001b[22m`,
    green: (text) => `\u001b[32m${text}\u001b[39m`,
    yellow: (text) => `\u001b[33m${text}\u001b[39m`,
    red: (text) => `\u001b[31m${text}\u001b[39m`,
};

/** Colors only for a terminal that did not opt out (`NO_COLOR`, https://no-color.org). */
export function palette_for(is_tty: boolean, env: NodeJS.ProcessEnv): Palette {
    const no_color = env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "";
    return is_tty && !no_color ? ANSI : PLAIN;
}

/** The width the detail view is laid out for; the header's right part aligns to it. */
const WIDTH = 80;

export function format_session_detail(data: ShowData, palette: Palette): string {
    const { session } = data.entry;
    assert.ok(session.id.length > 0);
    const lines: string[] = [];
    const left = `${session.id} · ${session.title}`;
    const right =
        `${session.stage} · stack ${session.stack.state} · ` +
        `${session.branch} from ${session.base}`;
    lines.push(header_line(left, right, palette));
    if (session.needs_human !== null) {
        lines.push(`${palette.dim("needs you:")} ${palette.yellow(session.needs_human)}`);
    }
    if (session.design !== undefined) {
        // The EGM design block (docs/designs/egm-adoption.md, 2.28); absent on a legacy session.
        const { track, stage } = session.design;
        lines.push(`${palette.dim("design:")} ${track} · ${stage ?? "-"}`);
    }
    lines.push("");
    if (data.services.length > 0) {
        lines.push(...service_table(data.services, palette));
        lines.push("");
    }
    const database = session.stack.db ?? "-";
    lines.push(`${palette.dim("database:")}  ${database}`);
    const worktrees = Object.entries(data.worktrees).map(
        ([name, path]) => `${name} → ${tilde(path)}`,
    );
    const worktree_text = worktrees.length === 0 ? "-" : worktrees.join(" · ");
    lines.push(`${palette.dim("worktrees:")} ${worktree_text}`);
    lines.push(`${palette.dim("session:")}   ${data.entry.path}`);
    lines.push(`${palette.dim("logs:")}      spinner logs ${session.id} [<service>]`);
    return lines.join("\n");
}

function header_line(left: string, right: string, palette: Palette): string {
    const gap = Math.max(2, WIDTH - left.length - right.length);
    return `${left}${" ".repeat(gap)}${palette.dim(right)}`;
}

function service_table(rows: ServiceRow[], palette: Palette): string[] {
    const header = { name: "service", where: "where", state: "status", url: "url" };
    const name_width = Math.max(header.name.length, ...rows.map((row) => row.name.length));
    const where_width = Math.max(header.where.length, ...rows.map((row) => row.where.length));
    const state_width = Math.max(header.state.length, ...rows.map((row) => row.state.length));
    const line = (name: string, where: string, state: string, url: string): string =>
        `${name.padEnd(name_width)}  ${where.padEnd(where_width)}  ${state}  ${url}`.trimEnd();
    const out = [palette.dim(line(header.name, header.where, header.state, header.url))];
    for (const row of rows) {
        const pad = " ".repeat(state_width - row.state.length);
        const state = colored_state(row.state, palette) + pad;
        out.push(line(row.name, row.where, state, row.url));
    }
    return out;
}

function colored_state(state: ServiceState, palette: Palette): string {
    if (state === "up" || state === "healthy") {
        return palette.green(state);
    }
    if (state === "starting") {
        return palette.yellow(state);
    }
    if (state === "exited") {
        return palette.red(state);
    }
    return palette.dim(state);
}

/** The session list: an aligned table, sessions that need the operator first. */
export function format_session_table(entries: SessionSummary[], palette: Palette): string {
    const sorted = [...entries].sort((a, b) => {
        const a_needs = a.session.needs_human === null ? 1 : 0;
        const b_needs = b.session.needs_human === null ? 1 : 0;
        return a_needs - b_needs || a.dir.localeCompare(b.dir);
    });
    const rows = sorted.map((entry) => ({
        id: entry.session.id,
        title: entry.session.title,
        stage: entry.session.stage,
        stack: entry.session.stack.state,
        needs: entry.session.needs_human ?? "",
    }));
    const widths = {
        id: Math.max(2, ...rows.map((row) => row.id.length)),
        title: Math.max(5, ...rows.map((row) => row.title.length)),
        stage: Math.max(5, ...rows.map((row) => row.stage.length)),
        stack: Math.max(5, ...rows.map((row) => row.stack.length)),
    };
    const line = (id: string, title: string, stage: string, stack: string, needs: string): string =>
        [
            id.padEnd(widths.id),
            title.padEnd(widths.title),
            stage.padEnd(widths.stage),
            stack.padEnd(widths.stack),
            needs,
        ]
            .join("  ")
            .trimEnd();
    const out = [palette.dim(line("id", "title", "stage", "stack", "needs you"))];
    for (const row of rows) {
        const stack = row.stack === "up" ? palette.green(row.stack) : row.stack;
        const padded = stack + " ".repeat(widths.stack - row.stack.length);
        out.push(line(row.id, row.title, row.stage, padded, palette.yellow(row.needs)));
    }
    return out.join("\n");
}

/** `/Users/me/x` as `~/x`. */
export function tilde(path: string): string {
    const home = homedir();
    return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** The state of a session's stack as `show` labels it, for a service with no record. */
export function state_for_missing(session: Session): ServiceState {
    const live = session.stack.state === "up" || session.stack.state === "starting";
    return live ? "absent" : "stopped";
}
