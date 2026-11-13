// The changes of a session, as the UI shows them (docs/designs/talk-change-ship.md, 2.9): the
// cards of the Changes rail, the `+n` of the session card, and the rows of the PRs view. The
// daemon sends `SessionView.changes`; a daemon from before step 2 sends none, and the session
// then shows no rail. Pure functions; the components draw them.
import type { ChangePr, ChangeStateName, ChangeView, SessionView } from "@spinner/protocol";

/** A change whose work is over: every pull request merged or closed. */
export function isFinished(change: ChangeView): boolean {
    return change.state === "merged" || change.state === "closed";
}

export interface ChangeCards {
    /** The changes in progress, the current one first, then the newest first. */
    open: ChangeView[];
    /** The merged and closed ones, newest first. */
    finished: ChangeView[];
}

/**
 * The cards of the rail. An `empty` change is shown only when it is the current one: a
 * record with no commit and no pull request says nothing.
 */
export function changeCards(view: SessionView): ChangeCards {
    const changes = [...(view.changes ?? [])].reverse();
    const open = changes.filter(
        (change) => !isFinished(change) && (change.current || change.state !== "empty"),
    );
    open.sort((a, b) => Number(b.current) - Number(a.current));
    return { open, finished: changes.filter(isFinished) };
}

/** The changes in progress that are not the current one: the `+n` of the session card. */
export function otherOpenChanges(view: SessionView): number {
    return changeCards(view).open.filter((change) => !change.current).length;
}

/**
 * What a change that is not checked out needs from the operator, with its title, or null.
 * The current change's line is `SessionView.board`'s; this one stands in when it has none.
 */
export function otherChangeNeeds(view: SessionView): string | null {
    for (const change of view.changes ?? []) {
        if (!change.current && !isFinished(change) && change.needs_human !== null) {
            return `${change.needs_human} · ${change.title}`;
        }
    }
    return null;
}

/** `✓ checks`, `✗ checks (lint, test)`, `… checks`; empty for a round's bare record. */
export function checksText(pr: ChangePr): string {
    if (pr.checks === undefined || pr.state === "merged" || pr.state === "closed") {
        return "";
    }
    if (pr.checks === "green") {
        return "✓ checks";
    }
    if (pr.checks === "pending") {
        return "… checks";
    }
    const failing = (pr.checks_failing ?? []).slice(0, 3).join(", ");
    return failing.length === 0 ? "✗ checks" : `✗ checks (${failing})`;
}

/** `2 threads`, `1 thread`; empty when none is open. */
export function threadsText(pr: ChangePr): string {
    const open = (pr.threads?.bots_open ?? 0) + (pr.threads?.humans_open ?? 0);
    if (open === 0 || pr.state === "merged" || pr.state === "closed") {
        return "";
    }
    return open === 1 ? "1 thread" : `${open} threads`;
}

/** `+84 −31`; empty when the daemon sent no size. */
export function diffText(pr: ChangePr): string {
    return pr.diff === undefined ? "" : `+${pr.diff.additions} −${pr.diff.deletions}`;
}

/** The tone of a state, for the card's dot and the row's pill. */
export function stateTone(state: ChangeStateName): "ok" | "warn" | "bad" | "idle" | "done" {
    switch (state) {
        case "ready to merge":
            return "ok";
        case "fixing CI":
            return "bad";
        case "answering review":
        case "in merge queue":
            return "warn";
        case "merged":
        case "closed":
            return "done";
        default:
            return "idle";
    }
}

/** The actions a card offers. `merge` and `post` need an open pull request. */
export interface ChangeActions {
    /** `create PR`: the current change has commits and no pull request. */
    create: boolean;
    /** `merge`: a pull request is open. The daemon refuses when a gate does not pass. */
    merge: boolean;
    post: boolean;
    /** `test locally`: run the stack on this change (3.1). Offered while it is in progress. */
    test: boolean;
}

export function changeActions(change: ChangeView, hasStack: boolean): ChangeActions {
    const open = change.prs.some((pr) => pr.state === "open");
    return {
        create: change.current && change.state === "building",
        merge: open && change.state !== "in merge queue",
        post: open,
        test: hasStack && !isFinished(change) && change.state !== "empty",
    };
}

/** True when the session has a stack to run: a project with a spec was attached. */
export function hasStack(view: SessionView): boolean {
    return view.stack.project !== null;
}

/** One pull request Spinner opened, with the session and the change it belongs to. */
export interface PrRow {
    dir: string;
    session: string;
    change: ChangeView;
    pr: ChangePr;
}

/** Past this many finished rows the PRs view stops; the open ones are never cut. */
export const PR_ROWS_FINISHED_MAX = 40;

/**
 * Every pull request of the ordinary sessions: the open ones first (those that need the
 * operator at the top), then the finished ones, each group newest session first.
 */
export function prRows(sessions: readonly [string, SessionView][]): {
    open: PrRow[];
    finished: PrRow[];
} {
    const open: PrRow[] = [];
    const finished: PrRow[] = [];
    for (const [dir, view] of sessions) {
        if (view.kind === "review") {
            continue;
        }
        for (const change of [...(view.changes ?? [])].reverse()) {
            for (const pr of change.prs) {
                const row = { dir, session: view.summary.session.title, change, pr };
                const done = pr.state === "merged" || pr.state === "closed";
                (done ? finished : open).push(row);
            }
        }
    }
    const waits = (row: PrRow) => Number(row.change.needs_human !== null);
    open.sort((a, b) => waits(b) - waits(a));
    return { open, finished: finished.slice(0, PR_ROWS_FINISHED_MAX) };
}

/** True when the right pane opens on the rail: nothing to preview, and a change to show. */
export function opensOnChanges(view: SessionView): boolean {
    if (view.kind === "review" || view.stack.state === "up" || view.stack.state === "starting") {
        return false;
    }
    return (view.changes ?? []).some((change) => change.prs.length > 0);
}
