// The Linear tickets of a session (`@spinner/protocol` `linear.ts`). `wanted_tickets` is the
// pure half: from `session.yaml` alone, the ticket each pull request should have and the
// parent of each unit with several. `sync_linear` is the other half: it compares the wanted
// tickets with the ones `session.linear` records and sends Linear only the difference, so a
// round in which nothing moved makes no call. The poller runs it after it read GitHub.
//
// A pull request's ticket is found before it is made: when Linear already links a ticket to
// the pull request (its own GitHub link), the daemon adopts that ticket and never rewrites
// its title or description.
import assert from "node:assert/strict";
import {
    LINEAR_TICKETS_MAX,
    LINEAR_TITLE_CHARS_MAX,
    linear_signature,
    type ChangePr,
    type ChangeView,
    type LinearConfig,
    type LinearStage,
    type LinearTicket,
    type LinearWanted,
    type Session,
    type SessionLinear,
} from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";
import { read_session, write_session } from "../store/session-store.js";
import { changes_view } from "./changes.js";

/** A team as the sync needs it: the ids behind the names of `spinner.yaml`. */
export interface LinearTeam {
    id: string;
    /** The user the API key belongs to: the assignee of a ticket the daemon makes. */
    viewer_id: string;
    states: { id: string; name: string; type: string }[];
    labels: { id: string; name: string }[];
}

export interface LinearIssue {
    id: string;
    identifier: string;
    url: string;
    title: string;
    state: { name: string; type: string };
    /** The identifier of the parent, or null. */
    parent: string | null;
}

export interface LinearIssueInput {
    team_id: string;
    title: string;
    description: string;
    state_id: string;
    assignee_id: string;
    label_ids: string[];
    parent_id: string | null;
}

export interface LinearIssueChange {
    title?: string;
    description?: string;
    state_id?: string;
    parent_id?: string;
}

/** Linear as the sync uses it. `linear-client.ts` is the real one; a test passes a fake. */
export interface LinearApi {
    /** The team with `key`; throws when the workspace has none. */
    team(key: string): Promise<LinearTeam>;
    /** The ticket Linear links to a pull request's URL, or null. */
    issue_for_url(url: string): Promise<LinearIssue | null>;
    issue(id: string): Promise<LinearIssue | null>;
    create_issue(input: LinearIssueInput): Promise<LinearIssue>;
    update_issue(id: string, change: LinearIssueChange): Promise<void>;
    /** Attaches the pull request to the ticket, as Linear's own GitHub link. */
    link_pr(issue_id: string, url: string): Promise<void>;
    /** Makes a label of the team and answers its id. */
    create_label(team_id: string, name: string): Promise<string>;
}

/** One sync sends at most this many writes; the rest goes with the next round. */
export const LINEAR_WRITES_PER_ROUND_MAX = 20;

/** State types a ticket has left the work with: the daemon does not move it back. */
const FINAL_STATE_TYPES: readonly string[] = ["completed", "canceled", "duplicate"];

interface UnitPr {
    change: ChangeView;
    pr: ChangePr & { url: string };
}

/** Where a pull request's ticket stands; null for one closed without a merge. */
function stage_of(pr: ChangePr): LinearStage | null {
    switch (pr.state) {
        case "draft":
            return "draft";
        case "open":
            return "open";
        case "merged":
            return "merged";
        case "closed":
            return null;
    }
}

/** A parent is as far as its least advanced pull request. */
function parent_stage(stages: readonly LinearStage[]): LinearStage {
    assert.ok(stages.length > 0, "a parent has at least one pull request");
    if (stages.includes("draft")) {
        return "draft";
    }
    return stages.includes("open") ? "open" : "merged";
}

function cut(title: string): string {
    return title.replace(/\s+/g, " ").trim().slice(0, LINEAR_TITLE_CHARS_MAX);
}

