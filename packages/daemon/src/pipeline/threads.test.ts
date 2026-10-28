// Goal: prove the threads pipeline without GitHub: a response renders to `threads/<repo>-<n>.md`
// and `.json` with labels, author kinds, locations and replies; flags survive a re-render and
// raise `needs_human`; `resolve` is refused without a reply and for a human thread while
// `resolve_human` is off, and goes through the allow-listed writer otherwise; the diff names
// what opened, resolved and was flagged. Method: fixtures through a fake `gh`, a recording
// fake writer, a temporary SPINNER_HOME.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { beforeEach, describe, expect, it } from "vitest";
import type { PipelineConfig, Session, SessionSummary } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { create_session, read_session, write_session } from "../store/session-store.js";
import { pipeline_config_from_spec } from "./config.js";
import { pr_facts_from_response, type GhRunner, type PrResponse } from "./github.js";
import type { GithubWriter } from "./github-write.js";
import {
    find_thread,
    flag_thread,
    read_threads,
    refresh_threads,
    render_threads_markdown,
    reply_thread,
    resolve_thread,
    threads_from_response,
    write_pr_threads,
} from "./threads.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "..", "..", "test", "fixtures", "github");

function load(name: string): PrResponse {
    return JSON.parse(readFileSync(resolve(fixtures, `${name}.json`), "utf8")) as PrResponse;
}

const BOTS = ["devin-ai-integration[bot]", "sonarqubecloud[bot]"];

function config_with(extra: Record<string, unknown>): PipelineConfig {
    return pipeline_config_from_spec({
        pipeline: {
            github: { bot_logins: BOTS, write_repos: ["acme/backend"], owner_login: "owner-1" },
            ...extra,
        },
    });
}

class FakeGithub implements GithubWriter {
    response: PrResponse = load("pr-fixing");
    writes: string[][] = [];
    reads: GhRunner = async (args) => {
        if (args[0] === "api" && args[1] === "graphql") {
            return JSON.stringify(this.response);
        }
        throw new Error(`fake gh read: ${args.join(" ")}`);
    };
    gh: GhRunner = async (args) => {
        this.writes.push(args);
        return "{}";
    };
    git = async (): Promise<string> => "";
}

let home: SpinnerHome;
let github: FakeGithub;

function session_with_pr(response: PrResponse, config: PipelineConfig): SessionSummary {
    const created = create_session(home, { title: "Threads" });
    const facts = pr_facts_from_response(response, {
        config: config.github,
        owner_login: "owner-1",
    });
    const session: Session = {
        ...created.session,
        repos: { backend: { path: "~/code/backend", changed: true, pr: facts } },
    };
    write_session({ ...created, session });
    const read = read_session(home, created.dir);
    if (!read.ok) {
        throw new Error(read.error);
    }
    return read.summary;
}

/** The fixing fixture with one reply by the owner on the first thread. */
function replied_variant(base: PrResponse, login: string): PrResponse {
    const node = base.data.repository.pullRequest;
    const [first, ...rest] = node.reviewThreads.nodes;
    if (first === undefined) {
        throw new Error("fixture has no thread");
    }
    const reply = {
        id: "PRRC_reply",
        author: { login },
        body: "Fixed in 1234abc.",
        createdAt: "2026-10-27T03:00:00Z",
    };
    const threads = [
        { ...first, comments: { nodes: [...first.comments.nodes, reply] } },
        ...rest,
    ];
    return {
        data: {
            repository: {
                pullRequest: { ...node, reviewThreads: { ...node.reviewThreads, nodes: threads } },
            },
        },
    };
}

function read_yaml(dir: string): Session {
    return parse(readFileSync(join(home.sessions, dir, "session.yaml"), "utf8")) as Session;
}

beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "spinner-threads-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home") });
    github = new FakeGithub();
});

