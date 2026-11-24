// Linear tickets for a session's pull requests (the operator's ask of 2026-11-24). The
// daemon keeps one ticket per pull request and, for a unit of work with several pull
// requests, a parent ticket over them. A unit is a group of changes, or one change that is
// in no group. A unit with one pull request has one ticket and no parent: a change in one
// repository needs one ticket; a change in two repositories gets a parent, so the frontend
// and the backend tickets read as one piece of work.
//
// The tickets are written by the poller after it read GitHub, only for a session whose
// project names a Linear team (`pipeline.linear` in `spinner.yaml`). This file holds the
// types and the pure rules that the daemon and the UI must agree on; it uses no `node:`
// module.

/** `pipeline.linear` of `spinner.yaml`. Absent: the daemon writes nothing to Linear. */
export interface LinearConfig {
    /** The team's key, the prefix of its ticket ids (`GKA`). */
    team: string;
    /**
     * The label of each repo's tickets, by repo key (`backend: Backend`). A repo without an
     * entry gets no label. The daemon creates a label the team does not have.
     */
    labels: Record<string, string>;
    /** The name of the workflow state for each stage of a pull request. */
    states: LinearStates;
}

/** The team's workflow state names a ticket moves through, by the stage of its pull request. */
export interface LinearStates {
    /** A draft pull request: the work is in progress. */
    draft: string;
    /** An open pull request: it waits for review. */
    open: string;
    /** A merged pull request. The ticket goes no further than this by itself. */
    merged: string;
}

export const LINEAR_STATES_DEFAULT: LinearStates = {
    draft: "In Progress",
    open: "In Review",
    merged: "In Dev Env",
};

/** Where a ticket stands, from its pull requests. A closed pull request moves nothing. */
export type LinearStage = keyof LinearStates;

/** One Linear ticket as `session.yaml` keeps it. */
export interface LinearTicket {
    /** Linear's own id of the issue, for the API. */
    id: string;
    /** `GKA-123`. */
    identifier: string;
    url: string;
    title: string;
    /** The name of its workflow state when the daemon last wrote or read it. */
    state: string;
    /** The identifier of its parent ticket, or null. */
    parent: string | null;
    /**
     * What the daemon last wrote: `linear_signature` of the ticket it wanted then. The same
     * signature now means there is nothing to send.
     */
    synced: string;
    /**
     * True for a ticket somebody else made and Linear linked to the pull request. The daemon
     * moves its state and puts it under a parent; its title and description stay as written.
     */
    adopted?: boolean;
    /**
     * True while the ticket is made and the pull request is not attached to it yet: the
     * attach call failed. The next round attaches it; the ticket is never made twice.
     */
    unlinked?: boolean;
}

/** `session.yaml` `linear`: the tickets of the session. Absent before the first one. */
export interface SessionLinear {
    /** The ticket of each pull request, by the pull request's URL. */
    prs: Record<string, LinearTicket>;
    /** The parent ticket of each unit that has one, by the unit: a group id or a change id. */
    parents: Record<string, LinearTicket>;
}

/** A ticket the daemon wants to exist, before any id: a pull request's or a unit's parent. */
export interface LinearWanted {
    kind: "pr" | "parent";
    /** The key in `SessionLinear`: the pull request's URL, or the unit. */
    key: string;
    /** The unit the ticket belongs to: a group id (`g1`) or a change id (`c7`). */
    unit: string;
    /** The repo key of a pull request's ticket, for its label; null for a parent. */
    repo: string | null;
    title: string;
    description: string;
    stage: LinearStage;
    /** True when the ticket goes under its unit's parent. */
    child: boolean;
    /**
     * False for a pull request that is already merged or closed: a ticket it has follows
     * it, and one it does not have is not made after the fact.
     */
    create: boolean;
}

/** A session holds at most this many Linear tickets; past it the daemon makes no more. */
export const LINEAR_TICKETS_MAX = 500;
/** A ticket's title is cut at this many characters. */
export const LINEAR_TITLE_CHARS_MAX = 200;

/**
 * What the daemon compares to know a ticket is as wanted: the title, the state name, the
 * description and the parent. Kept in `LinearTicket.synced`.
 */
export function linear_signature(
    wanted: Pick<LinearWanted, "title" | "description">,
    state: string,
    parent: string | null,
): string {
    return JSON.stringify([wanted.title, state, wanted.description, parent]);
}
