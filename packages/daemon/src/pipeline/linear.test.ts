// Goal: each pull request of a session gets one Linear ticket, a unit with several gets a
// parent over them, the tickets follow the pull requests' states, and a round in which
// nothing moved sends Linear nothing. Method: sessions written with `create_session` on a
// temporary home; `sync_linear` against an in-memory Linear that counts every call; the
// checks read the fake's issues and `session.yaml`. The client is checked against a
// transport that records the request, never against Linear itself.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    LINEAR_STATES_DEFAULT,
    type LinearConfig,
    type PrState,
    type PullRequest,
    type Session,
} from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { create_session, read_session, write_session } from "../store/session-store.js";
import { start_change } from "./changes.js";
import { pipeline_config_from_spec } from "./config.js";
import { assign_group, hold_group } from "./groups.js";
import { linear_client, LINEAR_URL } from "./linear-client.js";
import {
    linear_work,
    sync_linear,
    wanted_tickets,
    type LinearApi,
    type LinearIssue,
    type LinearIssueInput,
    type LinearTeam,
} from "./linear.js";

const CONFIG: LinearConfig = {
    team: "GKA",
    labels: { backend: "Backend", admin: "Frontend" },
    states: LINEAR_STATES_DEFAULT,
};

const STATES = [
    { id: "s-todo", name: "To Do", type: "unstarted" },
    { id: "s-progress", name: "In Progress", type: "started" },
    { id: "s-review", name: "In Review", type: "started" },
    { id: "s-dev", name: "In Dev Env", type: "started" },
    { id: "s-done", name: "Done", type: "completed" },
    { id: "s-canceled", name: "Canceled", type: "canceled" },
];

/** An in-memory Linear: the issues, the links, and a count of every call by name. */
class FakeLinear implements LinearApi {
    issues = new Map<string, LinearIssue & { input: LinearIssueInput }>();
    links: [string, string][] = [];
    calls: string[] = [];
    labels = [{ id: "l-backend", name: "Backend" }];
    /** Tickets Linear links to a pull request on its own, by URL. */
    linked = new Map<string, string>();
    /** The next attach calls that fail, as a rate limit would. */
    link_failures = 0;

    private issue_named(identifier: string | null): LinearIssue | undefined {
        return [...this.issues.values()].find((issue) => issue.identifier === identifier);
    }

    team(): Promise<LinearTeam> {
        this.calls.push("team");
        return Promise.resolve({
            id: "team-1", viewer_id: "user-1", states: STATES, labels: this.labels,
        });
    }

    issue_for_url(url: string): Promise<LinearIssue | null> {
        this.calls.push("issue_for_url");
        return Promise.resolve(this.issues.get(this.linked.get(url) ?? "") ?? null);
    }

    issue(id: string): Promise<LinearIssue | null> {
        this.calls.push("issue");
        return Promise.resolve(this.issues.get(id) ?? null);
    }

    create_issue(input: LinearIssueInput): Promise<LinearIssue> {
        this.calls.push("create_issue");
        const number = this.issues.size + 1;
        const state = STATES.find((entry) => entry.id === input.state_id);
        const issue = {
            id: `i${number}`,
            identifier: `GKA-${number}`,
            url: `https://linear.app/knit/issue/GKA-${number}`,
            title: input.title,
            state: { name: state?.name ?? "?", type: state?.type ?? "?" },
            parent: this.issues.get(input.parent_id ?? "")?.identifier ?? null,
            input,
        };
        this.issues.set(issue.id, issue);
        return Promise.resolve(issue);
    }

    update_issue(id: string, change: Parameters<LinearApi["update_issue"]>[1]): Promise<void> {
        this.calls.push("update_issue");
        const issue = this.issues.get(id);
        if (issue === undefined) {
            return Promise.reject(new Error("Entity not found: Issue"));
        }
        const state = STATES.find((entry) => entry.id === change.state_id);
        if (state !== undefined) {
            issue.state = { name: state.name, type: state.type };
        }
        issue.title = change.title ?? issue.title;
        issue.parent = this.issues.get(change.parent_id ?? "")?.identifier ?? issue.parent;
        return Promise.resolve();
    }

