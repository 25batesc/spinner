// Goal: an upload keeps a safe name with its extension under `artifacts/uploads/` and is
// bounded at 10 MiB; a message's `images` reach pi only when each is a PNG under
// `artifacts/`; the rpc harness switches the model and the thinking level with pi's own
// commands. Method: the pure functions on a temporary session, and a daemon on port 0 with
// the fake rpc pi (`test/fixtures/fake-pi.ts`), which echoes the images it got.
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session, SpinnerEvent, UploadResponse } from "@spinner/protocol";
import { UPLOAD_BYTES_MAX } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { start_daemon, type Daemon } from "../server.js";
import { create_session } from "../store/session-store.js";
import { message_images, parse_upload, safe_upload_name, save_upload } from "./uploads.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(here, "..", "..", "test", "fixtures", "fake-pi.ts");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "spinner-uploads-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("upload rules", () => {
    it("keeps the last path part and the extension, and drops odd characters", () => {
        expect(safe_upload_name("../../etc/passwd")).toBe("passwd");
        expect(safe_upload_name("C:\\Users\\me\\Q3 report (final).PDF")).toBe(
            "Q3-report-final.PDF",
        );
        expect(safe_upload_name("notes.v2.md")).toBe("notes-v2.md");
        expect(safe_upload_name(".env")).toBe("env");
        expect(safe_upload_name("日本.txt")).toBe("file.txt");
        expect(safe_upload_name("a".repeat(300)).length).toBe(80);
    });

    it("takes base64 up to 10 MiB decoded and refuses a bad body", () => {
        const data = Buffer.from("hello").toString("base64");
        expect(parse_upload({ name: "a.txt", data })).toEqual({
            name: "a.txt",
            bytes: Buffer.from("hello"),
        });
        const limit = Buffer.alloc(UPLOAD_BYTES_MAX).toString("base64");
        expect("bytes" in parse_upload({ name: "big.bin", data: limit })).toBe(true);
        const over = Buffer.alloc(UPLOAD_BYTES_MAX + 1).toString("base64");
        expect(parse_upload({ name: "big.bin", data: over })).toMatchObject({ status: 413 });
        expect(parse_upload({ name: "", data })).toMatchObject({ status: 400 });
        expect(parse_upload({ name: "a.txt", data: "not base64!" })).toMatchObject({
            status: 400,
        });
        expect(parse_upload([])).toMatchObject({ status: 400 });
    });

    it("saves under artifacts/uploads/<stamp>-<safe name>, two of one name apart", () => {
        const now = new Date("2026-03-04T05:06:07Z");
        const upload = { name: "../my notes.md", bytes: Buffer.from("# hi") };
        const first = save_upload(root, upload, now);
        const second = save_upload(root, upload, now);
        expect(first.name).toMatch(/^20260304-050607-[0-9a-f]{6}-my-notes\.md$/);
        expect(first.path).toBe(`artifacts/uploads/${first.name}`);
        expect(second.name).not.toBe(first.name);
        expect(readFileSync(join(root, first.path), "utf8")).toBe("# hi");
    });

    it("lets a message carry only PNGs under artifacts/", () => {
        mkdirSync(join(root, "artifacts", "uploads"), { recursive: true });
        writeFileSync(join(root, "artifacts", "uploads", "a.png"), PNG);
        writeFileSync(join(root, "artifacts", "uploads", "a.txt"), "text");
        writeFileSync(join(root, "outside.png"), PNG);
        symlinkSync(join(root, "outside.png"), join(root, "artifacts", "link.png"));
        const absolute = message_images(root, ["artifacts/uploads/a.png"]);
        expect(absolute).toEqual([join(realpathSync(root), "artifacts", "uploads", "a.png")]);
        expect(message_images(root, [])).toEqual([]);
        expect(message_images(root, ["artifacts/uploads/a.txt"])).toMatch(/not a PNG/);
        expect(message_images(root, ["outside.png"])).toMatch(/not under artifacts/);
        expect(message_images(root, ["artifacts/../outside.png"])).toMatch(/not under/);
        expect(message_images(root, ["artifacts/link.png"])).toMatch(/not under artifacts/);
        expect(message_images(root, ["artifacts/none.png"])).toMatch(/does not exist/);
        expect(message_images(root, [join(root, "artifacts/uploads/a.png")])).toMatch(
            /must be relative/,
        );
    });
});

