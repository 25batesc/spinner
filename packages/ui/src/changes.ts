// The changes of a session, as the UI shows them (docs/designs/talk-change-ship.md, 2.9): the
// blocks of the PR view, their facts and actions, the PR chip of the context bar, the `+n` of
// the session card, and the rows of the PRs view. The daemon sends `SessionView.changes`; a
// daemon from before step 2 sends none, and the session then shows no PR view. Pure
// functions; the components draw them.
import type { ChangePr, ChangeStateName, ChangeView, SessionView } from "@spinner/protocol";

import { agoText } from "./state.ts";

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

/** The tones of the PR view and the chip, as the `.pill-*` classes colour them. */
export type Tone = "ok" | "warn" | "fail" | "done" | "plain";

/** One labelled fact of a pull request's block. */
export interface PrFact {
    label: string;
    text: string;
    tone: Tone;
    /** The tooltip: the full head SHA. */
    title?: string;
}

function isOpenPr(pr: ChangePr): boolean {
    return pr.state === "open" || pr.state === "draft";
}

function ciFact(pr: ChangePr): PrFact | null {
    if (pr.checks === undefined || !isOpenPr(pr)) {
        return null;
    }
    if (pr.checks === "green") {
        return { label: "CI", text: "green", tone: "ok" };
    }
    if (pr.checks === "pending") {
        return { label: "CI", text: "pending", tone: "warn" };
    }
    const failing = (pr.checks_failing ?? []).join(", ");
    const text = failing === "" ? "red" : `red: ${failing}`;
    return { label: "CI", text, tone: "fail" };
}

/** `needs peer + owner · sam approved`, green once every required role approved. */
function approvalFact(pr: ChangePr): PrFact | null {
    if (pr.approvals === undefined || !isOpenPr(pr)) {
        return null;
    }
    const { required, peer, owner } = pr.approvals;
    const who = [...peer, ...(owner ? ["owner"] : [])];
    const done = required.every((role) => (role === "owner" ? owner : peer.length > 0));
    const needs = required.length === 0 ? "none required" : `needs ${required.join(" + ")}`;
    const by = who.length === 0 ? "no approval yet" : `${who.join(", ")} approved`;
    const text = `${needs} · ${by}`;
    return { label: "approval", text, tone: done ? "ok" : "warn" };
}

const REVIEW_TEXT = { none: "none", changes_requested: "changes requested", approved: "approved" };
const REVIEW_TONE: Record<keyof typeof REVIEW_TEXT, Tone> = {
    none: "plain", changes_requested: "fail", approved: "ok",
};

/** `1 bot · 2 people open · 3 resolved · 1 flagged`. */
function threadsFact(pr: ChangePr): PrFact | null {
    if (pr.threads === undefined) {
        return null;
    }
    const { bots_open, humans_open, resolved, flagged = 0 } = pr.threads;
    const parts = [
        bots_open > 0 ? `${bots_open} bot` : "",
        humans_open > 0 ? `${humans_open} ${humans_open === 1 ? "person" : "people"}` : "",
    ].filter((part) => part !== "");
    const open = parts.length === 0 ? "none open" : `${parts.join(" · ")} open`;
    const rest = [
        resolved > 0 ? `${resolved} resolved` : "",
        flagged > 0 ? `${flagged} flagged` : "",
    ].filter((part) => part !== "");
    const text = [open, ...rest].join(" · ");
    const tone = flagged > 0 ? "fail" : parts.length > 0 && isOpenPr(pr) ? "warn" : "plain";
    return { label: "threads", text, tone };
}

function queueFact(pr: ChangePr): PrFact | null {
    if (pr.queue === undefined || pr.queue === "none" || !isOpenPr(pr)) {
        return null;
    }
    if (pr.queue === "popped") {
        const text = pr.queue_reason == null ? "popped" : `popped: ${pr.queue_reason}`;
        return { label: "merge queue", text, tone: "fail" };
    }
    return { label: "merge queue", text: pr.queue, tone: "warn" };
}

const PR_STATE_TONE: Record<ChangePr["state"], Tone> = {
    open: "plain", draft: "plain", merged: "done", closed: "plain",
};

/**
 * The facts of a pull request's block in the PR view, in reading order: its state, CI, the
 * approval, the review decision, the threads, the merge queue, the size, the head and the
 * last activity. A fact the daemon did not send (a round's bare record) is left out, and so
 * are the gates of a pull request that is no longer open.
 */
export function prFacts(pr: ChangePr, now: Date): PrFact[] {
    const facts: (PrFact | null)[] = [
        { label: "state", text: pr.state, tone: PR_STATE_TONE[pr.state] },
        ciFact(pr),
        approvalFact(pr),
        pr.approval_check === undefined || pr.approval_check === "pending" || !isOpenPr(pr)
            ? null
            : {
                  label: "approval check",
                  text: pr.approval_check,
                  tone: pr.approval_check === "pass" ? "ok" : "fail",
              },
        pr.review === undefined || !isOpenPr(pr)
            ? null
            : { label: "review", text: REVIEW_TEXT[pr.review], tone: REVIEW_TONE[pr.review] },
        threadsFact(pr),
        queueFact(pr),
        pr.diff === undefined
            ? null
            : {
                  label: "size",
                  text: `${diffText(pr)} in ${pr.diff.files} file${pr.diff.files === 1 ? "" : "s"}`,
                  tone: "plain",
              },
        pr.head === undefined
            ? null
            : { label: "head", text: pr.head.slice(0, 7), tone: "plain", title: pr.head },
        updatedFact(pr, now),
    ];
    return facts.filter((fact) => fact !== null);
}

