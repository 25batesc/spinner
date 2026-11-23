// Goal: the changes of a session can be put in named groups with a purpose, a group can be
// renamed and put on hold by the lead or the operator, a change started on a grouped change
// joins its group, a job that wrote a change's facts cannot undo a regrouping, and the
// routes answer the session with its groups. Method: the pure functions on a session built
// with `start_change`, then a real daemon on port 0 and `fetch`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session, SessionView } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { start_daemon, type Daemon } from "../server.js";
import { create_session, read_session, write_session } from "../store/session-store.js";
import { changes_view, focus_change, start_change, store_change } from "./changes.js";
import {
    assign_group,
    edit_group,
    find_group,
    GroupRefusal,
    hold_group,
    hold_of_current,
} from "./groups.js";

let root: string;
let home: SpinnerHome;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "spinner-groups-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home") });
    mkdirSync(home.root, { recursive: true });
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

/** A session with three changes: c1 and c2 put aside, c3 current. */
function three_changes(): Session {
    const base = create_session(home, { title: "Evals" }).session;
    const start = (session: Session, id: string, on?: string): Session =>
        start_change(session, {
            id,
            title: `change ${id}`,
            branch: `feat/${id}`,
            started: `2026-11-2${id.slice(1)}T10:00:00.000Z`,
            ...(on === undefined ? {} : { on }),
            keep_current: true,
        });
    return start(start(base, "c2"), "c3");
}

/** The group of each change, by change id, as the view carries it. */
function groups_by_change(session: Session): Record<string, string | null | undefined> {
    return Object.fromEntries(changes_view(session, []).map((view) => [view.id, view.group]));
}

function status_of(run: () => unknown): number {
    try {
        run();
        return 0;
    } catch (error) {
        return error instanceof GroupRefusal ? error.status : -1;
    }
}

describe("groups of changes", () => {
    it("puts changes in a group by name, makes the group once, and drops an empty one", () => {
        let session = three_changes();
        const purpose = "No green card without a price";
        session = assign_group(session, "c1", { name: "Client-ready rule", purpose });
        // The same name with another letter case is the same group; the current change too.
        session = assign_group(session, "c3", { name: "client-ready RULE" });
        expect(session.groups).toEqual([{ id: "g1", name: "Client-ready rule", purpose }]);
        expect(groups_by_change(session)).toEqual({ c1: "g1", c2: null, c3: "g1" });
        // A second group; a purpose given later replaces the first.
        session = assign_group(session, "c2", { name: "Replay tooling" });
        const replay = { name: "Replay tooling", purpose: "Honest replays" };
        session = assign_group(session, "c2", replay);
        expect(find_group(session, "g2")).toMatchObject(replay);
        // Out of its group: the group that is left without a change goes.
        session = assign_group(session, "c2", { name: null });
        expect(session.groups?.map((group) => group.id)).toEqual(["g1"]);
        session = assign_group(assign_group(session, "c1", { name: null }), "c3", { name: null });
        expect(session.groups).toBeUndefined();

        expect(status_of(() => assign_group(session, "c9", { name: "x" }))).toBe(404);
        expect(status_of(() => assign_group(session, "c1", { name: "  " }))).toBe(400);
        expect(status_of(() => assign_group(session, "c1", { name: "x".repeat(61) }))).toBe(400);
    });

    it("renames a group, keeps its id, and refuses a name another group has", () => {
        let session = assign_group(three_changes(), "c1", { name: "A" });
        session = assign_group(session, "c2", { name: "B" });
        session = edit_group(session, "A", { name: "Client-ready rule", purpose: "Why it exists" });
        expect(session.groups?.[0]).toEqual({
            id: "g1",
            name: "Client-ready rule",
            purpose: "Why it exists",
        });
        expect(groups_by_change(session)).toMatchObject({ c1: "g1", c2: "g2" });
        expect(status_of(() => edit_group(session, "g1", { name: "b" }))).toBe(409);
        // Its own name in another letter case is a rename, not a clash.
        const lower = edit_group(session, "g1", { name: "client-ready rule" });
        expect(lower.groups?.[0]?.name).toBe("client-ready rule");
        expect(status_of(() => edit_group(session, "nope", { name: "x" }))).toBe(404);
    });

    it("holds a group with a reason and who set it, and takes the hold off", () => {
        let session = assign_group(three_changes(), "c1", { name: "A" });
        const at = "2026-11-23T18:00:00.000Z";
        const hold = { by: "lead", reason: "waiting for #5954 to deploy", at };
        session = hold_group(session, "A", hold);
        expect(session.groups?.[0]?.hold).toEqual(hold);
        // The poller asks for the change it is focused on: c1 holds, c2 and the current do not.
        expect(hold_of_current(focus_change(session, "c1"))).toEqual(hold);
        expect(hold_of_current(focus_change(session, "c2"))).toBeNull();
        expect(hold_of_current(session)).toBeNull();
        session = hold_group(session, "g1", null);
        expect(session.groups?.[0]?.hold).toBeUndefined();
        expect(status_of(() => hold_group(session, "A", { ...hold, reason: " " }))).toBe(400);
        expect(status_of(() => hold_group(session, "Z", hold))).toBe(404);
    });

    it("a change started on a grouped change joins its group", () => {
        const grouped = assign_group(three_changes(), "c3", { name: "A" });
        const stacked = start_change(grouped, {
            id: "c4", title: "follow-up", branch: "feat/c4", started: "2026-11-24T10:00:00.000Z",
            on: "c3", keep_current: true,
        });
        expect(stacked.change).toMatchObject({ id: "c4", on: "c3", group: "g1" });
        const alone = start_change(grouped, {
            id: "c5", title: "other", branch: "feat/c5", started: "2026-11-24T11:00:00.000Z",
            keep_current: true,
        });
        expect(alone.change?.group).toBeUndefined();
    });

    it("a job that stores a change's facts does not undo a regrouping made meanwhile", () => {
        const before = three_changes();
        // A poll focused on c1 holds the session while the lead groups c1.
        const held = focus_change(before, "c1");
        const disk = assign_group(before, "c1", { name: "A" });
        const stored = store_change(disk, { ...held, needs_human: "verify locally" }, "c1");
        const record = stored.changes?.find((entry) => entry.id === "c1");
        expect(record).toMatchObject({ group: "g1", needs_human: "verify locally" });
        expect(stored.groups).toEqual(disk.groups);
    });
});

