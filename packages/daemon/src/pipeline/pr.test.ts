// Goal: prove that `spinner pr` pushes and opens a PR only for repos with commits ahead of
// their base, writes the PR into `session.yaml` with the stage re-derived, builds the body
// from the mission, and that every GitHub write is refused when the repo is not on
// `pipeline.github.write_repos`. Method: a fake `git` answers `rev-list` and `remote` and
// records pushes; a fake `gh` records `pr create` and serves a fixture for the facts; the
// session lives in a temporary SPINNER_HOME with a temporary project spec.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { beforeEach, describe, expect, it } from "vitest";
import type { Session, SessionSummary } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { create_session, read_session, write_session } from "../store/session-store.js";
import { pipeline_config_from_spec } from "./config.js";
import { pr_facts_from_response, type GhRunner, type PrResponse } from "./github.js";
import {
    github_write,
    is_write_allowed,
    repo_from_remote,
    type GithubWriter,
} from "./github-write.js";
import { append_log_line, pr_body_from_mission } from "./mission-sections.js";
import { open_prs, pr_url_from_output } from "./pr.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "..", "..", "test", "fixtures", "github");

function load(name: string): PrResponse {
    return JSON.parse(readFileSync(resolve(fixtures, `${name}.json`), "utf8")) as PrResponse;
}

const MISSION = [
    "# s9 · Example",
    "",
    "## Goal",
    "Ship the example.",
    "",
    "## Done when",
    "- [ ] it works",
    "",
    "## Log",
    "- 10:00 agent: started",
    "",
].join("\n");

/** A fake `git` and `gh` that record every call and answer what `pr` asks. */
class FakeWriter implements GithubWriter {
    pushes: { cwd: string; args: string[] }[] = [];
    gh_calls: string[][] = [];
    ahead = new Map<string, number>();
    response: PrResponse | null = null;
    gh: GhRunner = async (args) => {
        this.gh_calls.push(args);
        if (args[0] === "api" && args[1] === "user") {
            return "owner-1\n";
        }
        if (args[0] === "pr" && args[1] === "create") {
            return "https://github.com/acme/backend/pull/4825\n";
        }
        if (args[0] === "api" && args[1] === "graphql") {
            if (this.response === null) {
                throw new Error("fake gh has no PR response");
            }
            return JSON.stringify(this.response);
        }
        throw new Error(`fake gh: unexpected ${args.join(" ")}`);
    };
    git = async (cwd: string, args: string[]): Promise<string> => {
        if (args[0] === "push") {
            this.pushes.push({ cwd, args });
            return "";
        }
        if (args[0] === "remote") {
            return "git@github.com:acme/backend.git\n";
        }
        if (args[0] === "rev-parse") {
            return "abc\n";
        }
        if (args[0] === "rev-list") {
            return `${this.ahead.get(cwd) ?? 0}\n`;
        }
        throw new Error(`fake git: unexpected ${args.join(" ")}`);
    };
}

let root: string;
let home: SpinnerHome;
let writer: FakeWriter;

function spec_with(write_repos: string[]): ReturnType<typeof pipeline_config_from_spec> {
    return pipeline_config_from_spec({
        pipeline: { github: { write_repos, bot_logins: ["devin-ai-integration[bot]"] } },
    });
}

/** A session with one worktree directory per repo (empty; the fake git never reads it). */
function session_with_worktrees(repos: string[]): SessionSummary {
    const created = create_session(home, { title: "Example" });
    const session: Session = { ...created.session, base: "develop", repos: {} };
    for (const repo of repos) {
        const worktree = `worktrees/${repo}`;
        mkdirSync(join(created.path, worktree), { recursive: true });
        session.repos[repo] = { path: `~/code/${repo}`, worktree, changed: false };
    }
    write_session({ ...created, session });
    writeFileSync(join(created.path, "MISSION.md"), MISSION);
    const read = read_session(home, created.dir);
    if (!read.ok) {
        throw new Error(read.error);
    }
    return read.summary;
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "spinner-pr-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home") });
    writer = new FakeWriter();
});

