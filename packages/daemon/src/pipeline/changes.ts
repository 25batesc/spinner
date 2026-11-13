// The changes of a session (docs/designs/talk-change-ship.md, step 2). A change is a branch
// and its pull request in each repo it touches. The session's top-level change fields
// (`branch`, `repos[*].changed`, `repos[*].pr`, `pipeline`, `stage`, `needs_human`) describe
// the current change, the one checked out in the worktrees; `session.changes` holds every
// other one. This file is pure: it names the current change, focuses a session on any
// change, stores a focused session back, and swaps changes for `start` and `switch`. The
// store applies the focus on a write; `change-jobs.ts` does the git work.
import assert from "node:assert/strict";
import {
    CHANGES_MAX,
    type ChangeHead,
    type ChangeRecord,
    type ChangeRepo,
    type ChangeStateName,
    type ChangeView,
    type Pipeline,
    type PrFacts,
    type RoundView,
    type Session,
    type Stage,
} from "@spinner/protocol";

/** The id a session's one change has in a file written before step 2. */
export const FIRST_CHANGE_ID = "c1";

/** The current change's name; a file without `change` reads as the first change. */
export function current_change(session: Session): ChangeHead {
    return (
        session.change ?? {
            id: FIRST_CHANGE_ID,
            title: session.title,
            started: session.created,
        }
    );
}

/** `c<n>` with n one more than the highest number among the session's changes. */
export function next_change_id(session: Session): string {
    let highest = 0;
    for (const id of [current_change(session).id, ...records_of(session).map((r) => r.id)]) {
        const match = /^c(\d+)$/.exec(id);
        if (match?.[1] !== undefined) {
            highest = Math.max(highest, Number.parseInt(match[1], 10));
        }
    }
    return `c${highest + 1}`;
}

function records_of(session: Session): ChangeRecord[] {
    return session.changes ?? [];
}

function empty_pipeline(): Pipeline {
    return { verified_locally: false, verified_heads: {}, slack_post: null };
}

/** The pull requests of a record, with the repo key each belongs to. */
export function record_prs(record: ChangeRecord): PrFacts[] {
    const prs: PrFacts[] = [];
    for (const [repo, entry] of Object.entries(record.repos)) {
        if (entry.pr !== undefined && entry.pr !== null) {
            prs.push({ repo, ...entry.pr });
        }
    }
    return prs;
}

/**
 * When every pull request of the change is merged or closed: the latest `last_activity`
 * among them. Undefined while one is open, and for a change with no pull request.
 */
function ended_of(repos: Record<string, ChangeRepo>): string | undefined {
    let ended: string | undefined;
    for (const entry of Object.values(repos)) {
        const pr = entry.pr;
        if (pr === undefined || pr === null) {
            continue;
        }
        if (pr.state === "open" || pr.state === "draft") {
            return undefined;
        }
        if (ended === undefined || pr.last_activity > ended) {
            ended = pr.last_activity;
        }
    }
    return ended;
}

/** The session's current change as a record: what `start` and `switch` put aside. */
export function record_of_current(session: Session): ChangeRecord {
    const repos: Record<string, ChangeRepo> = {};
    for (const [repo, entry] of Object.entries(session.repos)) {
        repos[repo] = { changed: entry.changed, pr: entry.pr ?? null };
    }
    const ended = ended_of(repos);
    return {
        ...current_change(session),
        branch: session.branch,
        repos,
        ...(session.pipeline === undefined ? {} : { pipeline: session.pipeline }),
        stage: session.stage,
        needs_human: session.needs_human,
        ...(ended === undefined ? {} : { ended }),
    };
}

/** Pure: the session with `record` as its top-level change fields. `changes` is not touched. */
function with_top_level(session: Session, record: ChangeRecord): Session {
    const next: Session = structuredClone(session);
    const { id, title, started, on } = record;
    next.change = { id, title, started, ...(on === undefined ? {} : { on }) };
    next.branch = record.branch;
    for (const [repo, entry] of Object.entries(next.repos)) {
        const facts = record.repos[repo];
        entry.changed = facts?.changed ?? false;
        entry.pr = facts?.pr ?? null;
        // The sync facts are the worktree's, so they describe whatever is checked out.
        delete entry.sync;
    }
    next.pipeline = structuredClone(record.pipeline ?? empty_pipeline());
    next.stage = record.stage;
    next.needs_human = record.needs_human;
    return next;
}

/**
 * Pure: the session focused on change `id` (2.2). For the current change it is the session
 * itself. For another one, the top-level change fields are that change's, and the
 * session-level facts the stage derivation reads (the design gate, diff comments, preview
 * comments, the review draft) are left out: they belong to the current change's stage.
 */
export function focus_change(session: Session, id: string): Session {
    if (current_change(session).id === id) {
        return session;
    }
    const record = records_of(session).find((entry) => entry.id === id);
    assert.ok(record !== undefined, `session ${session.id} has no change "${id}"`);
    const next = with_top_level(session, record);
    delete next.design;
    delete next.diff;
    delete next.comments;
    delete next.review;
    return next;
}

