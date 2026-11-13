// The Projects view, as the UI shows it: the list's rows, the stacks of the live sessions, what
// a session row offers, and why the daemon would refuse a delete. Pure functions;
// `ProjectsPane.tsx` and `ProjectPage.tsx` draw them.
import type {
    ProjectDetailResponse,
    ProjectView,
    SessionView,
    StackStateName,
} from "@spinner/protocol";

import { runningJob, type UiState } from "./state.ts";
import { formatBytes, stackUsageOf } from "./usage.ts";

/** The page id of a project not saved yet: `+ New project`. */
export const NEW_PROJECT = "";

export interface ProjectRow {
    name: string;
    source: ProjectView["source"];
    repos: number;
    services: number;
    /** Live sessions of the project whose stack is up. */
    up: number;
}

export function projectRows(
    projects: readonly ProjectView[],
    sessions: readonly SessionView[],
): ProjectRow[] {
    return projects.map((project) => ({
        name: project.name,
        source: project.source,
        repos: project.repos.length,
        services: project.services.length,
        up: sessions.filter(
            (view) => view.summary.session.project === project.name && view.stack.state === "up",
        ).length,
    }));
}

/** `2 repos · 3 services · 1 up`. */
export function projectRowMeta(row: ProjectRow): string {
    const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
    const parts = [plural(row.repos, "repo"), plural(row.services, "service")];
    if (row.up > 0) {
        parts.push(`${row.up} up`);
    }
    return parts.join(" · ");
}

/** What a session's row offers: `run local` while the stack is not up, else `stop local`. */
export interface SessionOffer {
    run: boolean;
    stop: boolean;
}

export function sessionOffer(state: StackStateName): SessionOffer {
    const running = state === "up" || state === "starting";
    return { run: !running, stop: running };
}

export interface StackRow {
    dir: string;
    title: string;
    project: string;
    state: StackStateName;
    /** `1.2 GB` while the stack is up and sampled, else null. */
    memory: string | null;
    /** A job of the session runs: its buttons wait. */
    busy: boolean;
}

/** Every live session with a project attached, newest first. */
export function stackRows(state: UiState): StackRow[] {
    const rows: { created: string; row: StackRow }[] = [];
    for (const [dir, view] of Object.entries(state.sessions)) {
        const session = view.summary.session;
        if (session.project === undefined) {
            continue;
        }
        const usage = stackUsageOf(view, state.usage);
        rows.push({
            created: session.created,
            row: {
                dir,
                title: session.title,
                project: session.project,
                state: view.stack.state,
                memory: usage === null ? null : formatBytes(usage.mem_bytes),
                busy: runningJob(state, dir) !== undefined,
            },
        });
    }
    return rows
        .sort((a, b) => b.created.localeCompare(a.created))
        .map((entry) => entry.row);
}

/** `Unlink` for a project that is a link, else `Delete`. */
export function deleteLabel(detail: ProjectDetailResponse): string {
    return detail.linked ? "Unlink" : "Delete";
}

/**
 * Why the daemon would refuse `DELETE /projects/:name`, or null. A home directory with
 * other files than the spec is refused too; the daemon's answer names that one.
 */
export function deleteBlocker(detail: ProjectDetailResponse): string | null {
    const { project, sessions } = detail;
    if (project.source === "examples") {
        return "A project of examples/ is part of the Spinner repository.";
    }
    if (project.source === "local") {
        return "This project is only under local/ of the checkout; remove it there.";
    }
    if (sessions.length > 0) {
        const ids = sessions.map((session) => session.id).join(", ");
        return `Used by ${ids}; close ${sessions.length === 1 ? "it" : "them"} first.`;
    }
    return null;
}

/**
 * The reason in a failed request's message: `PUT /x failed (400): {"error":"..."}` reads as
 * its `error`. Any other message stays as it is.
 */
export function daemonReason(message: string): string {
    const body = /failed \(\d+\): (.*)$/s.exec(message)?.[1];
    if (body === undefined) {
        return message;
    }
    try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
            return String(parsed.error);
        }
    } catch {
        // Not JSON: the body is the reason.
    }
    return body;
}
