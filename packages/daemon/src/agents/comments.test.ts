// Goal: the operator's preview comment reaches the agent with its screenshot as an image, its
// record keeps no secret, and the thread moves between the two sides as the protocol says,
// with `needs_human` naming a comment that waits on the operator. Method: a daemon on a
// temporary home with the fake pi on the rpc harness (it echoes how many image bytes a prompt
// carried); every step goes through the HTTP routes, and the checks read the records on
// disk, `session.yaml` and the events.
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type {
    AttachmentResponse,
    CommentResponse,
    CommentsResponse,
    PreviewAnchor,
    SessionSummary,
    SpinnerEvent,
} from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { start_daemon, type Daemon } from "../server.js";
import { create_session, read_session } from "../store/session-store.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(here, "..", "..", "test", "fixtures", "fake-pi.ts");
/** A 1×1 PNG. */
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQ" +
        "AAAABJRU5ErkJggg==",
    "base64",
);
const SECRET_NAME = "SPINNER_COMMENTS_TEST_API_KEY";
const SECRET = "sk-comment-secret-123";

let home: SpinnerHome;
let daemon: Daemon;
let base: string;
let events: SpinnerEvent[];
let client: WebSocket;
let summary: SessionSummary;

beforeEach(async () => {
    chmodSync(FAKE_PI, 0o755);
    process.env[SECRET_NAME] = SECRET;
    home = resolve_home({ SPINNER_HOME: mkdtempSync(join(tmpdir(), "spinner-comments-")) });
    daemon = await start_daemon({
        home,
        port: 0,
        operator: false,
        log: () => undefined,
        poll_seconds: 0,
        gh: () => Promise.reject(new Error("no gh in tests")),
        notify: async () => undefined,
        ui_dir: null,
        observe_interval_ms: 60_000,
        pi: FAKE_PI,
        agents_harness: "rpc",
    });
    base = `http://127.0.0.1:${daemon.port}`;
    summary = create_session(home, { title: "Alpha" });
    mkdirSync(join(summary.path, "agents", "lead"), { recursive: true });
    writeFileSync(join(summary.path, "agents", "lead", "BRIEF.md"), "# lead\n");
    events = [];
    client = new WebSocket(`ws://127.0.0.1:${daemon.port}/events`);
    client.on("message", (raw) => events.push(JSON.parse(String(raw)) as SpinnerEvent));
    await new Promise((done) => client.once("open", done));
});

afterEach(async () => {
    client.close();
    await daemon.close();
    rmSync(home.root, { recursive: true, force: true });
    delete process.env[SECRET_NAME];
});

function post(path: string, body?: unknown): Promise<Response> {
    return fetch(`${base}/sessions/${summary.dir}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

/** Polls `check` until it is true, at most 3 s. */
async function until(check: () => boolean): Promise<void> {
    for (let poll = 0; poll < 150; poll += 1) {
        if (check()) {
            return;
        }
        await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error("condition not met in time");
}

/** The fake pi's `echo: …` texts, in order. */
function echoes(): string[] {
    const texts: string[] = [];
    for (const event of events) {
        if (event.type !== "agent.event" || event.event.type !== "message_end") {
            continue;
        }
        const first = event.event.message.content[0];
        if (first !== undefined && first.type === "text") {
            texts.push(first.text);
        }
    }
    return texts;
}

function anchor(screenshot: string | null): PreviewAnchor {
    return {
        kind: "preview",
        service: "admin",
        url: `http://admin.s1.localhost/refunds?tab=2&token=${SECRET}`,
        selector: "#queue > li:nth-of-type(2)",
        text: "Refund 41",
        component: "RefundRow",
        source: "src/RefundQueue.tsx:41",
        rect: { x: 10.4, y: 20, width: 300, height: 40 },
        screenshot,
        console_errors: [`TypeError at fetch with key ${SECRET}`],
    };
}

async function upload(): Promise<AttachmentResponse> {
    const body = { mime: "image/png", data: PNG.toString("base64") };
    const response = await post("/attachments", body);
    expect(response.status).toBe(201);
    return (await response.json()) as AttachmentResponse;
}

async function needs_human(): Promise<string | null> {
    const read = read_session(home, summary.dir);
    if (!read.ok) {
        throw new Error(read.error);
    }
    return read.summary.session.needs_human;
}

describe("attachments", () => {
    it("saves a PNG under artifacts/comments and serves it back", async () => {
        const saved = await upload();
        expect(saved.path).toBe(`artifacts/comments/${saved.name}`);
        expect(readFileSync(join(summary.path, saved.path)).equals(PNG)).toBe(true);
        const served = await fetch(`${base}/sessions/${summary.dir}/attachments/${saved.name}`);
        expect(served.status).toBe(200);
        expect(served.headers.get("content-type")).toBe("image/png");
        expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
    });

    it("refuses a body that is not a PNG, and a name it did not give", async () => {
        const text = Buffer.from("hello").toString("base64");
        expect((await post("/attachments", { mime: "image/png", data: text })).status).toBe(400);
        const jpeg = { mime: "image/jpeg", data: PNG.toString("base64") };
        expect((await post("/attachments", jpeg)).status).toBe(400);
        const sneaky = `${base}/sessions/${summary.dir}/attachments/..%2Fsession.yaml`;
        const missing = await fetch(sneaky);
        expect(missing.status).toBe(404);
    });
});

