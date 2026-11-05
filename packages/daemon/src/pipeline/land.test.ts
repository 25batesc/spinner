// Goal: prove the last three commands without GitHub or Docker. `approve`: the preview shows
// head, diff stat and open threads with the blocker, the review goes through the guard, the
// approval is recorded per head so a push asks again. `land`: gates refuse a PR that is not
// ready; a ready PR is enqueued with its head; a pop-out runs the rebase in the worktree,
// pushes with --force-with-lease and re-enqueues with the new head; a merge ends the job with
// a notification; a conflict stops it with the paths. `reset`: refused with an open PR; with
// everything merged it makes the next branch per worktree, clears the facts, and moves the
// Log and the threads under the round's history. Method: fake gh/git runners scripted per
// call, a temporary SPINNER_HOME, the scrubbed fixtures.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { beforeEach, describe, expect, it } from "vitest";
import type { PipelineConfig, PullRequest, Session, SessionSummary } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { create_session, read_session, write_session } from "../store/session-store.js";
import { approve_blocker, approve_prs, approve_view } from "./approve.js";
import { pipeline_config_from_spec } from "./config.js";
import type { GhRunner, PrResponse } from "./github.js";
import type { GithubWriter } from "./github-write.js";
import { land_blocker, land_prs } from "./land.js";
import { DIRTY_PATHS_SHOWN_MAX, next_branch, reset_blocker, reset_session } from "./reset.js";
import { SESSION_SPEC } from "../stack/runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "..", "..", "test", "fixtures", "github");

function load(name: string): PrResponse {
    return JSON.parse(readFileSync(resolve(fixtures, `${name}.json`), "utf8")) as PrResponse;
}

type PrPatch = Partial<PrResponse["data"]["repository"]["pullRequest"]>;

function variant(base: PrResponse, patch: PrPatch): PrResponse {
    const node = base.data.repository.pullRequest;
    return { data: { repository: { pullRequest: { ...node, ...patch } } } } as PrResponse;
}

function config_with(extra: Record<string, unknown>): PipelineConfig {
    return pipeline_config_from_spec({
        pipeline: {
            github: {
                bot_logins: ["devin-ai-integration[bot]"],
                write_repos: ["acme/backend"],
                owner_login: "owner-1",
                merge_queue: "github",
                approval_check: "Independent Approval",
                ...extra,
            },
        },
    });
}

/** The approving fixture with its approval check flipped to passed and no open thread. */
function ready_response(): PrResponse {
    const base = load("pr-approving");
    const node = base.data.repository.pullRequest;
    const commit = node.commits.nodes[0]?.commit;
    if (commit?.statusCheckRollup === undefined || commit.statusCheckRollup === null) {
        throw new Error("fixture has no rollup");
    }
    const contexts = commit.statusCheckRollup.contexts.nodes.map((check) =>
        check.__typename === "StatusContext" && /independent approval/i.test(check.context)
            ? { ...check, state: "SUCCESS" }
            : check,
    );
    return variant(base, {
        reviewThreads: { totalCount: 0, nodes: [] },
        commits: {
            nodes: [
                {
                    commit: {
                        ...commit,
                        statusCheckRollup: {
                            ...commit.statusCheckRollup,
                            contexts: { nodes: contexts },
                        },
                    },
                },
            ],
        },
    });
}

/** `gh` and `git` fakes whose GraphQL answers come from a queue, oldest first. */
class Fake implements GithubWriter {
    responses: PrResponse[] = [];
    writes: string[][] = [];
    git_calls: { cwd: string; args: string[] }[] = [];
    rebase_fails = false;
    /** What `git status --porcelain` prints; empty is a clean worktree. */
    status = "";
    diff = { additions: 12, deletions: 3, changedFiles: 2 };
    reads: GhRunner = async (args) => {
        if (args[0] === "api" && args[1] === "user") {
            return "owner-1\n";
        }
        const is_view = args[0] === "pr" && args[1] === "view";
        if (is_view && args.includes("additions,deletions,changedFiles")) {
            return JSON.stringify(this.diff);
        }
        if (is_view && args.includes(".id")) {
            return "PR_node_1\n";
        }
        if (args[0] === "api" && args[1] === "graphql") {
            const next = this.responses.length > 1 ? this.responses.shift() : this.responses[0];
            if (next === undefined) {
                throw new Error("fake gh ran out of responses");
            }
            return JSON.stringify(next);
        }
        throw new Error(`fake gh read: ${args.join(" ")}`);
    };
    gh: GhRunner = async (args) => {
        this.writes.push(args);
        return "";
    };
    git = async (cwd: string, args: string[]): Promise<string> => {
        this.git_calls.push({ cwd, args });
        if (args[0] === "status") {
            return this.status;
        }
        if (args[0] === "rebase" && args[1] !== "--abort" && this.rebase_fails) {
            throw new Error("CONFLICT (content): Merge conflict in src/a.ts");
        }
        if (args[0] === "diff") {
            return "src/a.ts\nmigrations/0002.sql\n";
        }
        if (args[0] === "rev-parse") {
            return "feedfacefeedfacefeedfacefeedfacefeedface\n";
        }
        return "";
    };
}

