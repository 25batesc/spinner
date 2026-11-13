// The Projects view's routes. Method: a daemon on a temp home and a real git checkout; make a
// project, read its page, save its file, link a spec kept elsewhere, and remove both; then
// each refusal: an unknown name, a bad spec, a project of `examples/`, a project in use.
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectDetailResponse, ProjectsResponse } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "./home.js";
import { create_project } from "./projects.js";
import { start_daemon, type Daemon } from "./server.js";
import { create_session, write_session } from "./store/session-store.js";

let root: string;
let home: SpinnerHome;
let repo: string;
let daemon: Daemon;
let base: string;

function spec_for(name: string, path: string, host = "web"): string {
    return [
        `name: ${name}`,
        "base: main",
        "repos:",
        `  game: { path: ${path}, base: main }`,
        "services:",
        "  web:",
        "    repo: game",
        "    runtime: host",
        "    command: python3 -m http.server ${PORT}",
        `    host: ${host}`,
        "    healthcheck: GET /",
        "",
    ].join("\n");
}

beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "spinner-projects-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home"), SPINNER_SESSION_IDS: "home" });
    mkdirSync(home.root);
    repo = join(root, "game");
    mkdirSync(repo);
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repo });
    daemon = await start_daemon({
        home,
        port: 0,
        operator: false,
        log: () => undefined,
        poll_seconds: 0,
        gh: () => Promise.reject(new Error("no gh in tests")),
        notify: async () => {},
        ui_dir: null,
        observe_interval_ms: 60_000,
    });
    base = `http://127.0.0.1:${daemon.port}`;
});

afterEach(async () => {
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
});