    link_pr(issue_id: string, url: string): Promise<void> {
        this.calls.push("link_pr");
        if (this.link_failures > 0) {
            this.link_failures -= 1;
            return Promise.reject(new Error("Linear: rate limited"));
        }
        this.links.push([this.issues.get(issue_id)?.identifier ?? "?", url]);
        return Promise.resolve();
    }

    create_label(_team: string, name: string): Promise<string> {
        this.calls.push("create_label");
        return Promise.resolve(`l-${name.toLowerCase()}`);
    }

    /** `GKA-1 In Review ^GKA-3 [Backend]`, by identifier. */
    board(): string[] {
        return [...this.issues.values()].map((issue) => {
            const parent = issue.parent === null ? "" : ` ^${issue.parent}`;
            const labels = issue.input.label_ids.length === 0
                ? ""
                : ` [${issue.input.label_ids.join(",")}]`;
            return `${issue.identifier} ${issue.state.name}${parent}${labels} ${issue.title}`;
        });
    }

    named(identifier: string): LinearIssue {
        const issue = this.issue_named(identifier);
        if (issue === undefined) {
            throw new Error(`no ${identifier}`);
        }
        return issue;
    }
}

let root: string;
let home: SpinnerHome;
let linear: FakeLinear;
let dir: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "spinner-linear-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home") });
    linear = new FakeLinear();
    dir = create_session(home, { title: "Client-ready rule" }).dir;
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

function url_of(repo: string, number: number): string {
    return `https://github.com/acme/${repo}/pull/${number}`;
}

function pull(repo: string, number: number, state: PrState, title: string): PullRequest {
    return {
        number, url: url_of(repo, number), author: "skad", state, head: "abc", checks: "green",
        approval_check: "pending", approvals: { required: ["peer"], peer: [], owner: false },
        threads: { bots_open: 0, humans_open: 0, resolved: 0 }, review: "none",
        bot_reviewed_head: null, queue: "none", last_activity: "2026-11-24T10:00:00Z", title,
    };
}

function session(): Session {
    const read = read_session(home, dir);
    if (!read.ok) {
        throw new Error(read.error);
    }
    return read.summary.session;
}

/** Applies `change` to the session file. */
function edit(change: (session: Session) => Session | void): void {
    const read = read_session(home, dir);
    if (!read.ok) {
        throw new Error(read.error);
    }
    const next = change(read.summary.session) ?? read.summary.session;
    write_session({ ...read.summary, session: next });
}

/** Sets the pull request of `repo` in the current change. */
function set_pr(repo: string, pr: PullRequest): void {
    edit((current) => {
        current.repos[repo] = { path: `~/${repo}`, worktree: repo, changed: true, pr };
    });
}

function sync(): Promise<number> {
    return sync_linear({ home, api: linear, log: () => undefined }, dir, CONFIG);
}

describe("the tickets a session wants", () => {
    it("wants one ticket for a change in one repo, and none before a pull request", () => {
        expect(wanted_tickets(session())).toEqual([]);
        set_pr("backend", pull("backend", 7, "draft", "feat: a price for every card"));
        expect(wanted_tickets(session())).toEqual([{
            kind: "pr", key: url_of("backend", 7), unit: "c1", repo: "backend",
            title: "feat: a price for every card", stage: "draft", child: false, create: true,
            description: [
                `Pull request: ${url_of("backend", 7)}`, "",
                `Spinner session ${session().id}: Client-ready rule`,
            ].join("\n"),
        }]);
    });

    it("wants a parent over the tickets of a change in two repos", () => {
        set_pr("backend", pull("backend", 7, "open", "feat: the rule"));
        set_pr("admin", pull("admin", 3, "draft", "feat: show the rule"));
        const wanted = wanted_tickets(session());
        expect(wanted.map((ticket) => [ticket.kind, ticket.key, ticket.stage, ticket.child]))
            .toEqual([
                // The parent first, and as far as its least advanced pull request.
                ["parent", "c1", "draft", false],
                ["pr", url_of("backend", 7), "open", true],
                ["pr", url_of("admin", 3), "draft", true],
            ]);
        // Without a group the parent is named after the change.
        expect(wanted[0]?.title).toBe("Client-ready rule");
    });

    it("makes a group the unit: its name, its purpose, the changes' pull requests", () => {
        set_pr("backend", pull("backend", 7, "open", "feat: the rule"));
        edit((current) => {
            const second = start_change(current, {
                id: "c2", title: "Show the rule", branch: "feat/show",
                started: "2099-01-01T00:00:00.000Z", keep_current: true,
            });
            const group = { name: "Price rule", purpose: "No card without a price" };
            return assign_group(assign_group(second, "c1", group), "c2", group);
        });
        set_pr("admin", pull("admin", 3, "open", "feat: show the rule"));
        const wanted = wanted_tickets(session());
        expect(wanted.map((ticket) => [ticket.kind, ticket.unit, ticket.title])).toEqual([
            ["parent", "g1", "Price rule"],
            ["pr", "g1", "feat: the rule"],
            ["pr", "g1", "feat: show the rule"],
        ]);
        expect(wanted[0]?.description.split("\n")[0]).toBe("No card without a price");
        expect(wanted[1]?.description.split("\n")[0]).toBe("No card without a price");
    });

    it("makes no ticket after the fact for a pull request that already ended", () => {
        set_pr("backend", pull("backend", 7, "merged", "feat: the rule"));
        expect(wanted_tickets(session())).toEqual([]);
        set_pr("backend", pull("backend", 7, "closed", "feat: the rule"));
        expect(wanted_tickets(session())).toEqual([]);
    });
});

