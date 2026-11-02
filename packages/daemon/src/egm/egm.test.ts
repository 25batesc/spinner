// Goal: the EGM fetch, the adapter and the spawn decision behave as entry 1.13 of
// docs/designs/egm-adoption.md says. Method: real files in scratch directories; the only
// seam is the command runner, which creates the checkout's files on `git checkout` instead
// of cloning from GitHub.
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EGM_ADAPTER_VERSION, EGM_REQUIRED_FILES, type SessionSummary } from "@spinner/protocol";
import { describe, expect, it } from "vitest";
import type { Runner } from "../git/pinned-clone.js";
import type { SpinnerHome } from "../home.js";
import { kind_of, read_persona_header, render_pi_agent, write_adapter } from "./adapter.js";
import {
    EgmFetcher,
    egm_adapter_dir,
    egm_fetched,
    egm_source_dir,
    fetch_egm,
    marker_path,
    read_egm_marker,
} from "./fetch.js";
import { EGM_PIN } from "./pins.js";
import { egm_spawn, subagents_installed } from "./spawn.js";

const log = (): void => {};

function scratch(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

function make_home(): SpinnerHome {
    const root = scratch("spinner-egm-");
    mkdirSync(join(root, "sessions"));
    return {
        root,
        sessions: join(root, "sessions"),
        archive: join(root, "archive"),
        proxy: join(root, "proxy"),
        ids_scope: "home",
    };
}

function persona(name: string): string {
    const header = [`name: ${name}`, `description: The ${name} persona.`, "license: Apache-2.0"];
    return `---\n${header.join("\n")}\n---\n\n# Body\n`;
}

/** Writes every required file of a checkout, with a parseable header on each persona. */
function write_checkout(source: string): void {
    for (const file of EGM_REQUIRED_FILES) {
        const path = join(source, file);
        mkdirSync(dirname(path), { recursive: true });
        const name = file.startsWith("agents/") ? `egm-${file.slice(7, -3)}` : "";
        writeFileSync(path, name === "" ? "x\n" : persona(name));
    }
}

/** A runner that "clones" by writing the checkout when `git checkout` runs. */
const cloning_runner: Runner = (command, args, options) => {
    if (command === "git" && args[0] === "checkout") {
        write_checkout(options?.cwd ?? "");
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
};

function write_marker(home: SpinnerHome, sha: string, version: number): void {
    mkdirSync(dirname(marker_path(home)), { recursive: true });
    const marker = { sha, adapter_version: version, fetched: "2026-11-02T18:00:00.000Z" };
    writeFileSync(marker_path(home), JSON.stringify(marker));
}

function make_session(home: SpinnerHome, kind?: "session" | "review"): SessionSummary {
    const dir = "s040-egm";
    const path = join(home.sessions, dir);
    mkdirSync(path, { recursive: true });
    return {
        dir,
        path,
        session: {
            version: 1,
            id: "s040",
            slug: "egm",
            title: "egm",
            created: "2026-11-02T00:00:00Z",
            stage: "planned",
            needs_human: null,
            branch: "feat/egm",
            base: "main",
            repos: {},
            stack: { state: "none" },
            agents: {},
            ...(kind === undefined ? {} : { kind }),
        },
    };
}

function pi_dir(packages: unknown): string {
    const dir = scratch("spinner-pi-");
    if (packages !== undefined) {
        writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages }));
    }
    return dir;
}

