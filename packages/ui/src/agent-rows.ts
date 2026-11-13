// The Agents view's rows (docs/designs/talk-change-ship.md, R9): one row per agent with its
// role, state, current action, model, context and cost; finished agents folded per group.
// The order is fixed by role and record, never by state, so a row does not jump when its
// agent settles; a finished row only moves into its group's fold. `AgentRows.tsx` draws it.
import {
    REVIEW_AGENT_PREFIX, role_of_agent, type AgentSpec, type GoldfishState,
    type GoldfishView, type RosterRow, type SessionView, type SwarmState,
} from "@spinner/protocol";

import {
    agentState, contextLabel, contextTitle, contextTone, type ContextTone,
} from "./agent-view.ts";
import { toolSummary } from "./chat.ts";
import { chipLabel } from "./goldfish.ts";
import type { Entry, Transcript } from "./transcript.ts";

export type RowState = "working" | "idle" | "stopped" | "done" | "failed" | "queued";
export type RowRole = "lead" | "worker" | "fixer" | "reviewer" | "goldfish";
/** A row's buttons; each one posts to an existing agent route. */
export type RowAction = "interrupt" | "compact" | "stop" | "resume";
export type RowGroupId = "session" | "reviewers" | "goldfish";

/** What a click on the row opens below the list: an agent's tabs or a Goldfish transcript. */
export type RowTarget =
    | { kind: "agent"; name: string }
    | { kind: "fish"; run: string; step: number };

export interface AgentRow {
    /** `agent:<name>` or `fish:<run>/<step>`: stable across updates. */
    key: string;
    target: RowTarget;
    name: string;
    role: RowRole;
    /** The role as the row prints it; a Goldfish adds its design step. */
    roleLabel: string;
    state: RowState;
    /** The running tool call, else the Roster's `doing`, else `—`. */
    doing: string;
    /** Where `doing` comes from, or why it is `—`. */
    doingTitle: string;
    model: string;
    modelTitle: string;
    context: { label: string; tone: ContextTone; title: string } | null;
    usd: number | null;
    actions: RowAction[];
}

export interface RowGroup {
    id: RowGroupId;
    label: string;
    /** The rows still at work, queued or idle. */
    rows: AgentRow[];
    /** The done, failed and stopped rows, behind the `n finished` fold line. */
    finished: AgentRow[];
}

const NONE = "—";
const FINISHED: readonly RowState[] = ["stopped", "done", "failed"];
const ROLE_RANK: Record<RowRole, number> = {
    lead: 0, worker: 1, fixer: 2, reviewer: 3, goldfish: 4,
};

type ToolEntry = Extract<Entry, { kind: "tool" }>;

/** A session agent's role by its name, as the extension gives it. */
function sessionRole(name: string): RowRole {
    const role = role_of_agent(name);
    return role === "lead" || role === "fixer" ? role : "worker";
}

/** `anthropic/claude-opus-5-5` → `opus-5-5`: the last path part without `claude-`. */
export function shortModel(model: string): string {
    const last = model.slice(model.lastIndexOf("/") + 1);
    return last.startsWith("claude-") ? last.slice("claude-".length) : last;
}

/**
 * A session agent's state. Hosted: working or idle, as the chip had it. Not hosted: how its
 * last process ended (`AgentSpec.ended`), stopped by the operator, done on code 0, failed on
 * another code or a signal; an agent without the record (an older daemon) reads stopped.
 */
export function hostedState(spec: AgentSpec, hosted: boolean): RowState {
    const state = agentState(spec, hosted);
    if (state !== "off") {
        return state;
    }
    const ended = spec.ended;
    if (ended === undefined || ended.by === "operator") {
        return "stopped";
    }
    return ended.code === 0 ? "done" : "failed";
}

function swarmState(swarm: SwarmState, spec: AgentSpec | undefined, hosted: boolean): RowState {
    if (swarm === "reading") {
        return spec === undefined ? "queued" : hostedState(spec, hosted);
    }
    return swarm;
}

function fishState(state: GoldfishState): RowState {
    return state === "running" ? "working" : state;
}

/** The running tool call of a working agent, else its Roster line, else `—` and why. */
function doingOf(
    state: RowState,
    transcript: Transcript | undefined,
    roster: RosterRow | undefined,
): { doing: string; doingTitle: string } {
    const tool = state === "working"
        ? transcript?.entries.findLast(
              (entry): entry is ToolEntry => entry.kind === "tool" && entry.state === "running",
          )
        : undefined;
    if (tool !== undefined) {
        const doing = `${tool.name} ${toolSummary(tool)}`.trim();
        return { doing, doingTitle: "The running tool call" };
    }
    const stated = roster?.doing.trim() ?? "";
    if (stated.length > 0) {
        return { doing: stated, doingTitle: "The agent's Roster line" };
    }
    return {
        doing: NONE,
        doingTitle: "No running tool call seen since the page loaded, and no Roster line",
    };
}

