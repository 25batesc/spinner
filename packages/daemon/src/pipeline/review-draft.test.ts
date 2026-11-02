// Goal: the review lead's artifacts and routes (MISSION.md s016, Plan item 3). The pure
// half: the PR diff from `pulls/:n/files` becomes right-side lines per file; a draft is
// refused with every fault named (a bad event, a body without a severity label, a line
// outside the diff, APPROVE with a BLOCKING comment); the body shape is checked first. The
// routes: `PUT .../review/briefing` writes the file and `GET` serves it; `PUT .../review/draft`
// answers 400 and writes nothing on a fault, 200 and sets `needs_human` on a good one;
// `DELETE` drops it; `POST .../review/post` posts one review through the writer's `gh` with
// `commit_id`, `side: RIGHT`, reposts as COMMENT when GitHub refuses the author's APPROVE,
// records the URL in `session.yaml` and the Log, and clears the draft. Method: the pure
// functions directly, then a daemon on a temporary home with a fake read `gh` (serving the
// PR facts and the files) and a fake writer that records the calls and reads the request
// file `gh api --input` names.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReviewDraft, Session, SessionView } from "@spinner/protocol";
import { REVIEW_DRAFT_NEEDS_HUMAN } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { start_daemon, type Daemon } from "../server.js";
import { create_session, read_session, write_session } from "../store/session-store.js";
import { pipeline_config_from_spec } from "./config.js";
import { pr_facts_from_response, type GhRunner, type PrResponse } from "./github.js";
import type { GithubWriter } from "./github-write.js";
import { diff_lines_of, parse_draft, validate_draft } from "./review-draft.js";
import { apply_pr_facts } from "./tracker.js";

const FIXTURE = new URL("../../test/fixtures/github/pr-approving.json", import.meta.url);
const PR_URL = "https://github.com/acme/backend/pull/4812";

const PATCH = [
    "@@ -1,3 +1,4 @@",
    " # origin",
    "-old line",
    "+new line",
    "+another new line",
    " tail",
    "@@ -20,2 +21,3 @@ function f() {",
    " context",
    "+added",
    " end",
].join("\n");

const FILES = [
    { filename: "README.md", status: "modified", patch: PATCH },
    { filename: "gone.ts", status: "removed", patch: "@@ -1 +0,0 @@\n-x" },
    { filename: "image.png", status: "added" },
];

describe("the diff lines and the draft rules", () => {
    it("reads the right-side lines of each file; a removed file takes no comment", () => {
        const lines = diff_lines_of(FILES);
        expect([...(lines.get("README.md") ?? [])]).toEqual([1, 2, 3, 4, 21, 22, 23]);
        expect(lines.has("gone.ts")).toBe(false);
        expect(lines.get("image.png")?.size).toBe(0);
    });

    it("names every fault of a draft, and accepts a whole one", () => {
        const lines = diff_lines_of(FILES);
        const bad: ReviewDraft = {
            event: "APPROVE",
            body: "",
            comments: [
                { path: "README.md", line: 2, body: "BLOCKING: Fix the count. It is off by one." },
                { path: "README.md", line: 10, body: "NIT: Rename this." },
                { path: "missing.ts", line: 1, body: "BUG: x" },
                { path: "README.md", line: 3, body: "Consider renaming this." },
            ],
        };
        const errors = validate_draft(bad, lines);
        expect(errors).toEqual([
            "body is empty; the summary goes there (LGTM, A few nits, but LGTM, A few blockers)",
            "event is APPROVE with a BLOCKING: comment; use COMMENT",
            "comments[1] (README.md:10): line 10 is not on the right side of the diff of " +
                "README.md (lines 1-4, 21-23)",
            "comments[2] (missing.ts:1): missing.ts is not in the PR diff",
            "comments[3] (README.md:3): body must start with one of BLOCKING:, BUG:, NIT:, " +
                "SUPER NIT:",
        ]);
        const good: ReviewDraft = {
            event: "COMMENT",
            body: "A few blockers",
            comments: [
                { path: "README.md", line: 2, body: "BLOCKING: Fix the count. It is off by one." },
                {
                    path: "README.md",
                    line: 22,
                    body: "SUPER NIT: Drop the blank line. It adds nothing.",
                },
            ],
        };
        expect(validate_draft(good, lines)).toEqual([]);
        expect(validate_draft({ event: "APPROVE", body: "LGTM", comments: [] }, lines)).toEqual([]);
    });

    it("checks the body's shape before the rules", () => {
        expect(parse_draft(null)).toMatch(/must be an object/);
        expect(parse_draft({ event: 1, body: "", comments: [] })).toMatch(/`event`/);
        expect(parse_draft({ event: "APPROVE", body: "x" })).toMatch(/`comments` must be an array/);
        expect(
            parse_draft({
                event: "APPROVE",
                body: "x",
                comments: [{ path: "", line: 1, body: "" }],
            }),
        ).toMatch(/comments\[0\]\.path/);
        expect(
            parse_draft({
                event: "APPROVE",
                body: "x",
                comments: [{ path: "a", line: 0, body: "" }],
            }),
        ).toMatch(/comments\[0\]\.line/);
        expect(
            parse_draft({
                event: "APPROVE",
                body: "x",
                comments: [{ path: " a.ts ", line: "3", body: "NIT: y" }],
            }),
        ).toEqual({
            event: "APPROVE",
            body: "x",
            comments: [{ path: "a.ts", line: 3, body: "NIT: y" }],
        });
    });
});

