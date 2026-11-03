// Goal: the outcome counters start at zeros, count one at a time on a fresh read of the
// session, and the steer rule counts only an operator's steer to the lead
// (docs/designs/egm-adoption.md, entries 6.20 and 6.22, review v2 M-5). Method: real session
// directories in a scratch home; `session.yaml` is read back after each count. The steer
// route runs on a daemon with the fake pi (`test/fixtures/fake-pi.ts`, rpc harness), and
// each request goes through `fetch` against the bound port.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { Session } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { start_daemon } from "../server.js";
import { create_session, read_session, write_session } from "../store/session-store.js";
import { count_outcome, counts_as_operator_steer, with_outcome } from "./outcomes.js";

let home: SpinnerHome;

beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "spinner-outcomes-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home") });
});

function yaml_of(dir: string): Session {
    return parse(readFileSync(join(home.sessions, dir, "session.yaml"), "utf8")) as Session;
}

describe("with_outcome", () => {
    it("starts at zeros when outcomes is absent and raises only the named counter", () => {
        const created = create_session(home, { title: "Pure" });
        expect(created.session.outcomes).toBeUndefined();
        const once = with_outcome(created.session, "fix_rounds");
        expect(once.outcomes).toEqual({ fix_rounds: 1, operator_steers: 0 });
        const twice = with_outcome(once, "operator_steers");
        expect(twice.outcomes).toEqual({ fix_rounds: 1, operator_steers: 1 });
        expect(once.outcomes).toEqual({ fix_rounds: 1, operator_steers: 0 });
    });

    it("refuses a corrupt counter", () => {
        const created = create_session(home, { title: "Corrupt" });
        const bad = { ...created.session, outcomes: { fix_rounds: -1, operator_steers: 0 } };
        expect(() => with_outcome(bad, "fix_rounds")).toThrow(/must not be negative/);
    });
});

describe("count_outcome", () => {
    it("writes the count and keeps a field another writer changed since the caller read", () => {
        const created = create_session(home, { title: "Fresh read" });
        // Another writer changes the title after the caller's read.
        write_session({ ...created, session: { ...created.session, title: "Renamed" } });
        const counted = count_outcome(home, created.dir, "operator_steers");
        expect(counted.session.title).toBe("Renamed");
        expect(yaml_of(created.dir).title).toBe("Renamed");
        expect(yaml_of(created.dir).outcomes).toEqual({ fix_rounds: 0, operator_steers: 1 });
        count_outcome(home, created.dir, "operator_steers");
        expect(yaml_of(created.dir).outcomes).toEqual({ fix_rounds: 0, operator_steers: 2 });
        const read = read_session(home, created.dir);
        expect(read.ok && read.summary.session.outcomes?.operator_steers).toBe(2);
    });

    it("throws for a session that does not exist", () => {
        expect(() => count_outcome(home, "s999-nope", "fix_rounds")).toThrow(/cannot count/);
    });
});

describe("counts_as_operator_steer", () => {
    it("counts a steer to the lead with source operator", () => {
        expect(counts_as_operator_steer("steer", "lead", { text: "t", source: "operator" })).toBe(
            true,
        );
    });

    it("does not count a prompt, a steer to a worker, or a steer without source", () => {
        const operator = { text: "t", source: "operator" as const };
        expect(counts_as_operator_steer("prompt", "lead", operator)).toBe(false);
        expect(counts_as_operator_steer("steer", "backend", operator)).toBe(false);
        expect(counts_as_operator_steer("steer", "lead", { text: "t" })).toBe(false);
    });
});

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures");

describe("the steer route counts operator steers to the lead (6.20, 6.22)", () => {
    it("counts only a steer to lead with source operator; source lead is 400", async () => {
        const pi = join(FIXTURES, "fake-pi.ts");
        chmodSync(pi, 0o755);
        const daemon = await start_daemon({
            home,
            port: 0,
            operator: false,
            log: () => undefined,
            poll_seconds: 0,
            gh: () => Promise.reject(new Error("no gh in tests")),
            notify: async () => undefined,
            ui_dir: null,
            observe_interval_ms: 60_000,
            pi,
            agents_harness: "rpc",
        });
        try {
            const base = `http://127.0.0.1:${daemon.port}`;
            const post = (path: string, body: unknown): Promise<Response> =>
                fetch(`${base}${path}`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(body),
                });
            const created = create_session(home, { title: "Steers" });
            for (const name of ["lead", "backend"]) {
                mkdirSync(join(created.path, "agents", name), { recursive: true });
                writeFileSync(join(created.path, "agents", name, "BRIEF.md"), `# ${name}\n`);
                const added = await post(`/sessions/${created.dir}/agents`, { name });
                expect(added.status, await added.clone().text()).toBe(201);
            }
            const at = (name: string, command: string): string =>
                `/sessions/${created.dir}/agents/${name}/${command}`;
            const operator = { text: "go", source: "operator" };

            const counted = await post(at("lead", "steer"), operator);
            expect(counted.status, await counted.clone().text()).toBe(200);
            expect(yaml_of(created.dir).outcomes).toEqual({ fix_rounds: 0, operator_steers: 1 });

            expect((await post(at("lead", "prompt"), operator)).status).toBe(200);
            expect((await post(at("backend", "steer"), operator)).status).toBe(200);
            // The lead's and the operator agent's `agent_steer` send no `source`.
            expect((await post(at("lead", "steer"), { text: "go" })).status).toBe(200);
            const refused = await post(at("lead", "steer"), { text: "go", source: "lead" });
            expect(refused.status).toBe(400);
            expect(((await refused.json()) as { error: string }).error).toBe(
                'source must be "operator" when given',
            );
            expect(yaml_of(created.dir).outcomes).toEqual({ fix_rounds: 0, operator_steers: 1 });

            expect((await post(at("lead", "steer"), operator)).status).toBe(200);
            expect(yaml_of(created.dir).outcomes).toEqual({ fix_rounds: 0, operator_steers: 2 });
        } finally {
            await daemon.close();
            rmSync(home.root, { recursive: true, force: true });
        }
    });
});
