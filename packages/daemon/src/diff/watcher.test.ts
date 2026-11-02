// Goal: a comment the operator leaves reaches the session. The watcher turns a thread that
// waits on the agent into exactly one `notify` with the contract's text, records the
// unresolved threads in `session.yaml`, sets `needs_human` while a thread waits on the
// operator and clears it when the thread resolves, and sends at most two notices a second.
// Method: the fake viewer, whose `comments` verbs read a thread file the test edits.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Session, SessionSummary } from "@spinner/protocol";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import type { SpinnerHome } from "../home.js";
import { write_session } from "../store/session-store.js";
import { DiffManager } from "./manager.js";
import { NoticeLimiter, duration_ms } from "./watcher.js";

const FAKE = resolve(dirname(fileURLToPath(import.meta.url)), "fake-diffview.mjs");

function make_home(): SpinnerHome {
    const root = mkdtempSync(join(tmpdir(), "spinner-diff-watch-"));
    mkdirSync(join(root, "sessions"));
    return {
        root,
        sessions: join(root, "sessions"),
        archive: join(root, "archive"),
        proxy: join(root, "proxy"),
        ids_scope: "home",
    };
}

function make_session(home: SpinnerHome): SessionSummary {
    const dir = "s041-watch";
    const path = join(home.sessions, dir);
    mkdirSync(join(path, "repos", "app"), { recursive: true });
    const summary: SessionSummary = {
        dir,
        path,
        session: {
            version: 1,
            id: "s041",
            slug: "watch",
            title: "watch",
            created: "2026-11-01T00:00:00Z",
            stage: "building",
            needs_human: null,
            branch: "feat/watch",
            base: "main",
            repos: { app: { path: "/repo/app", worktree: "repos/app", changed: true } },
            stack: { state: "none" },
            agents: {},
        },
    };
    write_session(summary);
    return summary;
}

function read_file(summary: SessionSummary): Session {
    return parse(readFileSync(join(summary.path, "session.yaml"), "utf8"));
}

async function until(check: () => boolean, what: string): Promise<void> {
    for (let poll = 0; poll < 200; poll += 1) {
        if (check()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`${what} did not happen in time`);
}

const thread = (waiting_on: "agent" | "human", status: "open" | "resolved" = "open") => ({
    id: 12,
    status,
    waitingOn: waiting_on,
    path: "src/app.ts",
    startLine: 40,
    endLine: 42,
    messages: [{ id: 5, author: "cullen", body: "Why does this\nswallow the error?" }],
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    delete process.env["FAKE_DIFFVIEW_THREADS"];
    for (const cleanup of cleanups.splice(0)) {
        await cleanup();
    }
});

describe("the comments watcher", () => {
    it("notifies once per new thread, records threads, sets and clears needs_human", async () => {
        const home = make_home();
        const summary = make_session(home);
        const threads_file = join(home.root, "threads.json");
        writeFileSync(threads_file, "[]");
        process.env["FAKE_DIFFVIEW_THREADS"] = threads_file;
        const notices: { dir: string; text: string }[] = [];
        const manager = new DiffManager({
            home,
            cwd: home.root,
            log: () => {},
            bin: FAKE,
            start_timeout_ms: 5_000,
            wait_timeout: "1s",
            notify: async (dir, text) => {
                notices.push({ dir, text });
            },
        });
        cleanups.push(async () => {
            manager.close();
            await manager.stop(summary, undefined, () => {});
        });
        await manager.start(summary, "app", () => {});

        writeFileSync(threads_file, JSON.stringify([thread("agent")]));
        await until(() => notices.length === 1, "the notice");
        expect(notices[0]).toEqual({
            dir: "s041-watch",
            text:
                "diff comment #12 on app src/app.ts:40-42 waits on you.\n" +
                "cullen: Why does this swallow the error?\n" +
                "Read it with diff_comments show 12; answer with diff_reply.",
        });
        await until(() => read_file(summary).diff?.threads?.length === 1, "the record");
        expect(read_file(summary).diff?.threads).toEqual([
            {
                repo: "app",
                thread: 12,
                waiting_on: "agent",
                path: "src/app.ts",
                start_line: 40,
                end_line: 42,
            },
        ]);
        expect(read_file(summary).needs_human).toBeNull();
        const view = manager.view({ ...summary, session: read_file(summary) });
        expect(view.repos["app"]?.waiting).toEqual({ agent: 1, human: 0 });

        // The agent answers: the thread turns to the operator, who is now the next action.
        writeFileSync(threads_file, JSON.stringify([thread("human")]));
        const line = "answer diff comment #12 on app src/app.ts:40-42";
        await until(() => read_file(summary).needs_human === line, "needs_human");
        const turned = manager.view({ ...summary, session: read_file(summary) });
        expect(turned.repos["app"]?.waiting).toEqual({ agent: 0, human: 1 });

        // The operator resolves it in the page.
        writeFileSync(threads_file, JSON.stringify([thread("human", "resolved")]));
        await until(() => read_file(summary).needs_human === null, "needs_human cleared");
        expect(read_file(summary).diff?.threads).toBeUndefined();
        // No message newer than the first notice's: no second notice.
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        expect(notices).toHaveLength(1);
    });
});

describe("NoticeLimiter", () => {
    it("spaces notices at the bound", async () => {
        const limiter = new NoticeLimiter(10);
        const started = Date.now();
        for (let n = 0; n < 4; n += 1) {
            await limiter.take();
        }
        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(280);
        expect(elapsed).toBeLessThan(1_000);
    });
});

describe("duration_ms", () => {
    it("reads the CLI's durations", () => {
        expect(duration_ms("30s")).toBe(30_000);
        expect(duration_ms("2m")).toBe(120_000);
        expect(duration_ms("1h")).toBe(3_600_000);
        expect(duration_ms("15")).toBe(15_000);
        expect(() => duration_ms("soon")).toThrow(/not a duration/);
    });
});
