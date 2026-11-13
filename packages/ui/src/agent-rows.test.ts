import type { AgentSpec, RosterRow, SessionView } from "@spinner/protocol";
import { describe, expect, it } from "vitest";

import { initialDesignSessions, SEEDED_DIR } from "../fixture/data.ts";
import { agentRows, hostedState, shortModel, type RowGroup } from "./agent-rows.ts";
import { emptyTranscript, type Transcript } from "./transcript.ts";

const MODEL = "anthropic/claude-opus-5-5";

function spec(partial: Partial<AgentSpec> = {}): AgentSpec {
    return { harness: "tty", model: MODEL, process: "idle", ...partial };
}

function seeded(): SessionView {
    const view = initialDesignSessions().find((item) => item.summary.dir === SEEDED_DIR);
    if (view === undefined) {
        throw new Error("no seeded session in the fixture");
    }
    return view;
}

function withAgents(
    view: SessionView,
    agents: Record<string, AgentSpec>,
    running: string[],
): SessionView {
    const session = { ...view.summary.session, agents };
    return { ...view, summary: { ...view.summary, session }, agents_running: running };
}

function withoutFish(view: SessionView): SessionView {
    const design = view.design;
    return design === undefined ? view : { ...view, design: { ...design, goldfish: [] } };
}

/** `name state`, the rows then `| finished` rows, per group. */
function shape(groups: RowGroup[]): Record<string, string[]> {
    return Object.fromEntries(groups.map((group) => [group.id, [
        ...group.rows.map((row) => `${row.name} ${row.state}`),
        ...group.finished.map((row) => `| ${row.name} ${row.state}`),
    ]]));
}

describe("shortModel", () => {
    it("keeps the last path part without the claude- prefix", () => {
        expect(shortModel("anthropic/claude-opus-5-5")).toBe("opus-5-5");
        expect(shortModel("openrouter/openai/gpt-6-luna")).toBe("gpt-6-luna");
        expect(shortModel("default")).toBe("default");
    });
});

describe("hostedState", () => {
    it("reads working and idle while hosted, and the exit record once not", () => {
        expect(hostedState(spec({ process: "running" }), true)).toBe("working");
        expect(hostedState(spec(), true)).toBe("idle");
        expect(hostedState(spec({ process: "exited" }), false)).toBe("stopped");
        const at = "2026-11-04T10:00:00Z";
        const ended = (code: number | null, by?: "operator") =>
            spec({ process: "exited", ended: by === undefined ? { code, at } : { code, by, at } });
        expect(hostedState(ended(1, "operator"), false)).toBe("stopped");
        expect(hostedState(ended(0), false)).toBe("done");
        expect(hostedState(ended(1), false)).toBe("failed");
        expect(hostedState(ended(null), false)).toBe("failed");
    });
});

describe("agentRows", () => {
    it("groups the seeded session's agents and folds the finished ones", () => {
        expect(shape(agentRows(seeded(), {}, []))).toEqual({
            session: [
                "lead working", "engine working", "ui idle",
                "| docs stopped", "| api done", "| fixer failed",
            ],
            reviewers: ["| review-openai-gpt-6-luna done"],
            // The oldest run first, so a new run lands at the end.
            goldfish: [
                "critic working", "design working", "readiness queued",
                "| zoom_out done", "| comprehension stopped", "| security failed",
            ],
        });
    });

    it("keeps a row in place when its agent changes state", () => {
        const view = withAgents(seeded(), {
            ui: spec(), lead: spec({ process: "running" }), fixer: spec(), engine: spec(),
        }, ["ui", "lead", "fixer", "engine"]);
        const before = agentRows(view, {}, [])[0]?.rows.map((row) => row.name);
        expect(before).toEqual(["lead", "ui", "engine", "fixer"]);
        const settled = withAgents(view, {
            ui: spec({ process: "running" }), lead: spec(), fixer: spec(), engine: spec(),
        }, ["ui", "lead", "fixer", "engine"]);
        expect(agentRows(settled, {}, [])[0]?.rows.map((row) => row.name)).toEqual(before);
    });

    it("says what the agent does: the running tool, else the Roster, else —", () => {
        const view = seeded();
        const transcript: Transcript = {
            ...emptyTranscript,
            running: true,
            entries: [
                { kind: "tool", id: "t1", name: "read", args: { path: "a.ts" }, state: "ok" },
                { kind: "tool", id: "t2", name: "bash", args: { command: "pnpm test" },
                    state: "running" },
            ],
        };
        const roster: RosterRow[] = [
            { agent: "lead", owns: "", doing: "coordinating", blocked: "no", updated: "" },
            { agent: "engine", owns: "", doing: "#5 filters.ts", blocked: "no", updated: "" },
        ];
        const rows = agentRows(view, { engine: transcript }, roster)[0]?.rows ?? [];
        const doing = Object.fromEntries(rows.map((row) => [row.name, row.doing]));
        expect(doing).toEqual({ lead: "coordinating", engine: "bash pnpm test", ui: "—" });
        // After a reload the transcript is empty: the Roster line stands in.
        const reloaded = agentRows(view, {}, roster)[0]?.rows ?? [];
        expect(reloaded.find((row) => row.name === "engine")?.doing).toBe("#5 filters.ts");
    });

    it("offers the actions that apply to each state", () => {
        const groups = agentRows(seeded(), {}, []);
        const all = groups.flatMap((group) => [...group.rows, ...group.finished]);
        const actions = Object.fromEntries(all.map((row) => [row.name, row.actions]));
        expect(actions).toMatchObject({
            // lead under 40 %: no compact; engine at 52 % and ui at 81 %: compact.
            lead: ["interrupt", "stop"],
            engine: ["interrupt", "compact", "stop"],
            ui: ["compact", "stop"],
            docs: ["resume"],
            api: ["resume"],
            fixer: ["resume"],
            "review-openai-gpt-6-luna": [],
            zoom_out: [],
        });
    });

    it("shows the model, the context figure and the cost", () => {
        const lead = agentRows(seeded(), {}, [])[0]?.rows[0];
        expect(lead?.context).toEqual({
            label: "30 %", tone: "plain", title: "30 % of 1M context (300k tokens)",
        });
        expect(lead?.usd).toBeGreaterThan(0);
        const fish = agentRows(seeded(), {}, [])[2]?.rows.find((row) => row.name === "critic");
        expect(fish).toMatchObject({
            key: "fish:e5f6a7b8/0", roleLabel: "goldfish · review", model: "opus-5-5",
            context: null, usd: 0.45, doing: "—",
        });
    });

    it("lists a queued reviewer from the swarm before it is in session.yaml", () => {
        const base = withoutFish(withAgents(seeded(), { lead: spec() }, ["lead"]));
        const view: SessionView = {
            ...base,
            review: {
                checks: "green", failing: [], review_decision: "none", threads: 0,
                briefing: false, draft: null, posted_url: null, state: "reviewing",
                comment_count: 0, event: null,
                swarm: [
                    { name: "review-a", model: "x/a", state: "queued", usd: 0, pr: "web" },
                    { name: "review-b", model: "x/b", state: "failed", usd: 0.1, pr: "web" },
                ],
            },
        };
        expect(shape(agentRows(view, {}, []))).toEqual({
            session: ["lead idle"],
            reviewers: ["review-a queued", "| review-b failed"],
        });
    });

    it("leaves out an empty group", () => {
        expect(agentRows(withoutFish(withAgents(seeded(), {}, [])), {}, [])).toEqual([]);
    });
});
