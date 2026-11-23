// Goal: the Files view reads and edits only the session's own files. Method: a daemon on a
// temporary home, a session directory with documents, a machine directory, a transcript and
// a link that leaves the session; every step goes through the HTTP routes, with a recorder
// in place of the file manager and a temporary folder as the Downloads folder.
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    SESSION_FILE_TEXT_BYTES_MAX,
    session_file_listed,
    type SessionFileDownloadResponse,
    type SessionFileResponse,
    type SessionFilesResponse,
    type SessionSummary,
} from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { start_daemon, type Daemon } from "../server.js";
import { create_session } from "../store/session-store.js";

let home: SpinnerHome;
let daemon: Daemon;
let summary: SessionSummary;
let downloads: string;
let outside: string;
let revealed: string[];

function put(relative: string, text: string | Buffer): void {
    const path = join(summary.path, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
}

beforeEach(async () => {
    home = resolve_home({ SPINNER_HOME: mkdtempSync(join(tmpdir(), "spinner-files-")) });
    downloads = mkdtempSync(join(tmpdir(), "spinner-downloads-"));
    outside = mkdtempSync(join(tmpdir(), "spinner-outside-"));
    revealed = [];
    daemon = await start_daemon({
        home,
        port: 0,
        log: () => undefined,
        poll_seconds: 0,
        gh: () => Promise.reject(new Error("no gh in tests")),
        notify: async () => undefined,
        ui_dir: null,
        observe_interval_ms: 60_000,
        files: {
            downloads_dir: downloads,
            reveal: (absolute) => {
                revealed.push(absolute);
                return Promise.resolve();
            },
        },
    });
    summary = create_session(home, { title: "Alpha" });
    put("egm/concepts_brief.md", "# Brief\n\nThe first idea.\n");
    put("artifacts/team-writeup.md", "# Writeup\n");
    put("artifacts/shot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    put("agents/lead/NOTES.md", "notes\n");
    put("agents/lead/pi/sessions/t.jsonl", "{}\n");
    put("worktrees/backend/README.md", "# repo\n");
    put("egm-runs/run-1/status.json", "{}\n");
    put("artifacts/node_modules/x/index.js", "x\n");
    put(".hidden.md", "no\n");
    writeFileSync(join(outside, "secret.md"), "outside\n");
    symlinkSync(join(outside, "secret.md"), join(summary.path, "artifacts", "link.md"));
    symlinkSync(outside, join(summary.path, "artifacts", "linked-dir"));
});

afterEach(async () => {
    await daemon.close();
    for (const dir of [home.root, downloads, outside]) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function url(path: string): string {
    return `http://127.0.0.1:${daemon.port}/sessions/${summary.dir}/files${path}`;
}

function send(method: string, path: string, body: unknown): Promise<Response> {
    return fetch(url(path), {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

async function read(path: string): Promise<SessionFileResponse> {
    const response = await fetch(url(`/text?path=${encodeURIComponent(path)}`));
    expect(response.status).toBe(200);
    return (await response.json()) as SessionFileResponse;
}

describe("session files", () => {
    it("lists the documents as a tree and leaves the machine directories out", async () => {
        const body = (await (await fetch(url(""))).json()) as SessionFilesResponse;
        const paths = body.entries.map((entry) => entry.path);
        expect(paths).toEqual(expect.arrayContaining([
            "MISSION.md",
            "agents",
            "agents/lead",
            "agents/lead/NOTES.md",
            "artifacts",
            "artifacts/team-writeup.md",
            "egm",
            "egm/concepts_brief.md",
            "session.yaml",
        ]));
        // Sorted, so the page can nest them in one pass.
        expect(paths).toEqual([...paths].sort());
        const hidden = ["worktrees", "egm-runs", "/pi", "node_modules", ".hidden", "link"];
        for (const part of hidden) {
            expect(paths.filter((path) => path.includes(part))).toEqual([]);
        }
        const brief = body.entries.find((entry) => entry.path === "egm/concepts_brief.md");
        expect(brief).toMatchObject({ kind: "file", bytes: 25 });
        expect(body.entries.find((entry) => entry.path === "egm")).toMatchObject({ kind: "dir" });
        expect(body.truncated).toBe(false);
        expect(body.root).toBe(summary.path);
    });

    it("reads a text file and refuses what the tree does not list", async () => {
        const brief = await read("egm/concepts_brief.md");
        expect(brief).toMatchObject({ text: "# Brief\n\nThe first idea.\n", editable: true });
        expect(brief.absolute.endsWith("/egm/concepts_brief.md")).toBe(true);
        expect((await read("MISSION.md")).editable).toBe(false);
        const refused: Array<[string, number]> = [
            ["../outside.md", 400],
            ["egm/../../x.md", 400],
            [join(outside, "secret.md"), 400],
            ["worktrees/backend/README.md", 400],
            ["agents/lead/pi/sessions/t.jsonl", 400],
            [".hidden.md", 400],
            // A link that leaves the session, as a file and through a directory.
            ["artifacts/link.md", 400],
            ["artifacts/linked-dir/secret.md", 400],
            ["egm/nothing.md", 404],
            ["egm", 400],
            ["artifacts/shot.png", 415],
        ];
        for (const [path, status] of refused) {
            const response = await fetch(url(`/text?path=${encodeURIComponent(path)}`));
            expect([path, response.status]).toEqual([path, status]);
        }
        put("artifacts/big.log", "x".repeat(SESSION_FILE_TEXT_BYTES_MAX + 1));
        expect((await fetch(url("/text?path=artifacts/big.log"))).status).toBe(413);
    });

    it("saves an edit, and refuses one made on a version the file has left", async () => {
        const path = "egm/concepts_brief.md";
        const on_disk = (): string => readFileSync(join(summary.path, path), "utf8");
        const first = await read(path);
        const edit = { path, text: "# Brief\n\nEdited.\n", mtime: first.mtime };
        const saved = await send("PUT", "/text", edit);
        expect(saved.status).toBe(200);
        expect(on_disk()).toBe("# Brief\n\nEdited.\n");
        expect(existsSync(join(summary.path, `${path}.spinner-save`))).toBe(false);
        // An agent writes the file; the page still holds the older version.
        const body = (await saved.json()) as SessionFileResponse;
        put(path, "# Brief\n\nThe agent's text.\n");
        utimesSync(join(summary.path, path), new Date(), new Date(Date.now() + 5000));
        const stale = await send("PUT", "/text", { path, text: "mine", mtime: body.mtime });
        expect(stale.status).toBe(409);
        expect(on_disk()).toBe("# Brief\n\nThe agent's text.\n");
        // Spinner's own files are read-only from the page.
        const mission = await read("MISSION.md");
        const own = { path: "MISSION.md", text: "x", mtime: mission.mtime };
        expect((await send("PUT", "/text", own)).status).toBe(409);
        expect((await send("PUT", "/text", { path, text: 3, mtime: "x" })).status).toBe(400);
        const climbing = { path: "../x", text: "", mtime: "x" };
        expect((await send("PUT", "/text", climbing)).status).toBe(400);
    });

    it("serves an image inline and any other file as a download", async () => {
        const image = await fetch(url("/raw?path=artifacts/shot.png"));
        expect(image.headers.get("content-type")).toBe("image/png");
        expect(image.headers.get("content-disposition")).toContain("inline");
        put("artifacts/page.html", "<script>alert(1)</script>");
        const page = await fetch(url("/raw?path=artifacts/page.html"));
        expect(page.headers.get("content-type")).toBe("application/octet-stream");
        expect(page.headers.get("content-disposition")).toContain("attachment");
        expect(page.headers.get("x-content-type-options")).toBe("nosniff");
        expect((await fetch(url("/raw?path=worktrees/backend/README.md"))).status).toBe(400);
    });

    it("reveals a file or the session directory, and copies a file to Downloads", async () => {
        const writeup = { path: "artifacts/team-writeup.md" };
        expect((await send("POST", "/reveal", writeup)).status).toBe(200);
        expect((await send("POST", "/reveal", { path: "" })).status).toBe(200);
        expect(revealed.map((path) => path.split("/").slice(-2).join("/"))).toEqual([
            "artifacts/team-writeup.md",
            `sessions/${summary.dir}`,
        ]);
        expect((await send("POST", "/reveal", { path: "worktrees/backend" })).status).toBe(400);
        expect(revealed).toHaveLength(2);

        const first = await send("POST", "/download", writeup);
        expect(first.status).toBe(201);
        const copy = ((await first.json()) as SessionFileDownloadResponse).saved;
        expect(copy).toBe(join(downloads, "team-writeup.md"));
        expect(readFileSync(copy, "utf8")).toBe("# Writeup\n");
        // A second copy never overwrites the first.
        const second = await send("POST", "/download", writeup);
        const again = ((await second.json()) as SessionFileDownloadResponse).saved;
        expect(again).toBe(join(downloads, "team-writeup (1).md"));
        expect((await send("POST", "/download", { path: "artifacts" })).status).toBe(400);
        expect((await send("POST", "/download", { path: "artifacts/link.md" })).status).toBe(400);
    });

    it("names what the tree lists", () => {
        expect(session_file_listed("egm/reviews/r1/critic_report.md")).toBe(true);
        expect(session_file_listed("agents/lead/BRIEF.md")).toBe(true);
        expect(session_file_listed("agents/lead/pi")).toBe(false);
        expect(session_file_listed("log/daemon.log")).toBe(false);
        expect(session_file_listed("artifacts/.cache/x")).toBe(false);
        expect(session_file_listed("")).toBe(false);
    });
});