describe("the group routes", () => {
    let daemon: Daemon;

    beforeEach(async () => {
        daemon = await start_daemon({
            home,
            port: 0,
            log: () => undefined,
            poll_seconds: 0,
            notify: async () => undefined,
            ui_dir: null,
            observe_interval_ms: 60_000,
            cwd: root,
        });
    });

    afterEach(async () => {
        await daemon.close();
    });

    async function call(
        method: string,
        path: string,
        body?: unknown,
    ): Promise<[number, SessionView]> {
        const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
            method,
            headers: { "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const parsed = (await response.json()) as { session: SessionView };
        return [response.status, parsed.session];
    }

    it("group, rename, hold and resume through the daemon, written to session.yaml", async () => {
        const summary = create_session(home, { title: "Routes" });
        write_session({ ...summary, session: { ...three_changes(), id: summary.session.id } });
        const at = `/sessions/${summary.dir}`;

        const [grouped, view] = await call("PUT", `${at}/changes/c1/group`, {
            group: "Client-ready rule",
            purpose: "No green card without a price",
        });
        expect(grouped).toBe(200);
        expect(view.groups).toEqual([
            { id: "g1", name: "Client-ready rule", purpose: "No green card without a price" },
        ]);
        expect(view.changes?.find((change) => change.id === "c1")?.group).toBe("g1");

        const [renamed, after] = await call("PUT", `${at}/groups/g1`, { name: "Price rule" });
        expect(renamed).toBe(200);
        expect(after.groups?.[0]?.name).toBe("Price rule");

        // By name as well as by id: the lead's tool knows the name.
        const hold = { reason: "other work first", by: "operator" };
        const by_name = `${at}/groups/${encodeURIComponent("price rule")}/hold`;
        const [held, holding] = await call("PUT", by_name, hold);
        expect(held).toBe(200);
        expect(holding.groups?.[0]?.hold).toMatchObject(hold);
        const read = read_session(home, summary.dir);
        const file = parse(readFileSync(join(summary.path, "session.yaml"), "utf8")) as Session;
        expect(read.ok && read.summary.session.groups?.[0]?.hold?.reason).toBe("other work first");
        expect(file.changes?.find((change) => change.id === "c1")?.group).toBe("g1");

        const [resumed, free] = await call("DELETE", `${at}/groups/g1/hold`);
        expect(resumed).toBe(200);
        expect(free.groups?.[0]?.hold).toBeUndefined();

        expect((await call("PUT", `${at}/changes/c9/group`, { group: "x" }))[0]).toBe(404);
        const no_reason = { reason: "", by: "lead" };
        expect((await call("PUT", `${at}/groups/g1/hold`, no_reason))[0]).toBe(400);
        expect((await call("PUT", `${at}/groups/g1`, {}))[0]).toBe(400);
        expect((await call("PUT", `${at}/groups/g7`, { name: "x" }))[0]).toBe(404);
    });
});
