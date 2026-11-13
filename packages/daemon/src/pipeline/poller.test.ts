// Goal: prove the board's end-to-end behaviour without GitHub: `adopt_prs` creates a session
// from PR URLs, `poll_once` rewrites session.yaml and notifies only on a transition, a push
// clears the verify tick, and a merge-queue pop-out notifies within one round. Method: a fake
// `gh` runner serves the scrubbed fixtures (and mutated copies of them) from memory; a
// capturing notifier records banners; everything runs against a temporary SPINNER_HOME with
// a temporary project spec whose one repo is a real clone of a bare origin, so adopt with a
// project can check the PR branches out.
import assert from "node:assert/strict";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { beforeEach, describe, expect, it } from "vitest";
import type { Session } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { run_ok } from "../stack/shell.js";
import { read_session, write_session } from "../store/session-store.js";
import { adopt_prs, attach_adopted } from "./adopt.js";
import { start_change } from "./changes.js";
import { load_pipeline_config } from "./config.js";
import type { GhRunner, PrResponse } from "./github.js";
import { poll_once } from "./poller.js";
import { verify_session } from "./verify.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "..", "..", "test", "fixtures", "github");

function load(name: string): PrResponse {
    return JSON.parse(readFileSync(resolve(fixtures, `${name}.json`), "utf8")) as PrResponse;
}

const SPEC = [
    "name: acme",
    "base: develop",
    "repos:",
    "  backend: { path: ../code/backend }",
    "services: {}",
    "pipeline:",
    "  github:",
    "    bot_logins: [\"devin-ai-integration[bot]\", \"sonarqubecloud[bot]\"]",
    '    approval_check: "Independent Approval"',
    "    approval_policy: { human_author: [peer], bot_author: [peer, owner] }",
    "    merge_queue: github",
    "",
].join("\n");

/** A fake `gh`: answers `api user` and serves one response per PR number. */
class FakeGh {
    responses = new Map<number, PrResponse>();
    calls: string[][] = [];
    runner: GhRunner = async (args) => {
        this.calls.push(args);
        if (args[0] === "api" && args[1] === "user") {
            return "owner-1\n";
        }
        const number_arg = args.find((arg) => arg.startsWith("number="));
        const number = Number.parseInt(number_arg?.slice("number=".length) ?? "0", 10);
        const response = this.responses.get(number);
        if (response === undefined) {
            throw new Error(`fake gh has no PR #${number}`);
        }
        return JSON.stringify(response);
    };
}

let root: string;
let home: SpinnerHome;
let project: string;
let gh: FakeGh;
let banners: string[];
/** The session directory of each banner, in the same order. */
let banner_sessions: (string | null)[];
const notify = async (_title: string, message: string, session: string | null): Promise<void> => {
    banners.push(message);
    banner_sessions.push(session);
};

function read_yaml(dir: string): Session {
    return parse(readFileSync(join(home.sessions, dir, "session.yaml"), "utf8")) as Session;
}

/** The fixture at a fresh head: the queue rejected it and it is still the head. */
function popped_variant(base: PrResponse): PrResponse {
    const node = base.data.repository.pullRequest;
    const removal = node.timelineItems.nodes[1];
    const rejected =
        removal?.__typename === "RemovedFromMergeQueueEvent"
            ? removal.beforeCommit?.oid
            : undefined;
    if (rejected === undefined) {
        throw new Error("fixture has no removal event");
    }
    return {
        data: {
            repository: {
                pullRequest: {
                    ...node,
                    state: "OPEN",
                    headRefOid: rejected,
                    mergeQueueEntry: null,
                    timelineItems: { nodes: node.timelineItems.nodes.slice(0, 2) },
                },
            },
        },
    };
}

function queued_variant(base: PrResponse): PrResponse {
    const popped = popped_variant(base);
    const node = popped.data.repository.pullRequest;
    return {
        data: {
            repository: {
                pullRequest: {
                    ...node,
                    mergeQueueEntry: { state: "QUEUED", position: 1 },
                    timelineItems: { nodes: node.timelineItems.nodes.slice(0, 1) },
                },
            },
        },
    };
}