describe("the sync with Linear", () => {
    it("makes one ticket, links the pull request, and then sends nothing", async () => {
        set_pr("backend", pull("backend", 7, "draft", "feat: the rule"));
        expect(await sync()).toBe(1);
        expect(linear.board()).toEqual(["GKA-1 In Progress [l-backend] feat: the rule"]);
        expect(linear.links).toEqual([["GKA-1", url_of("backend", 7)]]);
        expect(linear.issues.get("i1")?.input.assignee_id).toBe("user-1");
        const ticket = session().linear?.prs[url_of("backend", 7)];
        expect(ticket).toMatchObject({ identifier: "GKA-1", state: "In Progress", parent: null });
        // Nothing moved: the next round asks Linear nothing at all.
        linear.calls = [];
        expect(await sync()).toBe(0);
        expect(linear.calls).toEqual([]);
        expect(linear_work(session(), CONFIG)).toEqual([]);
    });

    it("moves the ticket as the pull request opens and merges; a done one stays", async () => {
        set_pr("backend", pull("backend", 7, "draft", "feat: the rule"));
        await sync();
        set_pr("backend", pull("backend", 7, "open", "feat: the rule, with tests"));
        expect(await sync()).toBe(1);
        expect(linear.board()).toEqual([
            "GKA-1 In Review [l-backend] feat: the rule, with tests",
        ]);
        set_pr("backend", pull("backend", 7, "merged", "feat: the rule, with tests"));
        await sync();
        expect(linear.named("GKA-1").state.name).toBe("In Dev Env");
        // A person marks it done; a later change of the title does not pull it back.
        linear.named("GKA-1").state = { name: "Done", type: "completed" };
        set_pr("backend", pull("backend", 7, "merged", "feat: the rule (renamed)"));
        await sync();
        expect(linear.named("GKA-1").state.name).toBe("Done");
        expect(session().linear?.prs[url_of("backend", 7)]?.state).toBe("Done");
    });

    it("puts the tickets of two repos under a parent, with a label it makes when missing",
        async () => {
            set_pr("backend", pull("backend", 7, "open", "feat: the rule"));
            set_pr("admin", pull("admin", 3, "draft", "feat: show the rule"));
            expect(await sync()).toBe(3);
            expect(linear.board()).toEqual([
                "GKA-1 In Progress Client-ready rule",
                "GKA-2 In Review ^GKA-1 [l-backend] feat: the rule",
                "GKA-3 In Progress ^GKA-1 [l-frontend] feat: show the rule",
            ]);
            // `Frontend` was not a label of the team.
            expect(linear.calls.filter((call) => call === "create_label")).toHaveLength(1);
            expect(session().linear?.parents["c1"]?.identifier).toBe("GKA-1");
            // Both merge: the children, then the parent, are in the dev environment.
            set_pr("backend", pull("backend", 7, "merged", "feat: the rule"));
            set_pr("admin", pull("admin", 3, "merged", "feat: show the rule"));
            await sync();
            expect(linear.board().map((line) => line.split(" ").slice(0, 4).join(" "))).toEqual([
                "GKA-1 In Dev Env", "GKA-2 In Dev Env", "GKA-3 In Dev Env",
            ]);
            linear.calls = [];
            expect(await sync()).toBe(0);
            expect(linear.calls).toEqual([]);
        });

    it("gives a single ticket a parent when its change gets a second pull request", async () => {
        set_pr("backend", pull("backend", 7, "open", "feat: the rule"));
        await sync();
        expect(linear.board()).toHaveLength(1);
        set_pr("admin", pull("admin", 3, "open", "feat: show the rule"));
        await sync();
        expect(linear.board()).toEqual([
            "GKA-1 In Review ^GKA-2 [l-backend] feat: the rule",
            "GKA-2 In Review Client-ready rule",
            "GKA-3 In Review ^GKA-2 [l-frontend] feat: show the rule",
        ]);
    });

    it("closes the ticket of a dropped pull request, never one it has no ticket for", async () => {
        set_pr("backend", pull("backend", 7, "open", "feat: the rule"));
        await sync();
        set_pr("backend", pull("backend", 7, "closed", "feat: the rule"));
        expect(await sync()).toBe(1);
        expect(linear.named("GKA-1").state.name).toBe("Canceled");
        linear.calls = [];
        expect(await sync()).toBe(0);
        expect(linear.calls).toEqual([]);
        // The pull request is opened again: the daemon closed the ticket, so it may open it.
        set_pr("backend", pull("backend", 7, "open", "feat: the rule"));
        await sync();
        expect(linear.named("GKA-1").state.name).toBe("In Review");
    });

    it("closes a held group's open tickets and its parent, and opens them on resume", async () => {
        const group = { name: "Price rule", purpose: "No card without a price" };
        const hold = { by: "operator", reason: "other work first", at: "2026-11-24T12:00:00Z" };
        set_pr("backend", pull("backend", 7, "open", "feat: the rule"));
        set_pr("admin", pull("admin", 3, "draft", "feat: show the rule"));
        edit((current) => assign_group(current, "c1", group));
        await sync();
        set_pr("admin", pull("admin", 3, "merged", "feat: show the rule"));
        await sync();
        const states = () => linear.board().map((line) => line.split(" ^")[0]?.split(" [")[0]);
        expect(states()).toEqual([
            "GKA-1 In Review Price rule", "GKA-2 In Review", "GKA-3 In Dev Env",
        ]);
        edit((current) => hold_group(current, "g1", hold));
        await sync();
        // The merged ticket stays merged; the open one and the parent are closed.
        expect(states()).toEqual([
            "GKA-1 Canceled Price rule", "GKA-2 Canceled", "GKA-3 In Dev Env",
        ]);
        linear.calls = [];
        expect(await sync()).toBe(0);
        expect(linear.calls).toEqual([]);
        edit((current) => hold_group(current, "g1", null));
        await sync();
        expect(states()).toEqual([
            "GKA-1 In Review Price rule", "GKA-2 In Review", "GKA-3 In Dev Env",
        ]);
    });

    it("never closes an adopted ticket for a hold or a dropped pull request", async () => {
        const made = await linear.create_issue({
            team_id: "team-1", title: "[Bug] Cards show without a price", description: "by Ana",
            state_id: "s-todo", assignee_id: "user-2", label_ids: [], parent_id: null,
        });
        linear.linked.set(url_of("backend", 7), made.id);
        set_pr("backend", pull("backend", 7, "open", "fix: no card without a price"));
        await sync();
        set_pr("backend", pull("backend", 7, "closed", "fix: no card without a price"));
        linear.calls = [];
        await sync();
        // Another pull request, or another person, may still carry that ticket.
        expect(linear.calls).not.toContain("update_issue");
        expect(linear.named("GKA-1").state.name).toBe("In Review");
        linear.calls = [];
        expect(await sync()).toBe(0);
        expect(linear.calls).toEqual([]);
    });

    it("adopts the ticket Linear already links, and leaves its words alone", async () => {
        const made = await linear.create_issue({
            team_id: "team-1", title: "[Bug] Cards show without a price", description: "by Ana",
            state_id: "s-todo", assignee_id: "user-2", label_ids: [], parent_id: null,
        });
        linear.linked.set(url_of("backend", 7), made.id);
        set_pr("backend", pull("backend", 7, "open", "fix: no card without a price"));
        linear.calls = [];
        expect(await sync()).toBe(1);
        expect(linear.calls).not.toContain("create_issue");
        expect(linear.board()).toEqual(["GKA-1 In Review [Bug] Cards show without a price"]);
        expect(session().linear?.prs[url_of("backend", 7)]).toMatchObject({
            identifier: "GKA-1", adopted: true, title: "[Bug] Cards show without a price",
        });
        linear.calls = [];
        expect(await sync()).toBe(0);
        expect(linear.calls).toEqual([]);
    });

    it("does not make a ticket twice when the attach fails after the create", async () => {
        set_pr("backend", pull("backend", 7, "open", "feat: the rule"));
        linear.link_failures = 2;
        await expect(sync()).rejects.toThrow("rate limited");
        // The ticket is made and recorded, and the pull request is not attached yet.
        expect(linear.board()).toHaveLength(1);
        expect(linear.links).toEqual([]);
        expect(session().linear?.prs[url_of("backend", 7)]?.unlinked).toBe(true);
        // The next round attaches it and makes nothing.
        await sync();
        expect(linear.board()).toHaveLength(1);
        expect(linear.links).toEqual([["GKA-1", url_of("backend", 7)]]);
        expect(session().linear?.prs[url_of("backend", 7)]?.unlinked).toBeUndefined();
        linear.calls = [];
        expect(await sync()).toBe(0);
        expect(linear.calls).toEqual([]);
    });
});