/** True when the session has a change `id`, current or not. */
export function has_change(session: Session, id: string): boolean {
    return (
        current_change(session).id === id || records_of(session).some((entry) => entry.id === id)
    );
}

/**
 * Pure: `disk` with the change fields of `focused` stored for change `id`: into the top
 * level when that change is current in `disk`, else into its record. Nothing else of
 * `focused` is taken, so a job that held a session for an hour cannot write stale agents, a
 * stale stack or another change back. A change that is gone from `disk` stores nothing.
 */
export function store_change(disk: Session, focused: Session, id: string): Session {
    const next: Session = structuredClone(disk);
    if (current_change(disk).id === id) {
        for (const [repo, entry] of Object.entries(next.repos)) {
            const facts = focused.repos[repo];
            if (facts !== undefined) {
                entry.changed = facts.changed;
                entry.pr = facts.pr ?? null;
            }
        }
        if (focused.pipeline !== undefined) {
            next.pipeline = structuredClone(focused.pipeline);
        }
        next.stage = focused.stage;
        next.needs_human = focused.needs_human;
        return next;
    }
    const records = next.changes ?? [];
    const index = records.findIndex((entry) => entry.id === id);
    if (index === -1) {
        return next;
    }
    const stored = record_of_current(focused);
    const previous = records[index];
    assert.ok(previous !== undefined);
    // The name and the branch of a record are fixed when it is put aside.
    records[index] = {
        ...stored,
        id: previous.id,
        title: previous.title,
        started: previous.started,
        branch: previous.branch,
        ...(previous.on === undefined ? {} : { on: previous.on }),
    };
    next.changes = records;
    return next;
}

/** Past `CHANGES_MAX` records the oldest finished one drops; open ones are never dropped. */
function bounded(records: ChangeRecord[]): ChangeRecord[] {
    const kept = [...records];
    for (let over = kept.length - CHANGES_MAX; over > 0; over -= 1) {
        const index = kept.findIndex((entry) => entry.ended !== undefined);
        assert.ok(index !== -1, `over ${CHANGES_MAX} open changes in one session`);
        kept.splice(index, 1);
    }
    return kept;
}

export interface StartChange {
    id: string;
    title: string;
    branch: string;
    /** ISO 8601. */
    started: string;
    on?: string;
    /** False when the current change has no commit and no pull request: it is not kept. */
    keep_current: boolean;
}

/** Pure: the session after `start`: the current change put aside, a new empty one on top. */
export function start_change(session: Session, input: StartChange): Session {
    assert.ok(!has_change(session, input.id), `change id ${input.id} is in use`);
    assert.ok(input.title.trim().length > 0, "a change needs a title");
    assert.ok(input.on === undefined || has_change(session, input.on), "unknown `on` change");
    const records = input.keep_current
        ? [...records_of(session), record_of_current(session)]
        : records_of(session);
    const repos: Record<string, ChangeRepo> = {};
    for (const repo of Object.keys(session.repos)) {
        repos[repo] = { changed: false, pr: null };
    }
    const next = with_top_level(session, {
        id: input.id,
        title: input.title,
        started: input.started,
        ...(input.on === undefined ? {} : { on: input.on }),
        branch: input.branch,
        repos,
        pipeline: empty_pipeline(),
        stage: "planned",
        needs_human: null,
    });
    next.changes = bounded(records);
    return next;
}

/** Pure: the session after `switch`: change `id` on top, the current one put aside. */
export function switch_change(session: Session, id: string, keep_current: boolean): Session {
    const record = records_of(session).find((entry) => entry.id === id);
    assert.ok(record !== undefined, `session ${session.id} has no other change "${id}"`);
    const others = records_of(session).filter((entry) => entry.id !== id);
    const next = with_top_level(session, record);
    next.changes = bounded(keep_current ? [...others, record_of_current(session)] : others);
    return next;
}

/**
 * `feat/parallel-exports`: the prefix of the session's branch, the slug of the title. A name
 * the session used, or one in `also_taken` (branches the repositories already have), gets a
 * number.
 */
export function change_branch(
    session: Session,
    slug: string,
    also_taken: ReadonlySet<string> = new Set(),
): string {
    assert.ok(slug.length > 0, "a change's title must yield a slug");
    const slash = session.branch.indexOf("/");
    const prefix = slash > 0 ? session.branch.slice(0, slash) : "feat";
    const taken = new Set([
        session.branch,
        ...records_of(session).map((entry) => entry.branch),
        ...(session.rounds ?? []).map((round) => round.branch),
        ...also_taken,
    ]);
    const base = `${prefix}/${slug}`;
    if (!taken.has(base)) {
        return base;
    }
    for (let suffix = 2; suffix <= CHANGES_MAX + 2; suffix += 1) {
        const candidate = `${base}-${suffix}`;
        if (!taken.has(candidate)) {
            return candidate;
        }
    }
    throw new Error(`no free branch name for "${slug}"`);
}