describe("github_write allow-list", () => {
    it("refuses every write to a repo that is not listed, before calling gh or git", async () => {
        await expect(
            github_write(writer, [], "acme/backend", { kind: "gh", args: ["pr", "create"] }),
        ).rejects.toThrow(/refusing GitHub write to acme\/backend.*empty/);
        await expect(
            github_write(writer, ["acme/other"], "acme/backend", {
                kind: "git_push",
                cwd: "/x",
                args: ["push"],
            }),
        ).rejects.toThrow(/not in pipeline.github.write_repos \(acme\/other\)/);
        expect(writer.gh_calls).toEqual([]);
        expect(writer.pushes).toEqual([]);
    });

    it("allows a listed repo, ignoring case", async () => {
        expect(is_write_allowed("Acme/Backend", ["acme/backend"])).toBe(true);
        expect(is_write_allowed("acme/backend", ["acme/backend-2"])).toBe(false);
        const out = await github_write(writer, ["acme/backend"], "acme/backend", {
            kind: "git_push",
            cwd: "/wt",
            args: ["push", "origin", "x"],
        });
        expect(out).toBe("");
        expect(writer.pushes).toEqual([{ cwd: "/wt", args: ["push", "origin", "x"] }]);
    });

    it("reads owner/name from https, ssh and scp-style remotes", () => {
        expect(repo_from_remote("https://github.com/acme/backend.git")).toBe("acme/backend");
        expect(repo_from_remote("git@github.com:acme/backend.git\n")).toBe("acme/backend");
        expect(repo_from_remote("ssh://git@github.com/acme/backend")).toBe("acme/backend");
        expect(repo_from_remote("https://gitlab.com/acme/backend.git")).toBeNull();
    });
});

