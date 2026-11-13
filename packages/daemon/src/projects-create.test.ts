// A project made from inside a session. Method: a temp home and a real git checkout; make a
// project from spinner.yaml text and read it back through the list; then each refusal: a
// spec that does not load, a repo path that is not a checkout, a name that is taken.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionSummary } from "@spinner/protocol";
import { attach_blocker } from "./agents/routes.js";
import { resolve_home, type SpinnerHome } from "./home.js";
import { PROJECT_EXAMPLE, ProjectRefusal, create_project, list_projects } from "./projects.js";
import { check_spec_shape } from "./stack/spec.js";
import { parse } from "yaml";

let root: string;
let home: SpinnerHome;
let repo: string;
const log = (): void => {};

function spec_for(name: string, path: string): string {
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
        "    host: web",
        "    healthcheck: GET /",
        "",
    ].join("\n");
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "spinner-projects-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home"), SPINNER_SESSION_IDS: "home" });
    repo = join(root, "game");
    mkdirSync(repo);
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repo });
});

describe("create_project", () => {
    it("saves a spec that loads and lists it as a home project", () => {
        const made = create_project(home, spec_for("snake", repo), false, log);
        expect(made).toEqual({
            name: "snake",
            path: join(home.root, "projects", "snake", "spinner.yaml"),
            source: "home",
            repos: ["game"],
            services: ["web"],
        });
        expect(readFileSync(made.path, "utf8")).toContain("name: snake");
        const listed = list_projects(home, log).find((project) => project.name === "snake");
        expect(listed?.path).toBe(made.path);
    });

    it("refuses a spec that does not load, with the reason", () => {
        const refusal = (text: string): unknown => {
            try {
                create_project(home, text, false, log);
            } catch (error) {
                return error;
            }
            return null;
        };
        expect(refusal("name: [")).toMatchObject({ status: 400 });
        expect(String(refusal("name: snake\nbase: main\n"))).toMatch(/missing mapping `repos`/);
        const relative = refusal(spec_for("snake", "code/game"));
        expect(String(relative)).toMatch(/repos.game.path must be absolute or start with ~/);
        const no_git = refusal(spec_for("snake", join(root, "nowhere")));
        expect(no_git).toBeInstanceOf(ProjectRefusal);
        expect(String(no_git)).toMatch(/is not a git checkout; run git init/);
        expect(list_projects(home, log).some((project) => project.name === "snake")).toBe(false);
    });

    it("never writes over a project it did not make; replaces its own when asked", () => {
        create_project(home, spec_for("snake", repo), false, log);
        expect(() => create_project(home, spec_for("snake", repo), false, log)).toThrow(
            /a project "snake" exists .* pass replace: true/,
        );
        const changed = spec_for("snake", repo).replace("host: web", "host: play");
        const replaced = create_project(home, changed, true, log);
        expect(readFileSync(replaced.path, "utf8")).toContain("host: play");
        // A linked project directory (the operator's own spec elsewhere) is never replaced.
        const elsewhere = join(root, "elsewhere");
        mkdirSync(elsewhere);
        writeFileSync(join(elsewhere, "spinner.yaml"), spec_for("linked", repo));
        symlinkSync(elsewhere, join(home.root, "projects", "linked"));
        expect(() => create_project(home, spec_for("linked", repo), true, log)).toThrow(
            /a project "linked" exists .* pick another name/,
        );
        expect(readFileSync(join(elsewhere, "spinner.yaml"), "utf8")).toContain("host: web");
    });

    it("the example of `project help` is a spec that loads", () => {
        expect(check_spec_shape(parse(PROJECT_EXAMPLE))).toBeNull();
    });
});

describe("attach_blocker", () => {
    const summary = (session: object): SessionSummary =>
        ({ dir: "s9-game", path: "/x", session: { repos: {}, ...session } }) as SessionSummary;

    it("lets a session without a project take one, and keep the one it has", () => {
        expect(attach_blocker(summary({}), "snake")).toBeNull();
        expect(attach_blocker(summary({ project: "snake" }), "snake")).toBeNull();
        expect(attach_blocker(summary({ project: "knit" }), "snake")).toMatch(
            /has the project knit; a session keeps its project/,
        );
        expect(attach_blocker(summary({ kind: "review" }), "snake")).toMatch(/review session/);
    });
});