describe("the configuration and the client", () => {
    it("is off without a team, and fills the default state names", () => {
        expect(pipeline_config_from_spec({ pipeline: {} }).linear).toBeUndefined();
        expect(pipeline_config_from_spec({ pipeline: { linear: { labels: {} } } }).linear)
            .toBeUndefined();
        const labels = { backend: "Backend", web: 3 };
        const block = { team: "GKA", labels, states: { merged: "Done" } };
        expect(pipeline_config_from_spec({ pipeline: { linear: block } }).linear).toEqual({
            team: "GKA",
            labels: { backend: "Backend" },
            states: {
                draft: "In Progress", open: "In Review", merged: "Done", closed: "Canceled",
                hold: "Canceled",
            },
        });
    });

    it("sends the key as the authorization header and maps an issue", async () => {
        const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
        const node = {
            id: "i9", identifier: "GKA-9", url: "https://linear.app/x/GKA-9", title: "T",
            state: { name: "In Review", type: "started" }, parent: { identifier: "GKA-1" },
        };
        const client = linear_client("lin_test_key", (url, init) => {
            requests.push({ url, headers: init.headers, body: init.body });
            const data = init.body.includes("issueCreate")
                ? { issueCreate: { success: true, issue: node } }
                : { attachmentsForURL: { nodes: [] } };
            return Promise.resolve({
                ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data })),
            });
        });
        expect(await client.issue_for_url(url_of("backend", 7))).toBeNull();
        const made = await client.create_issue({
            team_id: "team-1", title: "T", description: "D", state_id: "s-review",
            assignee_id: "user-1", label_ids: ["l-backend"], parent_id: "i1",
        });
        expect(made).toMatchObject({ identifier: "GKA-9", parent: "GKA-1" });
        expect(requests.map((request) => request.url)).toEqual([LINEAR_URL, LINEAR_URL]);
        expect(requests[1]?.headers["authorization"]).toBe("lin_test_key");
        const sent = JSON.parse(requests[1]?.body ?? "{}") as { variables: { input: object } };
        expect(sent.variables.input).toEqual({
            teamId: "team-1", title: "T", description: "D", stateId: "s-review",
            assigneeId: "user-1", labelIds: ["l-backend"], parentId: "i1",
        });
        // Linear's own message is the error; a deleted issue reads as none.
        const failing = linear_client("k", () => Promise.resolve({
            ok: false, status: 400,
            text: () => Promise.resolve('{"errors":[{"message":"Entity not found: Issue"}]}'),
        }));
        expect(await failing.issue("gone")).toBeNull();
        await expect(failing.team("GKA")).rejects.toThrow("Linear: Entity not found: Issue");
    });
});