/**
 * The base of a change's pull request in `repo`: the branch of the change it was started
 * `on`, while that change's pull request in the same repo is open. Null: the repo's base.
 */
export function stacked_base(session: Session, repo: string): string | null {
    const on = current_change(session).on;
    if (on === undefined) {
        return null;
    }
    const parent = records_of(session).find((entry) => entry.id === on);
    const pr = parent?.repos[repo]?.pr;
    if (parent === undefined || pr === undefined || pr === null) {
        return null;
    }
    return pr.state === "open" || pr.state === "draft" ? parent.branch : null;
}

/** The ids of the changes with an open pull request, the current one first. */
export function open_change_ids(session: Session): string[] {
    const is_open = (pr: { state: string } | null | undefined): boolean =>
        pr != null && (pr.state === "open" || pr.state === "draft");
    const ids: string[] = [];
    if (Object.values(session.repos ?? {}).some((entry) => is_open(entry.pr))) {
        ids.push(current_change(session).id);
    }
    for (const record of records_of(session)) {
        if (Object.values(record.repos).some((entry) => is_open(entry.pr))) {
            ids.push(record.id);
        }
    }
    return ids;
}

/**
 * Pure: the state of a change in plain words, from its stage and its pull requests. The
 * order of the tests is the order of what the operator must know first.
 */
export function change_state(
    stage: Stage,
    prs: readonly PrFacts[],
    changed: boolean,
): ChangeStateName {
    if (prs.length === 0) {
        return changed ? "building" : "empty";
    }
    const open = prs.filter((pr) => pr.state === "open" || pr.state === "draft");
    if (open.length === 0) {
        return prs.every((pr) => pr.state === "merged") ? "merged" : "closed";
    }
    if (open.some((pr) => pr.queue === "queued" || pr.queue === "merging")) {
        return "in merge queue";
    }
    if (open.some((pr) => pr.checks === "red")) {
        return "fixing CI";
    }
    if (open.some((pr) => pr.threads.bots_open + pr.threads.humans_open > 0)) {
        return "answering review";
    }
    if (stage === "approving" && open.every((pr) => pr.checks === "green")) {
        return "ready to merge";
    }
    if (stage === "peer-review" || stage === "approving") {
        return "in review";
    }
    return "PR open";
}

function view_of_record(record: ChangeRecord, current: boolean): ChangeView {
    const prs = record_prs(record);
    const changed = Object.values(record.repos).some((entry) => entry.changed);
    return {
        id: record.id,
        title: record.title,
        branch: record.branch,
        current,
        state: change_state(record.stage, prs, changed),
        stage: record.stage,
        needs_human: record.needs_human,
        prs,
        on: record.on ?? null,
        verified: is_verified(record, prs),
        started: record.started,
        ended: record.ended ?? null,
    };
}

/** True when the operator's tick stands at the head of every open pull request (3.2). */
function is_verified(record: ChangeRecord, prs: readonly PrFacts[]): boolean {
    const pipeline = record.pipeline;
    const open = prs.filter((pr) => pr.state === "open" || pr.state === "draft");
    if (pipeline === undefined || !pipeline.verified_locally || open.length === 0) {
        return false;
    }
    return open.every((pr) => pipeline.verified_heads?.[pr.repo] === pr.head);
}

/**
 * Pure: every change of the session, oldest first: the rounds `reset` recorded (as finished
 * changes `r<n>`), the changes put aside, then the current one.
 */
export function changes_view(session: Session, rounds: readonly RoundView[]): ChangeView[] {
    const views: ChangeView[] = rounds.map((round) => {
        const prs = round.prs;
        const merged = prs.length > 0 && prs.every((pr) => pr.state === "merged");
        return {
            id: `r${round.round}`,
            title: round.branch,
            branch: round.branch,
            current: false,
            state: merged ? "merged" : "closed",
            stage: merged ? "merged" : "closed",
            needs_human: null,
            prs: prs.map((pr) => ({
                repo: pr.repo,
                number: pr.number,
                url: pr.url,
                state: pr.state,
            })),
            on: null,
            started: round.started,
            ended: round.ended,
        };
    });
    const records = records_of(session).map((record) => view_of_record(record, false));
    // The current change has commits before it has a pull request; the sync counts them.
    const current = view_of_record(record_of_current(session), true);
    const commits = Object.values(session.repos).some((entry) => (entry.sync?.commits ?? 0) > 0);
    if (current.state === "empty" && commits) {
        current.state = "building";
    }
    // By start time, not by the order the changes were put aside: a switch must not
    // reorder the cards.
    const started = (view: ChangeView): string => view.started ?? "";
    const changes = [...records, current].sort((a, b) => started(a).localeCompare(started(b)));
    return [...views, ...changes];
}