let home: SpinnerHome;
let daemon: Daemon;
let base: string;
let writes: string[][];
let posted_bodies: Array<Record<string, unknown>>;
let refuse_approve: boolean;

/** The read `gh`: the PR facts, the owner, and the PR's files. */
const gh: GhRunner = async (args) => {
    if (args[0] === "api" && args[1] === "user") {
        return "owner-1\n";
    }
    if (args[0] === "api" && args[1] === "repos/acme/backend/pulls/4812/files") {
        expect(args).toContain("--paginate");
        return JSON.stringify([FILES]);
    }
    if (args.some((arg) => arg === "number=4812")) {
        return readFileSync(FIXTURE, "utf8");
    }
    throw new Error(`fake gh: ${args.join(" ")}`);
};

const writer: GithubWriter = {
    gh: async (args) => {
        writes.push(args);
        const input = args[args.indexOf("--input") + 1];
        expect(input).toBeDefined();
        const body = JSON.parse(readFileSync(input as string, "utf8")) as Record<string, unknown>;
        posted_bodies.push(body);
        if (refuse_approve && body["event"] === "APPROVE") {
            const error = new Error("gh: Unprocessable Entity (HTTP 422)") as Error & {
                stderr: string;
            };
            error.stderr =
                '{"message":"Unprocessable Entity",' +
                '"errors":["Can not approve your own pull request"]}';
            throw error;
        }
        return JSON.stringify({ html_url: `${PR_URL}#pullrequestreview-${posted_bodies.length}` });
    },
    git: async () => "",
};

beforeEach(async () => {
    writes = [];
    posted_bodies = [];
    refuse_approve = false;
    home = resolve_home({ SPINNER_HOME: mkdtempSync(join(tmpdir(), "spinner-review-draft-")) });
    mkdirSync(home.root, { recursive: true });
    daemon = await start_daemon({
        home,
        port: 0,
        operator: false,
        log: () => undefined,
        poll_seconds: 0,
        gh,
        writer,
        notify: async () => undefined,
        ui_dir: null,
        observe_interval_ms: 60_000,
        pi: "/bin/false",
    });
    base = `http://127.0.0.1:${daemon.port}`;
});

afterEach(async () => {
    await daemon.close();
    rmSync(home.root, { recursive: true, force: true });
});