function updatedFact(pr: ChangePr, now: Date): PrFact | null {
    const ago = agoText(pr.last_activity, now);
    return ago === null ? null : { label: "updated", text: ago, tone: "plain" };
}

/** The actions of a change's block, in the order they show. */
export type PrActionName = "test" | "create" | "review" | "fix" | "post" | "approve" | "merge";

/** An action that applies to the change; `reason` says why it is disabled right now. */
export interface PrAction {
    name: PrActionName;
    reason: string | null;
}

export const SWITCH_FIRST = "Switch to this change first.";
export const BUSY = "A job is running on this session.";

/**
 * The actions of a change's block in the PR view: those that can apply to it, each with the
 * reason it cannot run right now, or null. `create PR`, `review` and `fix` act on the current
 * change only, because their routes take no `?change=`. `merge` (land) is not an exclusive
 * job, so a running job does not hold it.
 */
export function prActions(change: ChangeView, hasStack: boolean, busy: boolean): PrAction[] {
    const open = change.prs.filter(isOpenPr);
    const job = busy ? BUSY : null;
    const current = change.current ? job : SWITCH_FIRST;
    const actions: PrAction[] = [];
    if (hasStack && !isFinished(change) && change.state !== "empty") {
        actions.push({ name: "test", reason: job });
    }
    if (change.state === "building") {
        actions.push({ name: "create", reason: current });
    }
    if (open.length === 0) {
        return actions;
    }
    const threads = open.some(
        (pr) => (pr.threads?.bots_open ?? 0) + (pr.threads?.humans_open ?? 0) > 0,
    );
    actions.push(
        { name: "review", reason: current },
        { name: "fix", reason: current ?? (threads ? null : "No open review thread to answer.") },
        { name: "post", reason: job },
        {
            name: "approve",
            reason: job ?? (change.approved === true ? "You approved this head already." : null),
        },
        {
            name: "merge",
            reason: change.state === "in merge queue" ? "It is in the merge queue." : null,
        },
    );
    return actions;
}

/** An open pull request's tone: red on a failed gate, amber while one waits. */
function openTone(pr: ChangePr): Tone {
    if (pr.checks === "red" || pr.review === "changes_requested" || pr.queue === "popped") {
        return "fail";
    }
    const threads = (pr.threads?.bots_open ?? 0) + (pr.threads?.humans_open ?? 0);
    if (pr.checks === "pending" || threads > 0) {
        return "warn";
    }
    return pr.state === "draft" ? "plain" : "ok";
}

/** A pull request's tone: its gates while open, `done` merged, `plain` closed. */
export function prTone(pr: ChangePr): Tone {
    if (pr.state === "merged") {
        return "done";
    }
    return pr.state === "closed" ? "plain" : openTone(pr);
}

const TONE_RANK: Record<Tone, number> = { fail: 4, warn: 3, ok: 2, plain: 1, done: 0 };

/** One row of the chip's popover: a pull request and the change it belongs to. */
export interface ChipRow {
    change: ChangeView;
    pr: ChangePr;
}

/** The chip in the context bar: `#412` for one pull request, the count for several. */
export interface PrChip {
    label: string;
    tone: Tone;
    title: string;
    /** In the order of the PR view: the open changes, the current one first, then finished. */
    rows: ChipRow[];
}

/** The PR chip of the session, or null when it has no pull request. */
export function prChip(view: SessionView): PrChip | null {
    const cards = changeCards(view);
    const rows = [...cards.open, ...cards.finished].flatMap((change) =>
        change.prs.map((pr) => ({ change, pr })),
    );
    const [first] = rows;
    if (first === undefined) {
        return null;
    }
    const open = rows.filter((row) => isOpenPr(row.pr));
    const tone = (open.length === 0 ? rows : open)
        .map((row) => prTone(row.pr))
        .reduce((worst, next) => (TONE_RANK[next] > TONE_RANK[worst] ? next : worst));
    if (rows.length === 1) {
        const name = `${first.pr.repo}#${first.pr.number}`;
        return { label: `#${first.pr.number}`, tone, title: `${name} · ${first.pr.state}`, rows };
    }
    const title = `${rows.length} pull requests, ${open.length} open`;
    return { label: String(rows.length), tone, title, rows };
}

/** `✓`, `…`, `✗`: a popover row's CI mark; empty for a pull request no longer open. */
export function ciMark(pr: ChangePr): string {
    if (pr.checks === undefined || !isOpenPr(pr)) {
        return "";
    }
    return pr.checks === "green" ? "✓" : pr.checks === "pending" ? "…" : "✗";
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