/**
 * A bare origin with `develop` and the two fixture PR branches, cloned to `<root>/code/backend`
 * (the spec's repo path), so adopt with a project can check a PR branch out.
 */
async function make_backend(root: string): Promise<void> {
    const seed = join(root, "seed");
    await run_ok("git", ["init", "--quiet", "--initial-branch", "develop", seed]);
    await run_ok("git", ["-C", seed, "config", "user.email", "t@example.com"]);
    await run_ok("git", ["-C", seed, "config", "user.name", "t"]);
    writeFileSync(join(seed, "README.md"), "hi\n");
    await run_ok("git", ["-C", seed, "add", "README.md"]);
    await run_ok("git", ["-C", seed, "commit", "--quiet", "-m", "init"]);
    for (const branch of ["devin/example-feature", "feat/example-feature"]) {
        await run_ok("git", ["-C", seed, "branch", branch, "develop"]);
    }
    const origin = join(root, "origin.git");
    await run_ok("git", ["clone", "--quiet", "--bare", seed, origin]);
    await run_ok("git", ["clone", "--quiet", origin, join(root, "code", "backend")]);
}

beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "spinner-board-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home") });
    project = join(root, "acme");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "spinner.yaml"), SPEC);
    await make_backend(root);
    gh = new FakeGh();
    banners = [];
    banner_sessions = [];
});

describe("spinner adopt", () => {
    it("with a project: derives the stage and checks the PR branch out as a worktree", async () => {
        gh.responses.set(4812, load("pr-approving"));
        const lines: string[] = [];
        const summary = await adopt_prs(home, {
            urls: ["https://github.com/acme/backend/pull/4812"],
            project,
            cwd: root,
            gh: gh.runner,
            now: () => new Date("2026-10-27T00:00:00Z"),
            log: (line) => lines.push(line),
        });
        const session = read_yaml(summary.dir);
        expect(session.project).toBe("acme");
        expect(session.branch).toBe("devin/example-feature");
        expect(session.base).toBe("develop");
        expect(session.stage).toBe("verifying");
        expect(session.needs_human).toBe("verify locally (backend#4812)");
        expect(session.repos["backend"]?.pr?.threads.resolved).toBe(2);
        expect(session.repos["backend"]?.worktree).toBe("worktrees/backend");
        expect(session.repos["backend"]?.changed).toBe(true);
        expect(session.stack.state).toBe("down");
        const worktree = join(summary.path, "worktrees", "backend");
        const branch = await run_ok("git", ["-C", worktree, "branch", "--show-current"]);
        expect(branch.trim()).toBe("devin/example-feature");
        expect(lstatSync(join(worktree, ".spinner")).isSymbolicLink()).toBe(true);
        const exclude = join(root, "code", "backend", ".git", "info", "exclude");
        expect(readFileSync(exclude, "utf8")).toMatch(/^\.spinner$/m);
        const clone = join(root, "code", "backend");
        expect(lines).toContain(`branch devin/example-feature created in ${clone}`);
        const mission = readFileSync(join(summary.path, "MISSION.md"), "utf8");
        expect(mission).toContain("Adopted by `spinner adopt`");
        expect(mission).toContain("- https://github.com/acme/backend/pull/4812");
        expect(mission).toContain("operator: session adopted from 1 PR");
    });

    it("without a project: board only, and attach adds the worktree later", async () => {
        gh.responses.set(4812, load("pr-approving"));
        const summary = await adopt_prs(home, {
            urls: ["https://github.com/acme/backend/pull/4812"],
            cwd: root,
            gh: gh.runner,
        });
        const before = read_yaml(summary.dir);
        expect(before.project).toBeUndefined();
        expect(before.repos["backend"]?.worktree).toBeUndefined();
        expect(before.repos["backend"]?.path).toBe("https://github.com/acme/backend");
        expect(existsSync(join(summary.path, "worktrees", "backend"))).toBe(false);

        const attached = await attach_adopted(home, summary, {
            spec_path: join(project, "spinner.yaml"),
            gh: gh.runner,
        });
        const after = read_yaml(attached.dir);
        expect(after.project).toBe("acme");
        expect(after.branch).toBe("devin/example-feature");
        expect(after.repos["backend"]?.worktree).toBe("worktrees/backend");
        expect(after.repos["backend"]?.path).toBe(join(root, "code", "backend"));
        expect(after.repos["backend"]?.pr?.number).toBe(4812);
        expect(after.stack.state).toBe("down");
        const worktree = join(attached.path, "worktrees", "backend");
        const branch = await run_ok("git", ["-C", worktree, "branch", "--show-current"]);
        expect(branch.trim()).toBe("devin/example-feature");
        // Attach again: nothing changes and nothing fails.
        const again = await attach_adopted(home, attached, {
            spec_path: join(project, "spinner.yaml"),
            gh: gh.runner,
        });
        expect(read_yaml(again.dir).repos["backend"]?.worktree).toBe("worktrees/backend");
    });

    it("attach refuses a session that tracks no PR", async () => {
        gh.responses.set(4812, load("pr-approving"));
        const summary = await adopt_prs(home, {
            urls: ["https://github.com/acme/backend/pull/4812"],
            cwd: root,
            gh: gh.runner,
        });
        summary.session.repos = {};
        const input = { spec_path: join(project, "spinner.yaml"), gh: gh.runner };
        await expect(attach_adopted(home, summary, input)).rejects.toThrow(/tracks no PR/);
    });

    it("rejects a URL that is not a pull request", async () => {
        const input = { urls: ["https://github.com/acme/backend/issues/1"], cwd: root, gh: gh.runner };
        await expect(adopt_prs(home, input)).rejects.toThrow(/not a GitHub pull request URL/);
    });
});