describe("render_pi_agent", () => {
    const base = {
        name: "egm-zoom-out",
        description: 'Skeptical "architect".',
        persona_path: "/egm/src/agents/zoom_out.md",
        source_root: "/egm/src",
    };

    it("renders a reviewer: read-only tools and acceptanceRole, the frontmatter in order", () => {
        const text = render_pi_agent({ ...base, kind: "reviewer" });
        const header = text.split("\n---\n")[0]!.split("\n");
        expect(header).toEqual([
            "---",
            "name: egm-zoom-out",
            'description: "Skeptical \\"architect\\"."',
            "tools: read, grep, find, ls",
            "acceptanceRole: read-only",
            "systemPromptMode: replace",
            "inheritProjectContext: false",
            "inheritGlobalContext: false",
            "inheritSkills: false",
            "extensions:",
            "defaultContext: fresh",
        ]);
        expect(text).toContain("Read `/egm/src/agents/zoom_out.md` before reviewing.");
        expect(text).toContain("report an incomplete review instead of a verdict");
    });

    it("renders the synthesizer without subagent and without acceptanceRole", () => {
        const text = render_pi_agent({ ...base, kind: "synthesizer" });
        expect(text).toContain("\ntools: read, grep, find, ls, write\n");
        expect(text).not.toContain("acceptanceRole");
        expect(text).not.toMatch(/^tools:.*subagent/m);
        expect(text).toContain("This harness cannot nest subagents; use direct dispatch.");
        expect(text).toContain("`/egm/src/agents/zoom_out.md`");
    });

    it("renders the bootstrap orchestrator with subagent and without acceptanceRole", () => {
        const text = render_pi_agent({ ...base, kind: "bootstrap" });
        expect(text).toContain("\ntools: read, grep, find, ls, write, edit, bash, subagent\n");
        expect(text).not.toContain("acceptanceRole");
        expect(text).toContain("Never stage, commit or push.");
        expect(text).toContain("`/egm/src/agents/zoom_out.md`");
    });

    it("picks the kind from the file name", () => {
        expect(kind_of("synthesizer.md")).toBe("synthesizer");
        expect(kind_of("bootstrap_orchestrator.md")).toBe("bootstrap");
        expect(kind_of("style.md")).toBe("reviewer");
    });
});

describe("read_persona_header", () => {
    it("reads a plain and a folded description; refuses a persona without a name", () => {
        expect(read_persona_header(persona("egm-style"))).toEqual({
            name: "egm-style",
            description: "The egm-style persona.",
        });
        const folded = "---\nname: egm-x\ndescription: >-\n  one\n  two\n---\n";
        expect(read_persona_header(folded).description).toBe("one two");
        expect(() => read_persona_header("---\ndescription: d\n---\n")).toThrow(
            "persona without a name",
        );
    });
});

describe("write_adapter", () => {
    it("writes one file per persona and removes a stale file", () => {
        const source = scratch("spinner-egm-src-");
        mkdirSync(join(source, "agents"));
        for (const file of ["zoom_out", "synthesizer", "bootstrap_orchestrator"]) {
            writeFileSync(join(source, "agents", `${file}.md`), persona(`egm-${file}`));
        }
        const adapter = join(scratch("spinner-egm-pi-"), "agents");
        mkdirSync(adapter);
        writeFileSync(join(adapter, "stale.md"), "old");
        const names = write_adapter(source, adapter);
        expect(names.sort()).toEqual([
            "egm-bootstrap_orchestrator",
            "egm-synthesizer",
            "egm-zoom_out",
        ]);
        expect(readdirSync(adapter).sort()).toEqual([
            "bootstrap_orchestrator.md",
            "synthesizer.md",
            "zoom_out.md",
        ]);
        expect(readFileSync(join(adapter, "zoom_out.md"), "utf8")).toContain(
            `Read \`${join(source, "agents", "zoom_out.md")}\``,
        );
    });

    it("throws past 50 persona files", () => {
        const source = scratch("spinner-egm-src-");
        mkdirSync(join(source, "agents"));
        for (let index = 0; index < 51; index += 1) {
            writeFileSync(join(source, "agents", `p${index}.md`), persona(`egm-p${index}`));
        }
        const adapter = join(scratch("spinner-egm-pi-"), "agents");
        expect(() => write_adapter(source, adapter)).toThrow("more than 50 persona files");
        expect(existsSync(adapter)).toBe(false);
    });
});

describe("egm_fetched", () => {
    it("is false without a marker, with another sha or adapter version, or a missing file", () => {
        const home = make_home();
        write_checkout(egm_source_dir(home));
        expect(egm_fetched(home)).toBe(false);
        write_marker(home, "0".repeat(40), EGM_ADAPTER_VERSION);
        expect(egm_fetched(home)).toBe(false);
        write_marker(home, EGM_PIN.sha, EGM_ADAPTER_VERSION + 1);
        expect(egm_fetched(home)).toBe(false);
        write_marker(home, EGM_PIN.sha, EGM_ADAPTER_VERSION);
        expect(egm_fetched(home)).toBe(true);
        rmSync(join(egm_source_dir(home), "docs", "harnesses.md"));
        expect(egm_fetched(home)).toBe(false);
    });
});