let home: SpinnerHome;
let fake: Fake;

function pr_with(patch: Partial<PullRequest>): PullRequest {
    return {
        number: 4812,
        url: "https://github.com/acme/backend/pull/4812",
        title: "feat: example",
        author: "devin-ai-integration",
        state: "open",
        head: "c46867ff747b5d774b3073ead5ebc54c939bdfb4",
        checks: "green",
        approval_check: "pass",
        approvals: { required: ["peer", "owner"], peer: ["human-1"], owner: false },
        threads: { bots_open: 0, humans_open: 0, resolved: 2 },
        review: "approved",
        bot_reviewed_head: "c46867ff747b5d774b3073ead5ebc54c939bdfb4",
        queue: "none",
        last_activity: "2026-10-27T00:00:00Z",
        ...patch,
    };
}

function session_with(pr: PullRequest | null, worktree = true): SessionSummary {
    const created = create_session(home, { title: "Land" });
    const entry = { path: "~/code/backend", changed: pr !== null, pr };
    if (worktree) {
        mkdirSync(join(created.path, "worktrees", "backend"), { recursive: true });
    }
    const session: Session = {
        ...created.session,
        base: "develop",
        repos: { backend: worktree ? { ...entry, worktree: "worktrees/backend" } : entry },
        pipeline: { verified_locally: true, verified_heads: {}, slack_post: null },
    };
    write_session({ ...created, session });
    writeFileSync(join(created.path, "MISSION.md"), "# s\n\n## Goal\nG\n\n## Log\n- 10:00 a: b\n");
    const read = read_session(home, created.dir);
    if (!read.ok) {
        throw new Error(read.error);
    }
    return read.summary;
}

function read_yaml(dir: string): Session {
    return parse(readFileSync(join(home.sessions, dir, "session.yaml"), "utf8")) as Session;
}

beforeEach(() => {
    home = resolve_home({ SPINNER_HOME: join(mkdtempSync(join(tmpdir(), "spinner-land-")), "h") });
    fake = new Fake();
});

