// The groups of a session's changes (the operator's ask of 2026-11-23): pull requests that
// belong together under one headline, with a line that says what they are for and a hold
// either the lead or the operator can set. A change names its group by id
// (`ChangeHead.group`); the groups are `session.groups`. Pure functions on the session: the
// routes read the file, apply one, and write it back.
import assert from "node:assert/strict";
import type { ChangeGroup, ChangeHold, Session } from "@spinner/protocol";
import { GROUPS_MAX, GROUP_NAME_CHARS_MAX, GROUP_TEXT_CHARS_MAX } from "@spinner/protocol";
import { current_change } from "./changes.js";

/** A request the session refuses: an unknown change or group, a name that is taken. */
export class GroupRefusal extends Error {
    constructor(
        message: string,
        /** 404 for something the session does not have, 409 for a clash, 400 for bad text. */
        readonly status: 400 | 404 | 409,
    ) {
        super(message);
    }
}

function groups_of(session: Session): ChangeGroup[] {
    return session.groups ?? [];
}

/** One line, trimmed, with inner line breaks as spaces. */
function one_line(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function checked_name(name: string): string {
    const line = one_line(name);
    if (line === "" || line.length > GROUP_NAME_CHARS_MAX) {
        throw new GroupRefusal(
            `a group's name is 1 to ${GROUP_NAME_CHARS_MAX} characters, a few words`,
            400,
        );
    }
    return line;
}

function checked_text(text: string, what: string): string {
    const line = one_line(text);
    if (line.length > GROUP_TEXT_CHARS_MAX) {
        throw new GroupRefusal(
            `${what} is one line, at most ${GROUP_TEXT_CHARS_MAX} characters`,
            400,
        );
    }
    return line;
}

/** The group with that id, or with that name (letter case aside); null without one. */
export function find_group(session: Session, key: string): ChangeGroup | null {
    const wanted = one_line(key).toLowerCase();
    const groups = groups_of(session);
    return (
        groups.find((group) => group.id === key) ??
        groups.find((group) => group.name.toLowerCase() === wanted) ??
        null
    );
}

function next_group_id(session: Session): string {
    let highest = 0;
    for (const group of groups_of(session)) {
        const match = /^g(\d+)$/.exec(group.id);
        highest = Math.max(highest, match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10));
    }
    return `g${highest + 1}`;
}

/** The ids of every change of the session: the current one and the ones put aside. */
function change_ids(session: Session): string[] {
    return [current_change(session).id, ...(session.changes ?? []).map((record) => record.id)];
}

/** Sets or clears the group of change `id`, wherever the session keeps that change. */
function with_change_group(session: Session, id: string, group: string | null): void {
    const set = (head: { group?: string }): void => {
        if (group === null) {
            delete head.group;
        } else {
            head.group = group;
        }
    };
    if (current_change(session).id === id) {
        session.change = { ...current_change(session) };
        set(session.change);
        return;
    }
    const record = (session.changes ?? []).find((entry) => entry.id === id);
    assert.ok(record !== undefined, `change ${id} was checked before`);
    set(record);
}

/** Drops the groups no change names, and `groups` itself when none is left. */
function without_empty_groups(session: Session): void {
    const named = new Set<string>();
    const heads = [current_change(session), ...(session.changes ?? [])];
    for (const head of heads) {
        if (head.group !== undefined) {
            named.add(head.group);
        }
    }
    const kept = groups_of(session).filter((group) => named.has(group.id));
    if (kept.length === 0) {
        delete session.groups;
    } else {
        session.groups = kept;
    }
}

/**
 * Puts change `id` in the group named `name`, which is made when the session has none of
 * that name; `name` null takes the change out of its group. A `purpose` given replaces the
 * group's. A group left without a change is dropped.
 */
export function assign_group(
    session: Session,
    id: string,
    input: { name: string | null; purpose?: string },
): Session {
    if (!change_ids(session).includes(id)) {
        throw new GroupRefusal(`no change ${id} in session ${session.id}`, 404);
    }
    const next: Session = structuredClone(session);
    if (input.name === null) {
        with_change_group(next, id, null);
        without_empty_groups(next);
        return next;
    }
    const name = checked_name(input.name);
    const purpose =
        input.purpose === undefined ? undefined : checked_text(input.purpose, "a purpose");
    let group = find_group(next, name);
    if (group === null) {
        if (groups_of(next).length >= GROUPS_MAX) {
            throw new GroupRefusal(`a session has at most ${GROUPS_MAX} groups`, 409);
        }
        group = { id: next_group_id(next), name, purpose: purpose ?? "" };
        next.groups = [...groups_of(next), group];
    } else if (purpose !== undefined) {
        group.purpose = purpose;
    }
    with_change_group(next, id, group.id);
    without_empty_groups(next);
    return next;
}

/** Renames group `key` (its id or its name), or rewords its purpose, or both. */
export function edit_group(
    session: Session,
    key: string,
    input: { name?: string; purpose?: string },
): Session {
    const next: Session = structuredClone(session);
    const group = find_group(next, key);
    if (group === null) {
        throw new GroupRefusal(`no group ${key} in session ${session.id}`, 404);
    }
    if (input.name !== undefined) {
        const name = checked_name(input.name);
        const taken = find_group(next, name);
        if (taken !== null && taken.id !== group.id) {
            throw new GroupRefusal(`another group is named "${taken.name}" already`, 409);
        }
        group.name = name;
    }
    if (input.purpose !== undefined) {
        group.purpose = checked_text(input.purpose, "a purpose");
    }
    return next;
}

/** Puts group `key` on hold, or takes it off with `hold` null. */
export function hold_group(session: Session, key: string, hold: ChangeHold | null): Session {
    const next: Session = structuredClone(session);
    const group = find_group(next, key);
    if (group === null) {
        throw new GroupRefusal(`no group ${key} in session ${session.id}`, 404);
    }
    if (hold === null) {
        delete group.hold;
        return next;
    }
    const reason = checked_text(hold.reason, "a reason");
    if (reason === "") {
        throw new GroupRefusal("a hold needs a reason: one line that says why", 400);
    }
    assert.ok(hold.by.length > 0, "a hold names who set it");
    group.hold = { by: hold.by, reason, at: hold.at };
    return next;
}

/**
 * The hold on the current change's group, or null. For a session focused on a change
 * (`focus_change`), that is the hold on the focused change: the poller asks before it sends
 * the lead anything about that change's pull requests.
 */
export function hold_of_current(session: Session): ChangeHold | null {
    const id = current_change(session).group;
    if (id === undefined) {
        return null;
    }
    return groups_of(session).find((group) => group.id === id)?.hold ?? null;
}