/**
 * Pure: the tickets the session should have. A unit is a group of changes, or a change in
 * no group. Each pull request of a unit that is open, or that already has a ticket, wants a
 * ticket; a unit with two or more of those wants a parent over them. A pull request closed
 * without a merge wants nothing: its ticket stays as it is.
 */
export function wanted_tickets(session: Session): LinearWanted[] {
    const stored: SessionLinear = session.linear ?? { prs: {}, parents: {} };
    const groups = session.groups ?? [];
    const units = new Map<string, UnitPr[]>();
    for (const change of changes_view(session, [])) {
        const group = groups.find((entry) => entry.id === change.group);
        const unit = group?.id ?? change.id;
        for (const pr of change.prs) {
            if (pr.url !== null) {
                const entries = units.get(unit) ?? [];
                entries.push({ change, pr: { ...pr, url: pr.url } });
                units.set(unit, entries);
            }
        }
    }
    const footer = `Spinner session ${session.id}: ${session.title}`;
    const wanted: LinearWanted[] = [];
    for (const [unit, entries] of units) {
        const group = groups.find((entry) => entry.id === unit);
        const live = entries.filter(({ pr }) => {
            const open = pr.state === "open" || pr.state === "draft";
            return stage_of(pr) !== null && (open || stored.prs[pr.url] !== undefined);
        });
        const purpose = group === undefined || group.purpose === "" ? [] : [group.purpose, ""];
        const opened = live.some(({ pr }) => pr.state === "open" || pr.state === "draft");
        // A parent is made while the unit has an open pull request. Two tickets whose pull
        // requests both ended before they were one unit stay as they are.
        const child = live.length >= 2 && (opened || stored.parents[unit] !== undefined);
        const stages: LinearStage[] = [];
        for (const { change, pr } of live) {
            const stage = stage_of(pr) as LinearStage;
            stages.push(stage);
            wanted.push({
                kind: "pr",
                key: pr.url,
                unit,
                repo: pr.repo,
                title: cut(pr.title ?? change.title),
                description: [...purpose, `Pull request: ${pr.url}`, "", footer].join("\n"),
                stage,
                child,
                create: pr.state === "open" || pr.state === "draft",
            });
        }
        if (child) {
            const first = (live[0] as UnitPr).change;
            wanted.push({
                kind: "parent",
                key: unit,
                unit,
                repo: null,
                title: cut(group?.name ?? first.title),
                description: [...purpose, footer].join("\n"),
                stage: parent_stage(stages),
                child: false,
                create: opened,
            });
        }
    }
    // Parents first: a child names its parent's id.
    return [
        ...wanted.filter((ticket) => ticket.kind === "parent"),
        ...wanted.filter((ticket) => ticket.kind === "pr"),
    ];
}

function ticket_of(stored: SessionLinear, wanted: LinearWanted): LinearTicket | undefined {
    return wanted.kind === "parent" ? stored.parents[wanted.key] : stored.prs[wanted.key];
}

/** The signature a ticket has when it is as wanted. An adopted ticket keeps its own words. */
function signature_of(
    wanted: LinearWanted,
    ticket: LinearTicket | undefined,
    config: LinearConfig,
    parent: string | null,
): string {
    const words = ticket?.adopted === true ? { title: ticket.title, description: "" } : wanted;
    return linear_signature(words, config.states[wanted.stage], parent);
}

/** Pure: the wanted tickets that Linear does not have as wanted yet. */
export function linear_work(session: Session, config: LinearConfig): LinearWanted[] {
    const stored: SessionLinear = session.linear ?? { prs: {}, parents: {} };
    return wanted_tickets(session).filter((wanted) => {
        const ticket = ticket_of(stored, wanted);
        if (ticket === undefined) {
            return wanted.create;
        }
        const parent = wanted.child ? (stored.parents[wanted.unit]?.identifier ?? null) : null;
        // A child whose parent is not made yet is work: the parent comes first in the round.
        const expected = wanted.child && parent === null ? "pending" : parent;
        return ticket.synced !== signature_of(wanted, ticket, config, expected);
    });
}