/** A review session that tracks PR 4812, without the clone (`gh` is fake, nothing posts). */
function review_session(): string {
    const created = create_session(home, { title: "Review" });
    const response = JSON.parse(readFileSync(FIXTURE, "utf8")) as PrResponse;
    const config = pipeline_config_from_spec({});
    const facts = pr_facts_from_response(response, { config: config.github, owner_login: "o" });
    const session: Session = {
        ...created.session,
        kind: "review",
        repos: {
            backend: { path: "~/x", worktree: "worktrees/backend", changed: false, pr: null },
        },
    };
    write_session({ ...created, session: apply_pr_facts(session, "backend", facts) });
    return created.dir;
}

function call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

function session_of(dir: string): Session {
    const read = read_session(home, dir);
    expect(read.ok).toBe(true);
    return read.ok ? read.summary.session : ({} as Session);
}

async function view_of(dir: string): Promise<SessionView> {
    return ((await (await call("GET", `/sessions/${dir}`)).json()) as { session: SessionView })
        .session;
}

const GOOD: ReviewDraft = {
    event: "COMMENT",
    body: "A few blockers",
    comments: [{ path: "README.md", line: 2, body: "BLOCKING: Fix the count. It is off by one." }],
};

describe("the review routes", () => {
    it("writes and serves the briefing", async () => {
        const dir = review_session();
        expect((await call("GET", `/sessions/${dir}/review/briefing`)).status).toBe(404);
        expect(
            (await call("PUT", `/sessions/${dir}/review/briefing`, { markdown: " " })).status,
        ).toBe(400);
        const put = await call("PUT", `/sessions/${dir}/review/briefing`, {
            markdown: "# What\n\nIt adds a line.",
        });
        expect(put.status).toBe(200);
        const got = await call("GET", `/sessions/${dir}/review/briefing`);
        expect(got.status).toBe(200);
        expect(got.headers.get("content-type")).toContain("text/markdown");
        expect(await got.text()).toBe("# What\n\nIt adds a line.\n");
        expect((await view_of(dir)).review?.briefing).toBe(true);
        expect((await call("GET", "/sessions/nope/review/briefing")).status).toBe(404);
    });

    it("refuses a bad draft and writes nothing; a whole one asks the operator", async () => {
        const dir = review_session();
        const path = join(home.sessions, dir, "artifacts", "review-draft.json");
        const bad = await call("PUT", `/sessions/${dir}/review/draft`, {
            event: "APPROVE",
            body: "LGTM",
            comments: [{ path: "README.md", line: 99, body: "Rename this." }],
        });
        expect(bad.status).toBe(400);
        const error = ((await bad.json()) as { error: string }).error;
        expect(error).toContain("the draft has 2 faults");
        expect(error).toContain("line 99 is not on the right side");
        expect(error).toContain("body must start with one of");
        expect(existsSync(path)).toBe(false);
        expect((await call("PUT", `/sessions/${dir}/review/draft`, { event: "X" })).status).toBe(
            400,
        );
        expect((await call("DELETE", `/sessions/${dir}/review/draft`)).status).toBe(404);
        expect((await call("POST", `/sessions/${dir}/review/post`)).status).toBe(409);

        const good = await call("PUT", `/sessions/${dir}/review/draft`, GOOD);
        expect(good.status, await good.clone().text()).toBe(200);
        expect(((await good.json()) as { draft: ReviewDraft }).draft).toEqual(GOOD);
        expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(GOOD);
        const session = session_of(dir);
        expect(session.review?.draft).toBe(true);
        expect(session.needs_human).toBe(REVIEW_DRAFT_NEEDS_HUMAN);
        const view = await view_of(dir);
        expect(view.review?.draft).toEqual(GOOD);
        expect(view.review?.state).toBe("drafted");
        expect(view.review?.comment_count).toBe(1);
        expect(view.review?.event).toBe("COMMENT");
        expect(view.board?.needs_human).toBe(REVIEW_DRAFT_NEEDS_HUMAN);

        expect((await call("DELETE", `/sessions/${dir}/review/draft`)).status).toBe(200);
        expect(existsSync(path)).toBe(false);
        expect(session_of(dir).review?.draft).toBe(false);
        expect(session_of(dir).needs_human).not.toBe(REVIEW_DRAFT_NEEDS_HUMAN);
        expect((await view_of(dir)).review?.draft).toBeNull();
    });

    it("posts the draft once through gh at the head SHA; the URL lands", async () => {
        const dir = review_session();
        writeFileSync(join(home.sessions, dir, "MISSION.md"), "# r\n\n## Goal\nG\n\n## Log\n");
        expect((await call("PUT", `/sessions/${dir}/review/draft`, GOOD)).status).toBe(200);
        const posted = await call("POST", `/sessions/${dir}/review/post`);
        expect(posted.status, await posted.clone().text()).toBe(200);
        const result = (await posted.json()) as { url: string; event: string; fell_back: boolean };
        expect(result).toEqual({
            url: `${PR_URL}#pullrequestreview-1`,
            event: "COMMENT",
            fell_back: false,
        });
        expect(writes).toHaveLength(1);
        expect(writes[0]?.slice(0, 4)).toEqual([
            "api",
            "--method",
            "POST",
            "repos/acme/backend/pulls/4812/reviews",
        ]);
        expect(posted_bodies[0]).toEqual({
            commit_id: "c46867ff747b5d774b3073ead5ebc54c939bdfb4",
            event: "COMMENT",
            body: "A few blockers",
            comments: [{ path: "README.md", line: 2, side: "RIGHT", body: GOOD.comments[0]?.body }],
        });
        const session = session_of(dir);
        expect(session.review?.posted_url).toBe(result.url);
        expect(session.review?.draft).toBe(false);
        expect(session.needs_human).not.toBe(REVIEW_DRAFT_NEEDS_HUMAN);
        expect(existsSync(join(home.sessions, dir, "artifacts", "review-draft.json"))).toBe(false);
        expect(existsSync(join(home.sessions, dir, "artifacts", "review-posted.json"))).toBe(true);
        const mission = readFileSync(join(home.sessions, dir, "MISSION.md"), "utf8");
        expect(mission).toContain(
            `operator: posted the review of acme/backend#4812 as COMMENT: ${result.url}`,
        );
        const view = await view_of(dir);
        expect(view.review?.posted_url).toBe(result.url);
        expect(view.review?.draft).toBeNull();
        expect(view.review?.state).toBe("posted");
        expect(view.review?.comment_count).toBe(0);
        expect(view.review?.event).toBeNull();
        expect((await call("POST", `/sessions/${dir}/review/post`)).status).toBe(409);
    });

    it("reposts as COMMENT when GitHub refuses the author's APPROVE, and says so", async () => {
        const dir = review_session();
        refuse_approve = true;
        const approve: ReviewDraft = { event: "APPROVE", body: "LGTM", comments: [] };
        expect((await call("PUT", `/sessions/${dir}/review/draft`, approve)).status).toBe(200);
        const posted = await call("POST", `/sessions/${dir}/review/post`);
        expect(posted.status).toBe(200);
        expect(await posted.json()).toEqual({
            url: `${PR_URL}#pullrequestreview-2`,
            event: "COMMENT",
            fell_back: true,
        });
        expect(posted_bodies.map((body) => body["event"])).toEqual(["APPROVE", "COMMENT"]);
    });

    it("refuses the post of an ordinary session's PR outside the allow-list", async () => {
        const dir = review_session();
        const read = read_session(home, dir);
        expect(read.ok).toBe(true);
        if (read.ok) {
            delete read.summary.session.kind;
            write_session(read.summary);
        }
        expect((await call("PUT", `/sessions/${dir}/review/draft`, GOOD)).status).toBe(200);
        const posted = await call("POST", `/sessions/${dir}/review/post`);
        expect(posted.status).toBe(502);
        expect(((await posted.json()) as { error: string }).error).toMatch(
            /refusing GitHub write to acme\/backend/,
        );
        expect(writes).toEqual([]);
        expect(existsSync(join(home.sessions, dir, "artifacts", "review-draft.json"))).toBe(true);
    });
});