describe("poll_once", () => {
    async function adopt(): Promise<string> {
        gh.responses.set(4812, load("pr-approving"));
        const summary = await adopt_prs(home, {
            urls: ["https://github.com/acme/backend/pull/4812"],
            project,
            cwd: root,
            gh: gh.runner,
        });
        return summary.dir;
    }

    it("does not notify when a poll changes nothing", async () => {
        const dir = await adopt();
        const report = await poll_once(home, { gh: gh.runner, notify, cwd: root });
        expect(report.polled).toEqual([dir]);
        expect(report.transitions).toEqual([]);
        expect(report.errors).toEqual([]);
        expect(banners).toEqual([]);
    });

    it("autopilot: a first sight is the baseline; new threads go to the lead once", async () => {
        const dir = await adopt();
        const told: string[] = [];
        let reachable = true;
        const autopilot = {
            enabled: () => true,
            tell: async (session_dir: string, text: string): Promise<boolean> => {
                if (reachable) {
                    told.push(`${session_dir}: ${text}`);
                }
                return reachable;
            },
        };
        const options = { gh: gh.runner, notify, cwd: root, autopilot };
        // First sight of an adopted pull request: what stands is recorded, nothing is sent.
        await poll_once(home, options);
        expect(told).toEqual([]);
        expect(read_yaml(dir).pipeline?.autopilot).toEqual({ red: {}, threads: [] });
        // Two open threads arrive (the fixing fixture). The lead cannot be reached: nothing
        // is recorded, so the next round tells the same facts.
        // The fixture is another pull request (#4825); once its facts are in the session the
        // poller asks for that number.
        gh.responses.set(4812, load("pr-fixing"));
        gh.responses.set(4825, load("pr-fixing"));
        reachable = false;
        await poll_once(home, options);
        expect(read_yaml(dir).pipeline?.autopilot?.threads).toEqual([]);
        reachable = true;
        await poll_once(home, options);
        expect(told).toHaveLength(1);
        expect(told[0]).toContain(`${dir}: Spinner autopilot`);
        expect(told[0]).toMatch(/2 new review thread\(s\) on backend#\d+: T1, T2\./);
        expect(read_yaml(dir).pipeline?.autopilot?.threads).toHaveLength(2);
        // Nothing new: nothing sent. Off (`agents.github: guarded`): nothing sent either.
        await poll_once(home, options);
        expect(told).toHaveLength(1);
        const off = { ...autopilot, enabled: () => false };
        await poll_once(home, { ...options, autopilot: off });
        expect(told).toHaveLength(1);
    });

    it("polls a change that is not checked out and tells the lead how to get to it", async () => {
        const dir = await adopt();
        const told: string[] = [];
        const autopilot = {
            enabled: () => true,
            tell: async (_dir: string, text: string): Promise<boolean> => {
                told.push(text);
                return true;
            },
        };
        const options = { gh: gh.runner, notify, cwd: root, autopilot };
        await poll_once(home, options);
        // The lead starts a second change: the adopted pull request is now a record.
        const read = read_session(home, dir);
        assert.ok(read.ok);
        const first_branch = read.summary.session.branch;
        const second = start_change(read.summary.session, {
            id: "c2",
            title: "Second",
            branch: "feat/second",
            started: "2026-11-12T11:00:00Z",
            keep_current: true,
        });
        write_session({ ...read.summary, session: second });
        gh.responses.set(4812, load("pr-fixing"));
        gh.responses.set(4825, load("pr-fixing"));
        const report = await poll_once(home, options);
        expect(report.polled).toEqual([dir]);
        const after = read_yaml(dir);
        // The top level is still the second change; the record carries the fresh facts.
        expect(after.branch).toBe("feat/second");
        expect(after.repos["backend"]?.pr).toBeNull();
        const record = after.changes?.[0];
        expect(record?.stage).toBe("fixing");
        expect(record?.pipeline?.autopilot?.threads).toHaveLength(2);
        expect(told).toHaveLength(1);
        expect(told[0]).toMatch(/2 new review thread\(s\)/);
        expect(told[0]).toContain(`change c1 "${read.summary.session.title}"`);
        expect(told[0]).toContain(`(branch ${first_branch}), which is not checked out`);
        expect(told[0]).toContain("`change switch c1`");
        // The notice of the transition names the change.
        expect(banners.at(-1)).toContain(` · ${read.summary.session.title}: `);
    });

    it("verify moves the session to peer-review; a push clears the tick", async () => {
        const dir = await adopt();
        const { config } = load_pipeline_config(project, home, root);
        const verified = verify_session(home, { dir, by: "owner-1", config });
        expect(verified.session.stage).toBe("peer-review");
        expect(verified.session.pipeline?.verified_locally).toBe(true);
        expect(verified.session.pipeline?.verified_by).toBe("owner-1");

        const pushed = load("pr-approving");
        pushed.data.repository.pullRequest.headRefOid = "0000000000000000000000000000000000000001";
        gh.responses.set(4812, pushed);
        const report = await poll_once(home, { gh: gh.runner, notify, cwd: root });
        expect(report.transitions).toHaveLength(1);
        const after = read_yaml(dir);
        expect(after.pipeline?.verified_locally).toBe(false);
        expect(after.stage).toBe("verifying");
        const needs = "needs you: verify locally (backend#4812)";
        expect(banners).toEqual([`${after.id} ${after.slug}: peer-review → verifying · ${needs}`]);
        expect(banner_sessions).toEqual([dir]);
    });

    it("notifies on a merge-queue pop-out within one round", async () => {
        const base = load("pr-merged-after-popout");
        gh.responses.set(4404, queued_variant(base));
        const summary = await adopt_prs(home, {
            urls: ["https://github.com/acme/backend/pull/4404"],
            project,
            cwd: root,
            gh: gh.runner,
        });
        expect(summary.session.stage).toBe("queued");

        gh.responses.set(4404, popped_variant(base));
        const report = await poll_once(home, { gh: gh.runner, notify, cwd: root });
        expect(report.transitions).toHaveLength(1);
        expect(report.transitions[0]?.transition.queue_changes).toEqual([
            "backend#4404 queued → popped",
        ]);
        expect(banners).toHaveLength(1);
        expect(banners[0]).toContain("queued → queued");
        expect(banners[0]).toContain("popped out of queue: failed_checks");
        expect(read_yaml(summary.dir).repos["backend"]?.pr?.queue_reason).toBe("failed_checks");
    });

    it("skips sessions without an open PR and reports a failing fetch", async () => {
        const dir = await adopt();
        gh.responses.delete(4812);
        const report = await poll_once(home, { gh: gh.runner, notify, cwd: root });
        expect(report.polled).toEqual([]);
        expect(report.errors).toEqual([{ dir, error: "fake gh has no PR #4812" }]);
        expect(banners).toEqual([]);
    });
});