export interface LinearSyncDeps {
    home: SpinnerHome;
    api: LinearApi;
    log: (line: string) => void;
}

/**
 * Makes and updates the session's tickets until they are as wanted, at most
 * `LINEAR_WRITES_PER_ROUND_MAX` writes. Each ticket is recorded in `session.yaml` right
 * after its write, on a fresh read of the file, so a failure in the middle never makes a
 * ticket twice. Returns the number of tickets written.
 */
export async function sync_linear(
    deps: LinearSyncDeps,
    dir: string,
    config: LinearConfig,
): Promise<number> {
    const first = read_session(deps.home, dir);
    if (!first.ok || linear_work(first.summary.session, config).length === 0) {
        return 0;
    }
    const team = await deps.api.team(config.team);
    let written = 0;
    for (let round = 0; round < LINEAR_WRITES_PER_ROUND_MAX; round += 1) {
        // Read again per ticket: the write before changed the file, and a child reads its
        // parent's id from it.
        const read = read_session(deps.home, dir);
        if (!read.ok) {
            break;
        }
        const session = read.summary.session;
        const next = linear_work(session, config)[0];
        if (next === undefined) {
            break;
        }
        const stored: SessionLinear = session.linear ?? { prs: {}, parents: {} };
        const count = Object.keys(stored.prs).length + Object.keys(stored.parents).length;
        if (ticket_of(stored, next) === undefined && count >= LINEAR_TICKETS_MAX) {
            deps.log(`linear ${dir}: ${LINEAR_TICKETS_MAX} tickets; no more are made`);
            break;
        }
        const ticket = await write_ticket(deps, team, config, stored, next);
        record_ticket(deps.home, dir, next, ticket);
        deps.log(`linear ${dir}: ${ticket.identifier} ${ticket.state} (${next.title})`);
        written += 1;
    }
    return written;
}

function state_id(team: LinearTeam, name: string): string {
    const state = team.states.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if (state === undefined) {
        const names = team.states.map((entry) => entry.name).join(", ");
        throw new Error(`the Linear team has no state "${name}" (it has: ${names})`);
    }
    return state.id;
}

/** The ids of the repo's label; the label is made when the team does not have it. */
async function label_ids(
    api: LinearApi,
    team: LinearTeam,
    config: LinearConfig,
    repo: string | null,
): Promise<string[]> {
    const name = repo === null ? undefined : config.labels[repo];
    if (name === undefined) {
        return [];
    }
    const known = team.labels.find((label) => label.name.toLowerCase() === name.toLowerCase());
    if (known !== undefined) {
        return [known.id];
    }
    const id = await api.create_label(team.id, name);
    team.labels.push({ id, name });
    return [id];
}