describe("fetch_egm", () => {
    it("clones the pin, writes the adapter, then the marker", async () => {
        const home = make_home();
        const calls: string[] = [];
        const runner: Runner = (command, args, options) => {
            calls.push(`${command} ${args.join(" ")}`);
            return cloning_runner(command, args, options);
        };
        const marker = await fetch_egm(home, log, runner);
        expect(marker.sha).toBe(EGM_PIN.sha);
        expect(calls).toContain(`git fetch --quiet --depth 1 origin ${EGM_PIN.sha}`);
        expect(read_egm_marker(home)?.adapter_version).toBe(EGM_ADAPTER_VERSION);
        expect(readdirSync(egm_adapter_dir(home))).toHaveLength(9);
        expect(egm_fetched(home)).toBe(true);
    });

    it("leaves no marker when git fetch fails", async () => {
        const home = make_home();
        const runner: Runner = (command, args) =>
            Promise.resolve(
                args[0] === "fetch"
                    ? { code: 128, stdout: "", stderr: "unreachable" }
                    : { code: 0, stdout: "", stderr: "" },
            );
        await expect(fetch_egm(home, log, runner)).rejects.toThrow(/git fetch.*exited 128/);
        expect(read_egm_marker(home)).toBeNull();
        const fetcher = new EgmFetcher(home, { PI_CODING_AGENT_DIR: pi_dir(undefined) }, runner);
        expect(await fetcher.ensure(log)).toBe(false);
        expect(fetcher.status().state).toBe("failed");
        expect(fetcher.status().error).toMatch(/unreachable/);
        expect(fetcher.status().subagents).toBe(false);
    });
});

describe("subagents_installed", () => {
    const installed = (packages: unknown): boolean =>
        subagents_installed({ PI_CODING_AGENT_DIR: pi_dir(packages) });

    it("reads the packages list of the pi settings", () => {
        expect(installed(["npm:pi-subagents"])).toBe(true);
        expect(installed(["npm:pi-subagents@0.83.0"])).toBe(true);
        expect(installed([{ source: "npm:pi-subagents" }])).toBe(true);
        expect(installed(["npm:pi-subagents-extra"])).toBe(false);
        expect(installed(["npm:@acme/pi-subagents-x"])).toBe(false);
        expect(installed([])).toBe(false);
        expect(installed(undefined)).toBe(false);
    });
});

describe("egm_spawn", () => {
    const env = { PI_CODING_AGENT_DIR: pi_dir(["npm:pi-subagents"]) };

    it("is null for a review session, an unfetched home, or no pi-subagents", () => {
        const home = make_home();
        expect(egm_spawn(home, make_session(home), env)).toBeNull();
        write_checkout(egm_source_dir(home));
        write_marker(home, EGM_PIN.sha, EGM_ADAPTER_VERSION);
        expect(egm_spawn(home, make_session(home, "review"), env)).toBeNull();
        const bare = { PI_CODING_AGENT_DIR: pi_dir([]) };
        expect(egm_spawn(home, make_session(home), bare)).toBeNull();
    });

    it("creates the artifact and run directories otherwise", () => {
        const home = make_home();
        write_checkout(egm_source_dir(home));
        write_marker(home, EGM_PIN.sha, EGM_ADAPTER_VERSION);
        const summary = make_session(home);
        const spawn = egm_spawn(home, summary, env);
        expect(spawn).toEqual({
            root: egm_source_dir(home),
            skills_dir: join(egm_source_dir(home), "skills"),
            agents_dir: egm_adapter_dir(home),
            runs_dir: join(summary.path, "egm-runs"),
            artifacts_dir: join(summary.path, "design"),
        });
        expect(existsSync(join(summary.path, "design"))).toBe(true);
        expect(existsSync(join(summary.path, "egm-runs"))).toBe(true);
    });
});
