// The autopilot (docs/designs/talk-change-ship.md, 1.5): after a poll of a session's pull
// requests, what the lead must be told so the pull request stays ready. Two facts: the checks
// are red at a head the lead was not told about, and open review threads it was not told
// about. This file is pure: it takes the session and the thread views of one poll and
// returns the message and the next state. The poller sends the message and writes the state.
import assert from "node:assert/strict";
import {
    AUTOPILOT_RED_MAX,
    AUTOPILOT_THREADS_MAX,
    type AutopilotState,
    type PrThreadsView,
    type Session,
} from "@spinner/protocol";

export interface AutopilotStep {
    /** The text for the lead, or null when nothing is new. */
    message: string | null;
    /** The state after the lead is told. Equal to the input when nothing changed. */
    state: AutopilotState;
    /** One line per pull request whose red checks reached the cap, for the operator. */
    stopped: string[];
}

/** An empty state: a pull request opened by `pr` starts with it, so its first red is told. */
export function empty_autopilot(): AutopilotState {
    return { red: {}, threads: [] };
}

/**
 * What stands now, recorded as told. For a pull request the autopilot sees for the first
 * time without a state (adopted, or opened before the autopilot existed): the lead is not
 * sent the history, only what comes after.
 */
export function baseline_autopilot(
    session: Session,
    views: readonly PrThreadsView[],
): AutopilotState {
    const state = empty_autopilot();
    for (const [repo, entry] of Object.entries(session.repos)) {
        const pr = entry.pr;
        if (pr != null && pr.checks === "red") {
            state.red[repo] = { head: pr.head, rounds: 1 };
        }
    }
    for (const view of views) {
        for (const thread of view.threads) {
            if (thread.state === "open") {
                state.threads.push(thread.id);
            }
        }
    }
    state.threads = bounded(state.threads);
    return state;
}

/** Pure: the message for the lead and the state after it, from one poll's facts. */
export function autopilot_step(
    session: Session,
    views: readonly PrThreadsView[],
    previous: AutopilotState,
): AutopilotStep {
    const state: AutopilotState = structuredClone(previous);
    const parts: string[] = [];
    const stopped: string[] = [];
    for (const [repo, entry] of Object.entries(session.repos)) {
        const pr = entry.pr;
        if (pr == null || (pr.state !== "open" && pr.state !== "draft")) {
            continue;
        }
        const name = `${repo}#${pr.number}`;
        if (pr.checks === "green") {
            delete state.red[repo];
            continue;
        }
        const told = state.red[repo];
        if (pr.checks !== "red" || told?.head === pr.head) {
            continue;
        }
        const rounds = (told?.rounds ?? 0) + 1;
        state.red[repo] = { head: pr.head, rounds };
        if (rounds > AUTOPILOT_RED_MAX) {
            stopped.push(`${name}: checks red at ${AUTOPILOT_RED_MAX} heads in a row`);
            continue;
        }
        parts.push(red_text(name, pr.url, pr.head, pr.checks_failing ?? [], rounds));
    }
    const known = new Set(state.threads);
    for (const view of views) {
        const fresh = view.threads.filter(
            (thread) => thread.state === "open" && thread.flagged === null && !known.has(thread.id),
        );
        if (fresh.length === 0) {
            continue;
        }
        for (const thread of fresh) {
            state.threads.push(thread.id);
        }
        const labels = fresh.map((thread) => thread.label).join(", ");
        parts.push(threads_text(`${view.repo}#${view.number}`, fresh.length, labels, view.file));
    }
    state.threads = bounded(state.threads);
    assert.ok(state.threads.length <= AUTOPILOT_THREADS_MAX);
    if (parts.length === 0) {
        return { message: null, state, stopped };
    }
    return { message: [HEADER, ...parts, FOOTER].join("\n\n"), state, stopped };
}

const HEADER =
    "Spinner autopilot: your pull request needs you. Do not wait for the operator; handle " +
    "this now, then go back to what you were doing.";

const FOOTER =
    "When the checks are green and no thread is open, write the Log line `ready to merge`.";

function red_text(
    name: string,
    url: string,
    head: string,
    failing: string[],
    rounds: number,
): string {
    const which = failing.length === 0 ? "" : ` Failing: ${failing.slice(0, 10).join(", ")}.`;
    const last =
        rounds === AUTOPILOT_RED_MAX
            ? ` This is red head ${rounds} in a row: after it Spinner stops sending you this ` +
              "pull request's failed checks. If you cannot fix it, say why in the Log."
            : "";
    return (
        `Checks failed on ${name} at ${head.slice(0, 7)} (${url}).${which} Read the failing ` +
        "job's log (`gh run view --log-failed`, or the check's page), fix the cause in the " +
        "worktree and commit; Spinner pushes. If the failure is not from your change (a " +
        `flaky test, a broken base), say so in the Log and re-run the job once.${last}`
    );
}

function threads_text(name: string, count: number, labels: string, file: string): string {
    return (
        `${count} new review thread(s) on ${name}: ${labels}. They are in ${file} and in ` +
        "`thread_list`. For each one: make the fix and commit, answer with `thread_reply` in " +
        "one line (what changed, or why not), and `thread_resolve` it once the fix is " +
        "pushed. Use `thread_flag` only for a product call that is the operator's."
    );
}

function bounded(ids: string[]): string[] {
    return ids.length > AUTOPILOT_THREADS_MAX ? ids.slice(ids.length - AUTOPILOT_THREADS_MAX) : ids;
}