function send(method: string, path: string, body?: object): Promise<Response> {
    return fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

async function detail(name: string): Promise<ProjectDetailResponse> {
    const response = await send("GET", `/projects/${name}`);
    expect(response.status).toBe(200);
    return (await response.json()) as ProjectDetailResponse;
}

async function refusal(response: Response): Promise<[number, string]> {
    const body = (await response.json()) as { error: string };
    return [response.status, body.error];
}

/** A live session whose `session.project` is `project`, with its stack `up`. */
function session_with(project: string): string {
    const summary = create_session(home, { title: "Snake work" });
    summary.session.project = project;
    summary.session.stack = { state: "up" };
    write_session(summary);
    return summary.dir;
}

describe("GET /projects/:name", () => {
    it("answers the file, what it sets with defaults, and the sessions that use it", async () => {
        create_project(home, spec_for("snake", repo), false, () => {});
        const dir = session_with("snake");
        const page = await detail("snake");
        expect(page.project.path).toBe(join(home.root, "projects", "snake", "spinner.yaml"));
        expect(page.spec).toBe(spec_for("snake", repo));
        expect(page).toMatchObject({ writable: true, linked: false });
        expect(page.summary.repos).toEqual([
            { key: "game", path: repo, absolute: repo, base: "main", git: true },
        ]);
        expect(page.summary.services).toEqual([{
            name: "web", runtime: "host", repo: "game",
            command: "python3 -m http.server ${PORT}", image: null, host: "web", port: null,
            healthcheck: "GET /", preview: "frame", depends_on: [],
        }]);
        expect(page.summary.database).toBeNull();
        expect(page.summary.pipeline).toMatchObject({
            write_repos: [], bot_logins: [], merge_queue: "none", approval_check: null,
            slack_post: "confirm", threads_autofix: "off",
        });
        expect(page.sessions).toEqual([{ dir, id: "s001", title: "Snake work", stack: "up" }]);
    });

    it("marks a project of examples/ read-only, and answers 404 for an unknown name", async () => {
        const page = await detail("sample");
        expect(page).toMatchObject({ writable: false, linked: false });
        expect(page.summary.database).toMatchObject({ server: "spinner-postgres" });
        expect((await send("GET", "/projects/nowhere")).status).toBe(404);
    });
});

describe("PUT /projects/:name/spec", () => {
    it("saves a spec that loads and answers the new page", async () => {
        create_project(home, spec_for("snake", repo), false, () => {});
        const response = await send("PUT", "/projects/snake/spec", {
            spec: spec_for("snake", repo, "play"),
        });
        expect(response.status).toBe(200);
        const page = (await response.json()) as ProjectDetailResponse;
        expect(page.summary.services[0]?.host).toBe("play");
        const path = join(home.root, "projects", "snake", "spinner.yaml");
        expect(readFileSync(path, "utf8")).toContain("host: play");
    });

    it("refuses a bad spec with the reason, another name, an unknown and an example", async () => {
        create_project(home, spec_for("snake", repo), false, () => {});
        const put = (name: string, spec: string) =>
            send("PUT", `/projects/${name}/spec`, { spec }).then(refusal);
        expect(await put("snake", "name: [")).toEqual([400, expect.stringMatching(/not YAML/)]);
        const no_git = spec_for("snake", join(root, "nowhere"));
        expect(await put("snake", no_git)).toEqual([400, expect.stringMatching(/git checkout/)]);
        expect(await put("snake", spec_for("worm", repo))).toEqual([
            400, `the spec's name is "worm"; it must be "snake"`,
        ]);
        expect((await put("worm", spec_for("worm", repo)))[0]).toBe(404);
        expect((await put("sample", spec_for("sample", repo)))[0]).toBe(409);
        const path = join(home.root, "projects", "snake", "spinner.yaml");
        expect(readFileSync(path, "utf8")).toBe(spec_for("snake", repo));
    });
});

describe("POST /projects/link and DELETE /projects/:name", () => {
    it("links a spec kept elsewhere, saves through the link, and unlinks it", async () => {
        const elsewhere = join(root, "elsewhere");
        mkdirSync(elsewhere);
        writeFileSync(join(elsewhere, "spinner.yaml"), spec_for("linked", repo));
        const made = await send("POST", "/projects/link", { path: elsewhere });
        expect(made.status).toBe(201);
        const page = (await made.json()) as ProjectDetailResponse;
        expect(page).toMatchObject({ writable: true, linked: true });
        expect(page.project.source).toBe("home");
        const listed = (await (await send("GET", "/projects")).json()) as ProjectsResponse;
        expect(listed.projects.map((project) => project.name)).toContain("linked");

        const again = await send("POST", "/projects/link", { path: elsewhere });
        expect(await refusal(again)).toEqual([409, expect.stringMatching(/exists/)]);

        const saved = await send("PUT", "/projects/linked/spec", {
            spec: spec_for("linked", repo, "play"),
        });
        expect(saved.status).toBe(200);
        expect(readFileSync(join(elsewhere, "spinner.yaml"), "utf8")).toContain("host: play");

        expect((await send("DELETE", "/projects/linked")).status).toBe(200);
        expect(existsSync(join(home.root, "projects", "linked"))).toBe(false);
        expect(existsSync(join(elsewhere, "spinner.yaml"))).toBe(true);
    });

    it("refuses to link a spec that does not load", async () => {
        const broken = join(root, "broken");
        mkdirSync(broken);
        writeFileSync(join(broken, "spinner.yaml"), "name: broken\n");
        const response = await send("POST", "/projects/link", { path: broken });
        expect(await refusal(response)).toEqual([400, expect.stringMatching(/does not load/)]);
    });

    it("removes a home directory that holds only the spec", async () => {
        create_project(home, spec_for("snake", repo), false, () => {});
        expect((await send("DELETE", "/projects/snake")).status).toBe(200);
        expect(existsSync(join(home.root, "projects", "snake"))).toBe(false);
    });

    it("refuses a project in use, one with other files, and one of examples/", async () => {
        create_project(home, spec_for("snake", repo), false, () => {});
        const dir = session_with("snake");
        const used = await send("DELETE", "/projects/snake");
        expect(await refusal(used)).toEqual([409, expect.stringContaining(dir)]);

        create_project(home, spec_for("worm", repo), false, () => {});
        writeFileSync(join(home.root, "projects", "worm", "seed.sql"), "");
        const full = await send("DELETE", "/projects/worm");
        expect(await refusal(full)).toEqual([409, expect.stringMatching(/other files: seed.sql/)]);

        const example = await send("DELETE", "/projects/sample");
        expect(await refusal(example)).toEqual([409, expect.stringMatching(/under examples/)]);
        expect((await send("DELETE", "/projects/nowhere")).status).toBe(404);
    });

    it("never follows a link inside a home directory when it removes", async () => {
        create_project(home, spec_for("snake", repo), false, () => {});
        const kept = join(root, "kept");
        mkdirSync(kept);
        symlinkSync(kept, join(home.root, "projects", "snake", "data"));
        expect((await send("DELETE", "/projects/snake")).status).toBe(409);
        expect(existsSync(kept)).toBe(true);
    });
});
