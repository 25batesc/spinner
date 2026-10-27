// Goal: prove the board's end-to-end behaviour without GitHub: `adopt_prs` creates a session
// from PR URLs, `poll_once` rewrites session.yaml and notifies only on a transition, a push
// clears the verify tick, and a merge-queue pop-out notifies within one round. Method: a fake
// `gh` runner serves the scrubbed fixtures (and mutated copies of them) from memory; a
// capturing notifier records banners; everything runs against a temporary SPINNER_HOME with
// a temporary project spec.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { beforeEach, describe, expect, it } from "vitest";
import type { Session } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { adopt_prs } from "./adopt.js";
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
    "  backend: { path: ~/code/backend }",
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
const notify = async (_title: string, message: string): Promise<void> => {
    banners.push(message);
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

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "spinner-board-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home") });
    project = join(root, "acme");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "spinner.yaml"), SPEC);
    gh = new FakeGh();
    banners = [];
});

describe("spinner adopt", () => {
    it("creates a session from a PR URL with the derived stage and no worktree", async () => {
        gh.responses.set(4812, load("pr-approving"));
        const summary = await adopt_prs(home, {
            urls: ["https://github.com/acme/backend/pull/4812"],
            project,
            cwd: root,
            gh: gh.runner,
            now: () => new Date("2026-10-27T00:00:00Z"),
        });
        const session = read_yaml(summary.dir);
        expect(session.project).toBe(project);
        expect(session.branch).toBe("devin/example-feature");
        expect(session.base).toBe("develop");
        expect(session.stage).toBe("verifying");
        expect(session.needs_human).toBe("verify locally (backend#4812)");
        expect(session.repos["backend"]?.pr?.threads.resolved).toBe(2);
        expect(session.repos["backend"]?.worktree).toBeUndefined();
        expect(readFileSync(join(summary.path, "MISSION.md"), "utf8")).toContain("## Goal");
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