describe("spinner pr", () => {
    it("pushes and opens a PR for the repo ahead of base, and skips the other", async () => {
        const summary = session_with_worktrees(["backend", "web"]);
        writer.ahead.set(join(summary.path, "worktrees", "backend"), 3);
        writer.response = load("pr-fixing");
        const log: string[] = [];
        const result = await open_prs(
            home,
            summary,
            {},
            { gh: writer.gh, writer, config: spec_with(["acme/backend"]), log: (l) => log.push(l) },
        );
        expect(result.outcomes).toEqual([
            {
                repo: "backend",
                outcome: "opened",
                url: "https://github.com/acme/backend/pull/4825",
            },
            { repo: "web", outcome: "unchanged", url: null },
        ]);
        expect(writer.pushes).toHaveLength(1);
        expect(writer.pushes[0]?.args).toEqual([
            "push",
            "--set-upstream",
            "origin",
            summary.session.branch,
        ]);
        const create = writer.gh_calls.find((args) => args[1] === "create");
        expect(create).toContain("--base");
        expect(create?.[create.indexOf("--base") + 1]).toBe("develop");
        expect(create?.[create.indexOf("--repo") + 1]).toBe("acme/backend");
        const body_path = create?.[create.indexOf("--body-file") + 1] ?? "";
        const body = readFileSync(body_path, "utf8");
        expect(body).toContain("## Goal\nShip the example.");
        expect(body).toContain("- [ ] it works");
        expect(body).toContain("- 10:00 agent: started");

        const session = parse(
            readFileSync(join(home.sessions, summary.dir, "session.yaml"), "utf8"),
        ) as Session;
        expect(session.repos["backend"]?.pr?.number).toBe(4825);
        expect(session.repos["backend"]?.pr?.title).toContain("example feature");
        // A pull request opened here starts with an empty autopilot state: its first failed
        // check and review threads go to the lead (talk-change-ship.md, 1.5).
        expect(session.pipeline?.autopilot).toEqual({ red: {}, threads: [] });
        // The title comes from the collector, so a later poll keeps it.
        const polled = pr_facts_from_response(load("pr-fixing"), {
            config: spec_with([]).github,
            owner_login: "owner-1",
        });
        expect(polled.title).toContain("example feature");
        expect(session.repos["backend"]?.changed).toBe(true);
        expect(session.repos["web"]?.pr ?? null).toBeNull();
        expect(session.stage).toBe("fixing");
        const mission = readFileSync(join(summary.path, "MISSION.md"), "utf8");
        expect(mission).toMatch(/- \d\d:\d\d spinner: pr: backend https:\/\/github.com/);
        expect(log.some((line) => line.includes("opened https://github.com"))).toBe(true);
    });

    it("writes the body from the approved design doc of a design session (6.9)", async () => {
        const created = session_with_worktrees(["backend"]);
        const doc_path = "docs/designs/example.md";
        const doc_dir = join(created.path, "worktrees", "backend", "docs", "designs");
        mkdirSync(doc_dir, { recursive: true });
        const doc = "# Example\n\n## Overview\nThe example ships.\n\n## Goals\n*   It works.\n";
        writeFileSync(join(doc_dir, "example.md"), `${doc}\n## The Problem\nNot in the PR.\n`);
        const approved = {
            path: doc_path,
            repo: "backend",
            sha256: "ab",
            at: "2026-11-03T00:00:00Z",
            blockers: 0,
            round: 1,
        };
        const design = { track: "design" as const, doc: doc_path, repo: "backend", approved };
        write_session({ ...created, session: { ...created.session, design } });
        const read = read_session(home, created.dir);
        if (!read.ok) {
            throw new Error(read.error);
        }
        writer.ahead.set(join(created.path, "worktrees", "backend"), 1);
        writer.response = load("pr-fixing");
        const deps = { gh: writer.gh, writer, config: spec_with(["acme/backend"]), log: () => {} };
        await open_prs(home, read.summary, {}, deps);
        const create = writer.gh_calls.find((args) => args[1] === "create");
        const body = readFileSync(create?.[create.indexOf("--body-file") + 1] ?? "", "utf8");
        expect(body).toBe(
            [
                "The example ships.",
                "",
                "## Goals",
                "*   It works.",
                "",
                "Design: `docs/designs/example.md` (drafted with EGM)",
                "",
                `Spinner session ${created.session.id}`,
                "",
            ].join("\n"),
        );
        expect(body).not.toContain("Ship the example.");
    });

    it("keeps the mission body for a design session whose doc is not approved", async () => {
        const created = session_with_worktrees(["backend"]);
        const design = { track: "design" as const, doc: "docs/designs/x.md", repo: "backend" };
        write_session({ ...created, session: { ...created.session, design } });
        const read = read_session(home, created.dir);
        if (!read.ok) {
            throw new Error(read.error);
        }
        writer.ahead.set(join(created.path, "worktrees", "backend"), 1);
        writer.response = load("pr-fixing");
        const deps = { gh: writer.gh, writer, config: spec_with(["acme/backend"]), log: () => {} };
        await open_prs(home, read.summary, {}, deps);
        const create = writer.gh_calls.find((args) => args[1] === "create");
        const body = readFileSync(create?.[create.indexOf("--body-file") + 1] ?? "", "utf8");
        expect(body).toContain("## Goal\nShip the example.");
    });

    it("refuses before pushing when the repo is not on the allow-list", async () => {
        const summary = session_with_worktrees(["backend"]);
        writer.ahead.set(join(summary.path, "worktrees", "backend"), 1);
        const deps = { gh: writer.gh, writer, config: spec_with([]), log: () => {} };
        await expect(open_prs(home, summary, {}, deps)).rejects.toThrow(
            /refusing GitHub write to acme\/backend/,
        );
        expect(writer.pushes).toEqual([]);
        expect(writer.gh_calls.filter((args) => args[1] === "create")).toEqual([]);
    });

    it("pushes only when the PR already exists", async () => {
        const summary = session_with_worktrees(["backend"]);
        const session = summary.session;
        const entry = session.repos["backend"];
        if (entry === undefined) {
            throw new Error("no backend");
        }
        const facts = load("pr-fixing").data.repository.pullRequest;
        entry.pr = {
            number: facts.number,
            url: facts.url,
            author: "owner-1",
            state: "open",
            head: facts.headRefOid,
            checks: "green",
            approval_check: "pending",
            approvals: { required: ["peer"], peer: [], owner: false },
            threads: { bots_open: 0, humans_open: 0, resolved: 0 },
            review: "none",
            bot_reviewed_head: null,
            queue: "none",
            last_activity: "2026-10-27T00:00:00Z",
        };
        write_session({ ...summary, session });
        writer.ahead.set(join(summary.path, "worktrees", "backend"), 2);
        const result = await open_prs(
            home,
            summary,
            {},
            { gh: writer.gh, writer, config: spec_with(["acme/backend"]), log: () => {} },
        );
        expect(result.outcomes[0]?.outcome).toBe("pushed");
        expect(writer.pushes).toHaveLength(1);
        expect(writer.gh_calls.filter((args) => args[1] === "create")).toEqual([]);
    });

    it("reads the URL from gh's output and renders the mission body", () => {
        expect(pr_url_from_output("Creating...\nhttps://github.com/a/b/pull/7\n")).toBe(
            "https://github.com/a/b/pull/7",
        );
        expect(() => pr_url_from_output("nothing")).toThrow(/expected a PR URL/);
        const body = pr_body_from_mission("# t\n\n## Goal\nG\n", "s9");
        expect(body).toContain("## Goal\nG\n");
        expect(body).toContain("(no acceptance list written)");
        const logged = append_log_line(MISSION, "11:02", "spinner", "pr: backend");
        expect(logged.endsWith("- 10:00 agent: started\n- 11:02 spinner: pr: backend\n")).toBe(
            true,
        );
    });
});