describe("approve", () => {
    it("shows head, diff stat and open threads, and names the blocker", async () => {
        const threads = { bots_open: 1, humans_open: 0, resolved: 0 };
        const summary = session_with(pr_with({ threads }));
        const view = await approve_view(summary, { gh: fake.reads, config: config_with({}) });
        expect(view.prs[0]).toMatchObject({
            repo: "backend",
            head: "c46867ff747b5d774b3073ead5ebc54c939bdfb4",
            diff: { files: 2, additions: 12, deletions: 3 },
            open_threads: 1,
            approved: false,
            blocked: "1 open thread",
        });
        const session = summary.session;
        const own = { repo: "backend", ...pr_with({ author: "owner-1" }) };
        expect(approve_blocker(own, session, "owner-1")).toMatch(/you are the author/);
        expect(approve_blocker({ repo: "backend", ...pr_with({}) }, session, "owner-1")).toBeNull();
    });

    it("submits the review through the guard and records the head; a push asks again", async () => {
        const summary = session_with(pr_with({}));
        const config = config_with({});
        fake.responses = [ready_response()];
        const log: string[] = [];
        const result = await approve_prs(home, summary, { confirm: true }, {
            gh: fake.reads,
            writer: fake,
            config,
            log: (line) => log.push(line),
        });
        expect(result.approved).toEqual(["backend#4812"]);
        expect(fake.writes).toEqual([
            ["pr", "review", "https://github.com/acme/backend/pull/4812", "--approve"],
        ]);
        expect(log[0]).toMatch(/backend#4812 @ c46867f · 2 files, \+12 -3 · 0 open threads/);
        const session = read_yaml(summary.dir);
        expect(session.pipeline?.approved_heads).toEqual({
            backend: "c46867ff747b5d774b3073ead5ebc54c939bdfb4",
        });
        const after = read_session(home, summary.dir);
        if (!after.ok) {
            throw new Error(after.error);
        }
        const again = await approve_view(after.summary, { gh: fake.reads, config });
        expect(again.prs[0]?.blocked).toMatch(/already approved at c46867f/);
        const pushed = { ...after.summary.session };
        const entry = pushed.repos["backend"];
        if (entry?.pr) {
            entry.pr = { ...entry.pr, head: "0000000000000000000000000000000000000000" };
        }
        const moved = { ...after.summary, session: pushed };
        const after_push = await approve_view(moved, { gh: fake.reads, config });
        expect(after_push.prs[0]?.blocked).toBeNull();
    });

    it("refuses when the repo is not allow-listed", async () => {
        const summary = session_with(pr_with({}));
        const config = config_with({ write_repos: [] });
        await expect(
            approve_prs(home, summary, { confirm: true }, { gh: fake.reads, writer: fake, config }),
        ).rejects.toThrow(/refusing GitHub write to acme\/backend/);
        expect(fake.writes).toEqual([]);
    });
});

describe("land", () => {
    it("gates on checks, threads and the approval check", () => {
        const config = config_with({ approval_check: "Independent Approval" });
        expect(land_blocker(pr_with({ checks: "pending" }), config)).toBe("checks are pending");
        const threads = { bots_open: 0, humans_open: 2, resolved: 0 };
        expect(land_blocker(pr_with({ threads }), config)).toBe("2 open threads");
        expect(land_blocker(pr_with({ approval_check: "pending" }), config)).toBe(
            "Independent Approval is pending",
        );
        const no_check = config_with({ approval_check: undefined });
        expect(land_blocker(pr_with({ approval_check: "pending" }), no_check)).toBeNull();
        expect(land_blocker(pr_with({ queue: "queued" }), config)).toBe("already in the queue");
    });

    it("enqueues with the head, rebases on pop-out, re-enqueues, notifies on merge", async () => {
        const summary = session_with(pr_with({}));
        const config = config_with({});
        const green = ready_response();
        const node = green.data.repository.pullRequest;
        const popped = variant(green, {
            mergeQueueEntry: null,
            timelineItems: {
                nodes: [
                    { __typename: "AddedToMergeQueueEvent", createdAt: "2026-10-27T01:00:00Z" },
                    {
                        __typename: "RemovedFromMergeQueueEvent",
                        createdAt: "2026-10-27T01:10:00Z",
                        reason: "CI_FAILED",
                        beforeCommit: { oid: node.headRefOid },
                    },
                ],
            },
        });
        const rebased = variant(green, { headRefOid: "feedfacefeedfacefeedfacefeedfacefeedface" });
        const merged = variant(rebased, { state: "MERGED" });
        // refresh_facts, then the watch: popped → (wait_green reads once) → merged.
        fake.responses = [green, popped, rebased, merged, merged];
        const banners: string[] = [];
        const sessions: (string | null)[] = [];
        const log: string[] = [];
        const result = await land_prs(home, summary, {}, {
            gh: fake.reads,
            writer: fake,
            config,
            log: (line) => log.push(line),
            notify: async (_t, message, session) => {
                banners.push(message);
                sessions.push(session);
            },
            sleep: async () => {},
            poll_ms: 1,
        });
        expect(result.merged).toEqual(["backend#4812"]);
        const enqueues = fake.writes.filter((args) => args.join(" ").includes("enqueuePullReq"));
        expect(enqueues).toHaveLength(2);
        expect(enqueues[0]).toContain(`head=${node.headRefOid}`);
        expect(enqueues[1]).toContain("head=feedfacefeedfacefeedfacefeedfacefeedface");
        const push = fake.writes.find((args) => args[0] === "push");
        expect(push).toBeUndefined();
        const pushes = fake.git_calls.filter((call) => call.args[0] === "push");
        expect(pushes).toHaveLength(1);
        const branch = summary.session.branch;
        expect(pushes[0]?.args).toEqual(["push", "--force-with-lease", "origin", branch]);
        expect(pushes[0]?.cwd).toBe(join(summary.path, "worktrees", "backend"));
        const rebase = fake.git_calls.find((call) => call.args[0] === "rebase");
        expect(rebase?.args).toEqual(["rebase", "origin/develop"]);
        expect(banners).toEqual([`${summary.session.id}: backend#4812 merged`]);
        expect(sessions).toEqual([summary.dir]);
        expect(log.some((line) => line.includes("popped out of the queue (CI_FAILED)"))).toBe(true);
        expect(read_yaml(summary.dir).stage).toBe("merged");
        const mission = readFileSync(join(summary.path, "MISSION.md"), "utf8");
        expect(mission).toMatch(/spinner: land: backend#4812 merged/);
    });

    it("stops on a rebase conflict with the paths and aborts the rebase", async () => {
        const summary = session_with(pr_with({}));
        const green = ready_response();
        const node = green.data.repository.pullRequest;
        const popped = variant(green, {
            mergeQueueEntry: null,
            timelineItems: {
                nodes: [
                    {
                        __typename: "RemovedFromMergeQueueEvent",
                        createdAt: "2026-10-27T01:10:00Z",
                        reason: "conflicts",
                        beforeCommit: { oid: node.headRefOid },
                    },
                ],
            },
        });
        fake.responses = [green, popped, popped];
        fake.rebase_fails = true;
        await expect(
            land_prs(home, summary, {}, {
                gh: fake.reads,
                writer: fake,
                config: config_with({}),
                sleep: async () => {},
            }),
        ).rejects.toThrow(/conflicts in src\/a.ts, migrations\/0002.sql/);
        expect(fake.git_calls.some((call) => call.args.join(" ") === "rebase --abort")).toBe(true);
        expect(fake.git_calls.filter((call) => call.args[0] === "push")).toEqual([]);
        const mission = readFileSync(join(summary.path, "MISSION.md"), "utf8");
        expect(mission).toMatch(/rebase conflict in src\/a.ts/);
    });

    it("merges directly without a queue and refuses a PR that is not ready", async () => {
        const summary = session_with(pr_with({}));
        const config = config_with({ merge_queue: "none" });
        const green = ready_response();
        fake.responses = [green, variant(green, { state: "MERGED" })];
        const deps = { gh: fake.reads, writer: fake, config, sleep: async () => {} };
        await land_prs(home, summary, {}, deps);
        const url = "https://github.com/acme/backend/pull/4812";
        expect(fake.writes[0]?.slice(0, 4)).toEqual(["pr", "merge", url, "--merge"]);

        const not_ready = session_with(pr_with({}));
        fake.responses = [load("pr-fixing")];
        fake.writes = [];
        await expect(land_prs(home, not_ready, {}, deps)).rejects.toThrow(
            /backend#4825 cannot land: 2 open threads/,
        );
        expect(fake.writes).toEqual([]);
    });
});

describe("reset", () => {
    it("is refused with an open PR and names the next branch", () => {
        const open = session_with(pr_with({}));
        expect(reset_blocker(open.session)).toBe("open PR: backend#4812; land or close first");
        expect(next_branch("feat/refunds", 2)).toBe("feat/refunds-r2");
        expect(next_branch("feat/refunds-r2", 3)).toBe("feat/refunds-r3");
    });

    it("starts the next round: new branch per worktree, facts cleared, history kept", async () => {
        const summary = session_with(pr_with({ state: "merged" }));
        mkdirSync(join(summary.path, "threads"), { recursive: true });
        writeFileSync(join(summary.path, "threads", "backend-4825.md"), "# old\n");
        const log: string[] = [];
        const result = await reset_session(home, summary, {}, {
            git: fake.git,
            config: config_with({}),
            log: (line) => log.push(line),
        });
        expect(result.session.branch).toBe(`${summary.session.branch}-r2`);
        expect(result.session.round).toBe(2);
        expect(result.session.repos["backend"]?.pr).toBeNull();
        expect(result.session.repos["backend"]?.changed).toBe(false);
        expect(result.session.pipeline?.verified_locally).toBe(false);
        expect(result.session.stage).toBe("planned");
        const checkout = fake.git_calls.find((call) => call.args[0] === "checkout");
        const next = `${summary.session.branch}-r2`;
        expect(checkout?.args).toEqual(["checkout", "-b", next, "origin/develop"]);
        expect(existsSync(join(summary.path, "threads", "backend-4825.md"))).toBe(false);
        const moved = join(summary.path, "artifacts", "round-1", "threads", "backend-4825.md");
        expect(existsSync(moved)).toBe(true);
        const mission = readFileSync(join(summary.path, "MISSION.md"), "utf8");
        expect(mission).toContain("## Previous rounds\n### Round 1 · ");
        expect(mission).toContain("backend#4812 (merged)");
        expect(mission).toContain("- 10:00 a: b");
        expect(mission.indexOf("## Log")).toBeLessThan(mission.indexOf("## Previous rounds"));
    });

    it("refuses a dirty worktree and names its paths, the first ten and a count", async () => {
        const summary = session_with(pr_with({ state: "merged" }));
        const paths = Array.from({ length: 12 }, (_, index) => ` M src/f${index + 1}.ts`);
        fake.status = ["?? node_modules", ...paths].join("\n") + "\n";
        const deps = { git: fake.git, config: config_with({}) };
        const error = await reset_session(home, summary, {}, deps).then(
            () => null,
            (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)),
        );
        expect(DIRTY_PATHS_SHOWN_MAX).toBe(10);
        expect(error).toMatch(/: uncommitted changes \(\?\? node_modules, {2}M src\/f1\.ts, /);
        expect(error).toContain(" M src/f9.ts, and 3 more); commit or stash before reset");
        expect(error).not.toContain("src/f10.ts");
        fake.status = " M src/one.ts\n";
        const one = await reset_session(home, summary, {}, deps).catch((reason: Error) => reason);
        expect(one).toBeInstanceOf(Error);
        expect((one as Error).message).toMatch(/\( M src\/one\.ts\); commit or stash/);
        expect(fake.git_calls.some((call) => call.args[0] === "checkout")).toBe(false);
    });

    // With the stack down, a reset marks the database stale for the next `up`; a spec without a
    // database block has nothing to mark and says so.
    it("marks the database stale only when the spec has a database block", async () => {
        const spec = ["name: p", "base: develop", "repos:", "  backend: { path: ~/code/backend }"];
        for (const database of [false, true]) {
            const summary = session_with(pr_with({ state: "merged" }));
            mkdirSync(join(summary.path, "stack"), { recursive: true });
            const lines = database
                ? [...spec, "services: {}", "database: { mode: template }"]
                : [...spec, "services: {}"];
            writeFileSync(join(summary.path, SESSION_SPEC), `${lines.join("\n")}\n`);
            const log: string[] = [];
            const result = await reset_session(home, summary, {}, {
                git: fake.git,
                config: config_with({}),
                stack: true,
                log: (line) => log.push(line),
            });
            expect(result.session.stack.db_stale).toBe(database ? true : undefined);
            expect(log.some((line) => line.includes("re-cloned at the next up"))).toBe(database);
            expect(log.includes("database: none (the spec has no database block)")).toBe(!database);
        }
    });

    it("records each round in session.yaml rounds and keeps the design block (2.44)", async () => {
        const summary = session_with(pr_with({ state: "merged" }));
        const approval = {
            path: "docs/designs/refunds.md",
            repo: "backend",
            sha256: "f".repeat(64),
            at: "2026-10-26T11:00:00Z",
            blockers: 0,
            round: 1,
        };
        const design = {
            track: "design" as const,
            stage: "approved" as const,
            doc: "docs/designs/refunds.md",
            repo: "backend",
            approved: approval,
            approvals: [approval],
        };
        write_session({ ...summary, session: { ...summary.session, design } });
        const deps = { git: fake.git, config: config_with({}) };
        const first_end = new Date("2026-10-27T12:00:00Z");
        const first = await reset_session(home, read_ok(summary.dir), {}, {
            ...deps,
            now: () => first_end,
        });
        expect(first.session.rounds).toEqual([
            {
                round: 1,
                branch: summary.session.branch,
                prs: [
                    {
                        repo: "backend",
                        number: 4812,
                        url: "https://github.com/acme/backend/pull/4812",
                        state: "merged",
                        merged_at: "2026-10-27T00:00:00Z",
                    },
                ],
                started: summary.session.created,
                ended: first_end.toISOString(),
            },
        ]);
        expect(first.session.design?.doc).toBe(design.doc);
        expect(first.session.design?.approved).toEqual(approval);
        expect(first.session.design?.approvals).toEqual([approval]);
        // Round 2 ends with a closed PR; its record starts where round 1 ended.
        const round_two = read_ok(summary.dir);
        const backend = round_two.session.repos["backend"];
        if (backend !== undefined) {
            backend.pr = pr_with({ number: 4900, state: "closed" });
        }
        write_session(round_two);
        const second = await reset_session(home, read_ok(summary.dir), {}, {
            ...deps,
            now: () => new Date("2026-10-28T12:00:00Z"),
        });
        expect(second.session.rounds).toHaveLength(2);
        expect(second.session.rounds?.[1]).toMatchObject({
            round: 2,
            branch: `${summary.session.branch}-r2`,
            started: first_end.toISOString(),
            prs: [{ number: 4900, state: "closed", merged_at: null }],
        });
        expect(second.session.design?.approvals).toEqual([approval]);
    });
});

function read_ok(dir: string): SessionSummary {
    const read = read_session(home, dir);
    if (!read.ok) {
        throw new Error(read.error);
    }
    return read.summary;
}