function hostedRow(
    view: SessionView,
    name: string,
    spec: AgentSpec,
    role: RowRole,
    state: RowState,
    transcripts: Readonly<Record<string, Transcript>>,
    roster: readonly RosterRow[],
): AgentRow {
    const hosted = view.agents_running.includes(name);
    const cost = view.cost?.agents[name];
    const model = cost?.model ?? spec.model;
    const context = cost?.context ?? null;
    const actions: RowAction[] = [];
    if (hosted && state === "working") {
        actions.push("interrupt");
    }
    // `compact` shows from the figure's first band (40 %), as it did beside the chip.
    if (hosted && contextTone(context) !== null) {
        actions.push("compact");
    }
    if (hosted) {
        actions.push("stop");
    }
    // A reviewer is started by the swarm, not resumed by hand.
    if (!hosted && role !== "reviewer") {
        actions.push("resume");
    }
    return {
        key: `agent:${name}`,
        target: { kind: "agent", name },
        name,
        role,
        roleLabel: role,
        state,
        ...doingOf(state, transcripts[name], roster.find((row) => row.agent === name)),
        model: shortModel(model),
        modelTitle: `${spec.harness} · ${model}`,
        context: context === null
            ? null
            : {
                  label: contextLabel(context),
                  tone: contextTone(context) ?? "plain",
                  title: contextTitle(context),
              },
        usd: cost?.usd ?? null,
        actions,
    };
}

/** The earliest step start of a run, in ms; a run not started yet sorts last. */
function runStart(steps: readonly GoldfishView[]): number {
    const starts = steps
        .map((step) => (step.started === null ? Number.NaN : Date.parse(step.started)))
        .filter((ms) => !Number.isNaN(ms));
    return starts.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...starts);
}

/**
 * The Goldfish oldest run first, each run's steps by index. The daemon lists the newest run
 * first; a new run here goes to the end, so the rows above it stay where they were.
 */
function fishOrder(goldfish: readonly GoldfishView[]): GoldfishView[] {
    const runs = new Map<string, GoldfishView[]>();
    for (const fish of goldfish) {
        runs.set(fish.run, [...(runs.get(fish.run) ?? []), fish]);
    }
    return [...runs.entries()]
        .sort(([runA, a], [runB, b]) => runStart(a) - runStart(b) || runA.localeCompare(runB))
        .flatMap(([, steps]) => [...steps].sort((a, b) => a.step - b.step));
}

function fishRow(fish: GoldfishView): AgentRow {
    return {
        key: `fish:${fish.run}/${fish.step}`,
        target: { kind: "fish", run: fish.run, step: fish.step },
        name: chipLabel(fish),
        role: "goldfish",
        roleLabel: fish.design_step === null ? "goldfish" : `goldfish · ${fish.design_step}`,
        state: fishState(fish.state),
        doing: NONE,
        doingTitle: "A Goldfish reports its last activity time only, not its action",
        model: fish.model === null ? NONE : shortModel(fish.model),
        modelTitle: fish.model ?? "model unknown",
        context: null,
        usd: fish.usd,
        actions: [],
    };
}

function group(id: RowGroupId, label: string, rows: AgentRow[]): RowGroup {
    return {
        id,
        label,
        rows: rows.filter((row) => !FINISHED.includes(row.state)),
        finished: rows.filter((row) => FINISHED.includes(row.state)),
    };
}

/**
 * The groups of the Agents view, empty ones left out: the session agents (the lead, the
 * workers, the fixer, each in `session.yaml` order), the reviewers (the swarm's order, then
 * any other `review-*` agent) and the Goldfish.
 */
export function agentRows(
    view: SessionView,
    transcripts: Readonly<Record<string, Transcript>>,
    roster: readonly RosterRow[],
): RowGroup[] {
    const agents = view.summary.session.agents;
    const hosted = (name: string) => view.agents_running.includes(name);
    const row = (name: string, spec: AgentSpec, role: RowRole, state: RowState) =>
        hostedRow(view, name, spec, role, state, transcripts, roster);
    const entries = Object.entries(agents);
    const session = entries
        .filter(([name]) => !name.startsWith(REVIEW_AGENT_PREFIX))
        .map(([name, spec]) => row(name, spec, sessionRole(name), hostedState(spec, hosted(name))))
        .sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role]);
    const swarm = view.review?.swarm ?? [];
    const reviewers = [
        // A queued reviewer may not be in `session.yaml` yet; its swarm record stands in.
        ...swarm.map((member) => {
            const spec = agents[member.name];
            const state = swarmState(member.state, spec, hosted(member.name));
            const shown = spec ?? { harness: "rpc", model: member.model, process: "exited" };
            return row(member.name, shown, "reviewer", state);
        }),
        ...entries
            .filter(([name]) => name.startsWith(REVIEW_AGENT_PREFIX) &&
                !swarm.some((member) => member.name === name))
            .map(([name, spec]) => row(name, spec, "reviewer", hostedState(spec, hosted(name)))),
    ];
    const fish = fishOrder(view.design?.goldfish ?? []).map(fishRow);
    return [
        group("session", "Session agents", session),
        group("reviewers", "Reviewers", reviewers),
        group("goldfish", "Goldfish", fish),
    ].filter((item) => item.rows.length + item.finished.length > 0);
}