/** Makes, adopts or updates one ticket in Linear, and answers it as the session records it. */
async function write_ticket(
    deps: LinearSyncDeps,
    team: LinearTeam,
    config: LinearConfig,
    stored: SessionLinear,
    wanted: LinearWanted,
): Promise<LinearTicket> {
    const { api } = deps;
    const parent = wanted.child ? stored.parents[wanted.unit] : undefined;
    assert.ok(!wanted.child || parent !== undefined, "a child is written after its parent");
    const parent_name = parent?.identifier ?? null;
    const state_name = config.states[wanted.stage];
    const wanted_state = state_id(team, state_name);
    const known = ticket_of(stored, wanted);
    if (known === undefined) {
        const linked = wanted.kind === "pr" ? await api.issue_for_url(wanted.key) : null;
        if (linked === null) {
            const made = await api.create_issue({
                team_id: team.id,
                title: wanted.title,
                description: wanted.description,
                state_id: wanted_state,
                assignee_id: team.viewer_id,
                label_ids: await label_ids(api, team, config, wanted.repo),
                parent_id: parent?.id ?? null,
            });
            const ticket: LinearTicket = {
                id: made.id,
                identifier: made.identifier,
                url: made.url,
                title: wanted.title,
                state: state_name,
                parent: parent_name,
                synced: signature_of(wanted, undefined, config, parent_name),
            };
            if (wanted.kind === "parent") {
                return ticket;
            }
            // The ticket exists from here on. When the attach fails it is recorded as
            // unlinked, so the next round attaches it instead of making a second ticket.
            try {
                await api.link_pr(made.id, wanted.key);
                return ticket;
            } catch (error) {
                deps.log(`linear: ${made.identifier} is made, not linked yet: ${String(error)}`);
                return { ...ticket, synced: "", unlinked: true };
            }
        }
        const adopted: LinearTicket = {
            id: linked.id,
            identifier: linked.identifier,
            url: linked.url,
            title: linked.title,
            state: linked.state.name,
            parent: linked.parent,
            synced: "",
            adopted: true,
        };
        return update_ticket(api, config, stored, wanted, adopted, linked, wanted_state);
    }
    if (known.unlinked === true) {
        await api.link_pr(known.id, wanted.key);
    }
    const current = await api.issue(known.id);
    if (current === null) {
        // The ticket was deleted in Linear. It is not made again: somebody removed it.
        return { ...known, synced: signature_of(wanted, known, config, parent_name) };
    }
    return update_ticket(api, config, stored, wanted, known, current, wanted_state);
}

/**
 * Sends what differs. A ticket in a final state (done, cancelled, a duplicate) keeps its
 * state: a person closed it. A ticket under a parent that a person gave it keeps that
 * parent; one under a parent the daemon made moves when its unit changed (a change that
 * joined a group).
 */
async function update_ticket(
    api: LinearApi,
    config: LinearConfig,
    stored: SessionLinear,
    wanted: LinearWanted,
    ticket: LinearTicket,
    current: LinearIssue,
    wanted_state: string,
): Promise<LinearTicket> {
    const parent = wanted.child ? stored.parents[wanted.unit] : undefined;
    const ours = Object.values(stored.parents).some(
        (entry) => entry.identifier === current.parent,
    );
    const state_name = config.states[wanted.stage];
    const change: LinearIssueChange = {};
    const final = FINAL_STATE_TYPES.includes(current.state.type);
    const moves = !final && current.state.name.toLowerCase() !== state_name.toLowerCase();
    if (moves) {
        change.state_id = wanted_state;
    }
    const reparent =
        parent !== undefined &&
        current.parent !== parent.identifier &&
        (current.parent === null || ours);
    if (reparent) {
        change.parent_id = parent.id;
    }
    if (ticket.adopted !== true) {
        change.title = wanted.title;
        change.description = wanted.description;
    }
    if (Object.keys(change).length > 0) {
        await api.update_issue(ticket.id, change);
    }
    const parent_name = parent?.identifier ?? null;
    const title = ticket.adopted === true ? current.title : wanted.title;
    const linked = { ...ticket };
    delete linked.unlinked;
    const next: LinearTicket = {
        ...linked,
        title,
        state: final ? current.state.name : state_name,
        parent: reparent ? parent_name : current.parent,
        synced: "",
    };
    return { ...next, synced: signature_of(wanted, next, config, parent_name) };
}

/** Writes one ticket into `session.linear`, on the file as it is now. */
function record_ticket(
    home: SpinnerHome,
    dir: string,
    wanted: LinearWanted,
    ticket: LinearTicket,
): void {
    const read = read_session(home, dir);
    assert.ok(read.ok, `${dir} must read back to record ${ticket.identifier}`);
    const session = read.summary.session;
    const linear: SessionLinear = session.linear ?? { prs: {}, parents: {} };
    if (wanted.kind === "parent") {
        linear.parents[wanted.key] = ticket;
    } else {
        linear.prs[wanted.key] = ticket;
    }
    session.linear = linear;
    write_session(read.summary);
}