describe("threads render", () => {
    it("renders labels, author kinds, locations and the header from a response", () => {
        const config = config_with({});
        const view = threads_from_response(
            "backend",
            load("pr-fixing"),
            { config: config.github, owner_login: "owner-1" },
            null,
        );
        expect(view.open_bot).toBe(2);
        expect(view.open_human).toBe(0);
        expect(view.threads.map((t) => t.label)).toEqual(["T1", "T2"]);
        expect(view.threads[0]?.author_kind).toBe("bot");
        expect(view.threads[0]?.path).toBe("apps/ai/docs/ARCHITECTURE.md");
        expect(view.threads[0]?.line).toBe(196);
        expect(view.threads[0]?.replied).toBe(false);
        const markdown = render_threads_markdown(view, "s9");
        expect(markdown.split("\n")[0]).toBe(
            "# backend #4825 · 2 open threads (2 bot, 0 human) · checks: red · review: none",
        );
        expect(markdown).toContain(
            "## T1 · open · devin-ai-integration · apps/ai/docs/ARCHITECTURE.md:196",
        );
        expect(markdown).toContain(`<!-- ${view.threads[0]?.id ?? ""} -->`);
        expect(markdown).toContain("## Resolved (0)");
    });

    it("writes both files, diffs against the previous render and keeps flags", () => {
        const config = config_with({});
        const summary = session_with_pr(load("pr-fixing"), config);
        const context = { config: config.github, owner_login: "owner-1" };
        const first = threads_from_response("backend", load("pr-fixing"), context, null);
        const diff = write_pr_threads(summary, first, null);
        expect(diff).toEqual({
            repo: "backend",
            number: 4825,
            opened: ["T1", "T2"],
            resolved: [],
            flagged: [],
            file: "threads/backend-4825.md",
        });
        const threads = first.threads.map((t, i) => (i === 1 ? { ...t, flagged: "design" } : t));
        const flagged = { ...first, threads };
        write_pr_threads(summary, flagged, first);
        const again = threads_from_response("backend", load("pr-fixing"), context, flagged);
        expect(again.threads[1]?.flagged).toBe("design");
        expect(again.flagged).toBe(1);
        const view = read_threads(summary);
        expect(view.prs).toHaveLength(1);
        expect(view.prs[0]?.threads[1]?.flagged).toBe("design");
        expect(view.rendered).not.toBeNull();
    });
});

describe("refresh_threads", () => {
    it("fetches each open PR, writes threads/ and the counts into session.yaml", async () => {
        const config = config_with({});
        const summary = session_with_pr(load("pr-fixing"), config);
        const result = await refresh_threads(home, summary, {
            gh: github.reads,
            writer: github,
            config,
        });
        expect(result.view.prs[0]?.open_bot).toBe(2);
        expect(readFileSync(join(summary.path, "threads", "backend-4825.md"), "utf8")).toContain(
            "## T2",
        );
        const session = read_yaml(summary.dir);
        expect(session.repos["backend"]?.pr?.threads).toEqual({
            bots_open: 2,
            humans_open: 0,
            resolved: 0,
            flagged: 0,
        });
        expect(session.stage).toBe("fixing");
        expect(github.writes).toEqual([]);
    });
});