describe("preview comments", () => {
    it("sends the comment with the image, keeps secrets out, and moves the thread", async () => {
        const added = await post("/agents", { name: "lead", message: "ready" });
        expect(added.status).toBe(201);
        await until(() => echoes().length === 1);
        const shot = await upload();

        const created = await post("/comments", {
            agent: "lead",
            text: `Make the amount bold; my key is ${SECRET}`,
            anchor: anchor(shot.path),
        });
        expect(created.status).toBe(201);
        const { comment, delivered } = (await created.json()) as CommentResponse;
        expect(comment.id).toBe("c1");
        expect(delivered).toBe("started");
        expect(comment).toMatchObject({ state: "open", waiting_on: "agent", agent: "lead" });

        // The agent's prompt: the text, the place and the image bytes.
        await until(() => echoes().length === 2);
        const prompt = echoes()[1] ?? "";
        expect(prompt).toContain("Preview comment c1 from operator on admin /refunds");
        expect(prompt).toContain("- component: RefundRow");
        expect(prompt).toContain(`- screenshot: ${join(summary.path, shot.path)}`);
        expect(prompt).toContain(`[1 image(s) of ${PNG.length} bytes]`);

        // The record on disk keeps no secret value, in the URL, the text or the errors.
        const record = readFileSync(join(summary.path, "artifacts", "comments", "c1.json"), "utf8");
        expect(record).not.toContain(SECRET);
        expect(record).toContain(`[redacted:${SECRET_NAME}]`);
        expect(record).toContain("token=%5Bredacted%5D");
        expect(prompt).not.toContain(SECRET);
        expect(events.some((e) => e.type === "comment.updated" && e.id === "c1")).toBe(true);

        // The agent answers: the comment now waits on the operator, who sees it as needs-you.
        const replied = await post("/comments/c1/reply", { author: "lead", text: "Which one?" });
        expect(((await replied.json()) as CommentResponse).comment.waiting_on).toBe("operator");
        expect(await needs_human()).toBe(
            "answer preview comment c1 on admin /refunds?tab=2&token=%5Bredacted%5D · RefundRow",
        );

        // The operator answers: it goes to the agent and waits on it again.
        const answered = await post("/comments/c1/reply", { text: "The second row." });
        const back = (await answered.json()) as CommentResponse;
        expect(back.comment).toMatchObject({ state: "open", waiting_on: "agent" });
        expect(back.delivered).toBeDefined();
        await until(() => echoes().some((text) => text.includes("The second row.")));
        expect(await needs_human()).toBeNull();

        // Only an agent suggests; only the operator resolves.
        expect((await post("/comments/c1/suggest-resolve", { text: "done" })).status).toBe(400);
        const suggested = await post("/comments/c1/suggest-resolve", {
            author: "lead",
            text: "Bold since a1b2c3.",
        });
        expect(((await suggested.json()) as CommentResponse).comment.state).toBe("suggested");
        expect(await needs_human()).toMatch(/^answer preview comment c1/);
        const resolved = await post("/comments/c1/resolve");
        expect(((await resolved.json()) as CommentResponse).comment.state).toBe("resolved");
        expect(await needs_human()).toBeNull();
        expect((await post("/comments/c1/reply", { text: "more" })).status).toBe(409);

        const listed = await fetch(`${base}/sessions/${summary.dir}/comments`);
        const { comments } = (await listed.json()) as CommentsResponse;
        expect(comments.map((entry) => entry.messages.length)).toEqual([4]);
    });

    it("keeps the text for a stopped agent; refuses an unknown one or a bad anchor", async () => {
        const nobody = { agent: "nobody", text: "x", anchor: anchor(null) };
        const unknown = await post("/comments", nobody);
        expect(unknown.status).toBe(404);
        await post("/agents", { name: "lead" });
        await until(() => echoes().length === 1);
        expect((await post("/agents/lead/stop")).status).toBe(200);

        const wider = { agent: "lead", text: "Wider.", anchor: anchor(null) };
        const created = await post("/comments", wider);
        expect(created.status).toBe(201);
        expect(((await created.json()) as CommentResponse).delivered).toBe("stopped");
        expect(daemon.agents.pending_for(summary.dir, "lead")[0]).toContain("Wider.");

        const doc = { kind: "doc", path: "docs/a.md", block: "Overview" };
        const on_doc = { agent: "lead", text: "x", anchor: doc };
        expect((await post("/comments", on_doc)).status).toBe(400);
        const outside = { agent: "lead", text: "x", anchor: anchor("artifacts/../session.yaml") };
        expect((await post("/comments", outside)).status).toBe(400);
        expect(existsSync(join(summary.path, "artifacts", "comments", "c2.json"))).toBe(false);
    });
});