describe("uploads, images and settings through the daemon (rpc harness)", () => {
    let home: SpinnerHome;
    let daemon: Daemon;
    let events: SpinnerEvent[];

    beforeEach(async () => {
        chmodSync(FAKE_PI, 0o755);
        home = resolve_home({ SPINNER_HOME: join(root, "home") });
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
            extension: null,
        });
        events = [];
        daemon.bus.subscribe((event) => events.push(event));
    });

    afterEach(async () => {
        await daemon.close();
    });

    function call(method: string, path: string, body?: unknown): Promise<Response> {
        return fetch(`http://127.0.0.1:${daemon.port}${path}`, {
            method,
            headers: { "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    }

    function echoes(): string[] {
        return events.flatMap((event) => {
            if (event.type !== "agent.event" || event.event.type !== "message_end") {
                return [];
            }
            const content = event.event.message.content;
            const first = Array.isArray(content) ? content[0] : undefined;
            return first?.type === "text" ? [first.text] : [];
        });
    }

    it("uploads a PNG, sends it with a prompt, and refuses a path outside artifacts/", async () => {
        const summary = create_session(home, { title: "Uploads" });
        mkdirSync(join(summary.path, "agents", "backend"), { recursive: true });
        writeFileSync(join(summary.path, "agents", "backend", "BRIEF.md"), "# backend\n");
        const agents = `/sessions/${summary.dir}/agents`;
        expect((await call("POST", agents, { name: "backend", message: "hi" })).status).toBe(201);

        const uploads = `/sessions/${summary.dir}/uploads`;
        const data = PNG.toString("base64");
        const saved = await call("POST", uploads, { name: "shot.png", data });
        expect(saved.status).toBe(201);
        const body = (await saved.json()) as UploadResponse;
        expect(body.path).toBe(`artifacts/uploads/${body.name}`);
        expect((await call("POST", uploads, { name: "x", data: 1 })).status).toBe(400);
        expect((await call("POST", "/sessions/nope/uploads", { name: "x", data })).status).toBe(
            404,
        );

        const prompt = await call("POST", `${agents}/backend/prompt`, {
            text: "look",
            images: [body.path],
        });
        expect(prompt.status).toBe(200);
        const echo = `echo: look [1 image(s) of ${PNG.length} bytes]`;
        for (let poll = 0; poll < 200 && !echoes().includes(echo); poll += 1) {
            await new Promise((resolve_) => setTimeout(resolve_, 20));
        }
        expect(echoes()).toContain(echo);

        const outside = await call("POST", `${agents}/backend/steer`, {
            text: "look",
            images: ["session.yaml"],
        });
        expect(outside.status).toBe(400);
        const many = Array.from({ length: 9 }, () => body.path);
        const nine = await call("POST", `${agents}/backend/prompt`, { text: "x", images: many });
        expect(nine.status).toBe(400);
    });

    it("sets the model and the thinking level with pi's rpc commands", async () => {
        const summary = create_session(home, { title: "Settings" });
        mkdirSync(join(summary.path, "agents", "backend"), { recursive: true });
        writeFileSync(join(summary.path, "agents", "backend", "BRIEF.md"), "# backend\n");
        const agents = `/sessions/${summary.dir}/agents`;
        expect((await call("POST", agents, { name: "backend", message: "hi" })).status).toBe(201);
        const record = () =>
            (parse(readFileSync(join(summary.path, "session.yaml"), "utf8")) as Session).agents[
                "backend"
            ];

        const model = await call("POST", `${agents}/backend/model`, { model: "openai/gpt-y" });
        expect(model.status).toBe(200);
        expect(record()?.model).toBe("openai/gpt-y");
        const unknown = await call("POST", `${agents}/backend/model`, { model: "openai/nope" });
        expect(unknown.status).toBe(400);
        expect(await unknown.json()).toEqual({ error: "Model not found: openai/nope" });
        const thinking = await call("POST", `${agents}/backend/thinking`, { level: "xhigh" });
        expect(thinking.status).toBe(200);
        expect(record()?.thinking).toBe("xhigh");
    });
});