describe("thread actions", () => {
    it("flag is local, raises needs_human and survives the next refresh", async () => {
        const config = config_with({});
        const summary = session_with_pr(load("pr-fixing"), config);
        await refresh_threads(home, summary, { gh: github.reads, writer: github, config });
        const flagged = flag_thread(home, summary, { thread: "T2", reason: "design question" }, {
            config,
        });
        expect(flagged.thread.flagged).toBe("design question");
        let session = read_yaml(summary.dir);
        expect(session.needs_human).toBe("1 thread flagged on backend#4825");
        const after = read_session(home, summary.dir);
        if (!after.ok) {
            throw new Error(after.error);
        }
        await refresh_threads(home, after.summary, { gh: github.reads, writer: github, config });
        session = read_yaml(summary.dir);
        expect(session.repos["backend"]?.pr?.threads.flagged).toBe(1);
        expect(read_threads(after.summary).prs[0]?.threads[1]?.flagged).toBe("design question");
        expect(github.writes).toEqual([]);
    });

    it("refuses to resolve a thread without a reply, then resolves after one", async () => {
        const config = config_with({});
        const summary = session_with_pr(load("pr-fixing"), config);
        await refresh_threads(home, summary, { gh: github.reads, writer: github, config });
        const deps = { gh: github.reads, writer: github, config };
        await expect(resolve_thread(home, summary, { thread: "T1" }, deps)).rejects.toThrow(
            /T1 has no reply from you/,
        );
        expect(github.writes).toEqual([]);

        github.response = replied_variant(load("pr-fixing"), "owner-1");
        const replied = await reply_thread(home, summary, { thread: "T1", text: "Fixed." }, deps);
        expect(replied.thread.replied).toBe(true);
        const reply_call = github.writes[0] ?? [];
        expect(reply_call[1]).toBe("graphql");
        expect(reply_call.join(" ")).toContain("addPullRequestReviewThreadReply");
        expect(reply_call).toContain("body=Fixed.");

        const resolved = await resolve_thread(home, summary, { thread: "T1" }, deps);
        expect(resolved.thread.label).toBe("T1");
        const resolve_call = github.writes[1] ?? [];
        expect(resolve_call.join(" ")).toContain("resolveReviewThread");
        expect(resolve_call).toContain(`id=${resolved.thread.id}`);
    });

    it("refuses a human thread while resolve_human is off, allows it when on", async () => {
        const human = replied_variant(load("pr-fixing"), "owner-1");
        const node = human.data.repository.pullRequest;
        const first = node.reviewThreads.nodes[0];
        if (first === undefined) {
            throw new Error("no thread");
        }
        const comment = first.comments.nodes[0];
        if (comment === undefined) {
            throw new Error("no comment");
        }
        comment.author = { login: "human-2" };
        github.response = human;
        const off = config_with({ threads: { resolve_human: false } });
        const summary = session_with_pr(human, off);
        await refresh_threads(home, summary, { gh: github.reads, writer: github, config: off });
        const view = read_threads(summary);
        expect(view.prs[0]?.threads[0]?.author_kind).toBe("human");
        const deps_off = { gh: github.reads, writer: github, config: off };
        await expect(resolve_thread(home, summary, { thread: "T1" }, deps_off)).rejects.toThrow(
            /human thread and threads.resolve_human is off/,
        );
        const on = config_with({ threads: { resolve_human: true } });
        const deps_on = { gh: github.reads, writer: github, config: on };
        await resolve_thread(home, summary, { thread: "T1" }, deps_on);
        expect(github.writes).toHaveLength(1);
    });

    it("refuses every write when the repo is not allow-listed", async () => {
        const config = config_with({});
        config.github.write_repos = [];
        github.response = replied_variant(load("pr-fixing"), "owner-1");
        const summary = session_with_pr(github.response, config);
        await refresh_threads(home, summary, { gh: github.reads, writer: github, config });
        const deps = { gh: github.reads, writer: github, config };
        const reply = reply_thread(home, summary, { thread: "T2", text: "x" }, deps);
        await expect(reply).rejects.toThrow(/refusing GitHub write to acme\/backend/);
        await expect(resolve_thread(home, summary, { thread: "T1" }, deps)).rejects.toThrow(
            /refusing GitHub write to acme\/backend/,
        );
        expect(github.writes).toEqual([]);
    });

    it("finds a thread by id or label and names ambiguity", () => {
        const config = config_with({});
        const context = { config: config.github, owner_login: "owner-1" };
        const a = threads_from_response("backend", load("pr-fixing"), context, null);
        const b = threads_from_response("web", load("pr-fixing"), context, null);
        const view = { session: "x", prs: [a, b], rendered: null };
        expect(find_thread(view, "T1", "web").pr.repo).toBe("web");
        expect(find_thread(view, a.threads[0]?.id ?? "", "backend").thread.label).toBe("T1");
        expect(() => find_thread(view, "T1", undefined)).toThrow(/ambiguous/);
        expect(() => find_thread(view, "T9", "backend")).toThrow(/no thread "T9" on backend/);
    });
});
