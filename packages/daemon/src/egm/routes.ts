// The EGM routes (docs/designs/egm-adoption.md, 1.12, 2.24, 3.9): the fetch state and a
// refetch job, the design track, the lead's design doc, the lead's gate, the operator's
// answer and the skill runs. Build sessions 3 to 6 widen `EgmRouteDeps`; each entry that
// does names the new fields. Mounted by one line in `server.ts`.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import type {
    AgentCommandResponse,
    DesignTrack,
    EgmResponse,
    EgmSkill,
    ErrorResponse,
    JobResponse,
    OkResponse,
    ReviewPreset,
    SessionResponse,
    SessionSummary,
} from "@spinner/protocol";
import {
    BRIEF_FILE,
    DESIGN_ANSWER_MAX,
    DESIGN_RUN_ARGS_MAX,
    DESIGN_TRACKS,
    EGM_ARTIFACT_DIR,
    EGM_SKILLS,
    LEAD_NAME,
    REVIEW_PRESETS,
} from "@spinner/protocol";
import { set_design_track, type ActionContext } from "../actions.js";
import type { AgentManager } from "../agents/manager.js";
import type { SpinnerHome } from "../home.js";
import { rounds_of } from "../pipeline/rounds.js";
import type { JobRunner, JobWork } from "../jobs/jobs.js";
import type { MissionWriter } from "../store/mission-writer.js";
import { read_session, write_session } from "../store/session-store.js";
import type { ViewBuilder } from "../watcher.js";
import { DesignDocConflict, DesignDocRefused, type DesignTracker } from "./design.js";
import { type EgmFetcher, marker_path } from "./fetch.js";
import { clear_gate, set_gate } from "./gate.js";
import { archive_review_run } from "./review-runs.js";

/** The 409 of `answer` and `run` while the lead has no process. */
export const LEAD_NOT_RUNNING = "the lead is not running; resume it from its tab";
/** The 409 of `egm-drift-report` while a repo has commits in the current round (T14, 3.18). */
export const DRIFT_REFUSED =
    "the worktree has this round's unlanded commits; run the drift report before the " +
    "round's first commit or after it lands";

export interface EgmRouteDeps {
    fetcher: EgmFetcher;
    jobs: JobRunner;
    design: DesignTracker;
    ctx: ActionContext;
    view: ViewBuilder;
    /** The daemon's one mission writer, for `set_design_track`. */
    writer: MissionWriter;
    /** The lead that `answer` and `run` prompt (3.9). */
    agents: AgentManager;
    home: SpinnerHome;
}

export function mount_egm_routes(app: Hono, deps: EgmRouteDeps): void {
    app.get("/egm", (c) => {
        const body: EgmResponse = { egm: deps.fetcher.status() };
        return c.json(body);
    });

    app.post("/egm/fetch", (c) => {
        const work: JobWork = async (log) => {
            // A refetch: without the marker `ensure` clones the pin again.
            rmSync(marker_path(deps.fetcher.home), { force: true });
            const ok = await deps.fetcher.ensure(log);
            if (!ok) {
                throw new Error(deps.fetcher.status().error ?? "the EGM fetch failed");
            }
        };
        try {
            const job = deps.jobs.start("egm", null, work);
            const body: JobResponse = { job };
            return c.json(body, 202);
        } catch (error) {
            return c.json(error_body(describe_error(error)), 409);
        }
    });

    app.put("/sessions/:dir/design/track", async (c) => {
        const dir = c.req.param("dir");
        const track = field(await json_body(c), "track");
        if (track === null || !(DESIGN_TRACKS as readonly string[]).includes(track)) {
            return c.json(error_body(`track must be one of ${DESIGN_TRACKS.join(", ")}`), 400);
        }
        const read = read_session(deps.ctx.home, dir);
        if (!read.ok) {
            return c.json(error_body(read.error), 404);
        }
        const egm = deps.fetcher.status();
        const next = track as DesignTrack;
        try {
            await set_design_track(deps.ctx, deps.writer, read.summary, next, egm);
        } catch (error) {
            return c.json(error_body(describe_error(error)), 409);
        }
        await deps.design.refresh(dir);
        return session_response(c, deps, dir);
    });

    app.put("/sessions/:dir/design/doc", async (c) => {
        const dir = c.req.param("dir");
        const path = field(await json_body(c), "path");
        if (path === null || path.trim().length === 0) {
            return c.json(error_body("path must be a non-empty string"), 400);
        }
        const read = read_session(deps.ctx.home, dir);
        if (!read.ok) {
            return c.json(error_body(read.error), 404);
        }
        if (read.summary.session.design?.track !== "design") {
            return c.json(error_body("this session is not on the design track"), 409);
        }
        try {
            await deps.design.set_doc(dir, path.trim());
        } catch (error) {
            if (error instanceof DesignDocRefused) {
                return c.json(error_body(error.message), 400);
            }
            if (error instanceof DesignDocConflict) {
                return c.json(error_body(error.message), 409);
            }
            throw error;
        }
        return session_response(c, deps, dir);
    });

    mount_gate_routes(app, deps);
}

/** `PUT …/design/gate`, `POST …/design/answer` and `POST …/design/run` (3.9). */
function mount_gate_routes(app: Hono, deps: EgmRouteDeps): void {
    app.put("/sessions/:dir/design/gate", async (c) => {
        const dir = c.req.param("dir");
        const body = await json_body(c);
        const question = field(body, "question");
        const options = string_list(body, "options");
        if (question === null || options === null) {
            return c.json(error_body("the body must be { question, options: string[] }"), 400);
        }
        if (!read_session(deps.home, dir).ok) {
            return c.json(error_body(`no session ${dir}`), 404);
        }
        try {
            set_gate(deps.home, dir, { question, options }, new Date());
        } catch (error) {
            return c.json(error_body(describe_error(error)), 400);
        }
        await deps.design.refresh(dir);
        const answer: OkResponse = { ok: true };
        return c.json(answer);
    });

    app.post("/sessions/:dir/design/answer", async (c) => {
        const dir = c.req.param("dir");
        const text = field(await json_body(c), "text");
        if (text === null || text.trim().length === 0) {
            return c.json(error_body("text must be a non-empty string"), 400);
        }
        if (text.length > DESIGN_ANSWER_MAX) {
            return c.json(error_body(`text must be at most ${DESIGN_ANSWER_MAX} characters`), 400);
        }
        const lead = deps.agents.get(dir, LEAD_NAME);
        if (lead === null) {
            return c.json(error_body(LEAD_NOT_RUNNING), 409);
        }
        clear_gate(deps.home, dir);
        const disposition = await lead.prompt(text);
        await deps.design.refresh(dir);
        const answer: AgentCommandResponse = { ok: true, disposition };
        return c.json(answer);
    });

    app.post("/sessions/:dir/design/run", async (c) => {
        const dir = c.req.param("dir");
        const request = parse_run(await json_body(c));
        if (typeof request === "string") {
            return c.json(error_body(request), 400);
        }
        const read = read_session(deps.home, dir);
        if (!read.ok) {
            return c.json(error_body(read.error), 404);
        }
        const lead = deps.agents.get(dir, LEAD_NAME);
        if (lead === null) {
            return c.json(error_body(LEAD_NOT_RUNNING), 409);
        }
        const composed = compose_run(deps.design, read.summary, request);
        if (composed.status !== 200) {
            return c.json(error_body(composed.error), composed.status);
        }
        if (request.skill === "egm-review" || request.skill === "egm-review-loop") {
            try {
                start_review_run(deps.home, read.summary, request.preset ?? null);
            } catch (error) {
                return c.json(error_body(describe_error(error)), 409);
            }
        }
        clear_gate(deps.home, dir);
        const args = composed.args;
        const disposition = await lead.prompt(
            args.length === 0 ? `/skill:${request.skill}` : `/skill:${request.skill} ${args}`,
        );
        await deps.design.refresh(dir);
        const answer: AgentCommandResponse = { ok: true, disposition };
        return c.json(answer);
    });
}

interface RunRequest {
    skill: EgmSkill;
    args: string | null;
    preset: ReviewPreset | null;
}

/** The body of `POST …/design/run`, or the 400 text. */
function parse_run(body: unknown): RunRequest | string {
    const skill = field(body, "skill");
    if (skill === null || !(EGM_SKILLS as readonly string[]).includes(skill)) {
        return `skill must be one of ${EGM_SKILLS.join(", ")}`;
    }
    const preset = field(body, "preset");
    const has_preset = typeof body === "object" && body !== null && "preset" in body;
    if (has_preset) {
        if (skill !== "egm-review") {
            return "preset goes only with egm-review";
        }
        if (preset === null || !(REVIEW_PRESETS as readonly string[]).includes(preset)) {
            return `preset must be one of ${REVIEW_PRESETS.join(", ")}`;
        }
    }
    const args = field(body, "args");
    const has_args = typeof body === "object" && body !== null && "args" in body;
    if (has_args && args === null) {
        return "args must be a string";
    }
    if (args !== null && args.length > DESIGN_RUN_ARGS_MAX) {
        return `args must be at most ${DESIGN_RUN_ARGS_MAX} characters`;
    }
    const trimmed = args === null || args.trim().length === 0 ? null : args.trim();
    return { skill: skill as EgmSkill, args: trimmed, preset: preset as ReviewPreset | null };
}

type Composed = { status: 200; args: string } | { status: 400 | 409; error: string };

/**
 * The arguments of the skill, per the table of Technical Plan T9. The operator's `args`
 * replace the prefilled default of a confirmed field (target file, designs directory, path)
 * and follow the composed text of `egm-draft`.
 */
export function compose_run(
    design: DesignTracker,
    summary: SessionSummary,
    request: RunRequest,
): Composed {
    const state = summary.session.design;
    const location = design.designs_of(summary);
    const doc =
        location === null || state?.doc === undefined ? null : join(location.worktree, state.doc);
    const composed = compose_text(summary, request, location, doc);
    if (composed.status !== 200) {
        return composed;
    }
    if (composed.args.length > DESIGN_RUN_ARGS_MAX) {
        return {
            status: 400,
            error: `the composed arguments pass ${DESIGN_RUN_ARGS_MAX} characters`,
        };
    }
    return composed;
}

function compose_text(
    summary: SessionSummary,
    request: RunRequest,
    location: ReturnType<DesignTracker["designs_of"]>,
    doc: string | null,
): Composed {
    const given = request.args;
    const no_worktree: Composed = {
        status: 409,
        error: "this session has no worktree of the designs repo",
    };
    switch (request.skill) {
        case "egm-brainstorm":
            return { status: 200, args: given ?? "" };
        case "egm-draft": {
            if (location === null) {
                return no_worktree;
            }
            const brief = join(summary.path, EGM_ARTIFACT_DIR, BRIEF_FILE);
            const text = `Context File: ${brief}. Target directory: ${location.dir}.`;
            return { status: 200, args: given === null ? text : `${text} ${given}` };
        }
        case "egm-review": {
            if (request.preset !== null) {
                if (doc === null) {
                    return { status: 409, error: "no design doc yet" };
                }
                const text = `${doc} Step: ${request.preset} GoldfishContext: none`;
                return { status: 200, args: text };
            }
            const target = given ?? doc;
            if (target === null) {
                return { status: 409, error: "no design doc yet" };
            }
            return { status: 200, args: target };
        }
        case "egm-review-loop":
        case "egm-resolve": {
            const target = given ?? doc;
            if (target === null) {
                return { status: 409, error: "no design doc yet" };
            }
            return { status: 200, args: target };
        }
        case "egm-drift-report": {
            const repos = Object.values(summary.session.repos ?? {});
            if (repos.some((repo) => repo.changed)) {
                return { status: 409, error: DRIFT_REFUSED };
            }
            const dir = given ?? location?.dir ?? null;
            if (dir === null) {
                return no_worktree;
            }
            const landed = landed_rounds(summary);
            return {
                status: 200,
                args: landed.length === 0 ? dir : `${dir} Landed rounds: ${landed.join(", ")}.`,
            };
        }
        case "egm-bootstrap": {
            const path = given ?? location?.worktree ?? null;
            if (path === null) {
                return no_worktree;
            }
            return { status: 200, args: `path: ${path}` };
        }
    }
}

/** `r1 web#41` per merged PR of the earlier rounds, oldest first. */
function landed_rounds(summary: SessionSummary): string[] {
    const mission_file = join(summary.path, "MISSION.md");
    const mission = existsSync(mission_file) ? readFileSync(mission_file, "utf8") : null;
    const landed: string[] = [];
    for (const round of rounds_of(summary.session, mission)) {
        for (const pr of round.prs) {
            if (pr.state === "merged") {
                landed.push(`r${round.round} ${pr.repo}#${pr.number}`);
            }
        }
    }
    return landed;
}

/** Archives the earlier run's reports and records the new run (3.8, 3.9). */
function start_review_run(
    home: SpinnerHome,
    summary: SessionSummary,
    preset: ReviewPreset | null,
): void {
    const current = summary.session.design?.review_run ?? null;
    const { next } = archive_review_run(summary.path, current);
    const fresh = read_session(home, summary.dir);
    if (!fresh.ok) {
        throw new Error(fresh.error);
    }
    const design = fresh.summary.session.design;
    if (design === undefined) {
        throw new Error("no design block");
    }
    design.review_run = { id: next, preset, started: new Date().toISOString() };
    write_session(fresh.summary);
}

function session_response(c: Context, deps: EgmRouteDeps, dir: string): Response {
    const read = read_session(deps.ctx.home, dir);
    if (!read.ok) {
        return c.json(error_body(read.error), 404);
    }
    const body: SessionResponse = { session: deps.view(read.summary) };
    return c.json(body);
}

/** A string field of a JSON object body, or null. */
function field(body: unknown, key: string): string | null {
    if (typeof body !== "object" || body === null) {
        return null;
    }
    const value = (body as Record<string, unknown>)[key];
    return typeof value === "string" ? value : null;
}

/** A string-array field of a JSON object body, or null. */
function string_list(body: unknown, key: string): string[] | null {
    if (typeof body !== "object" || body === null) {
        return null;
    }
    const value = (body as Record<string, unknown>)[key];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        return null;
    }
    return value as string[];
}

/** The parsed JSON body, `undefined` for an empty body, or `null` for unparsable text. */
async function json_body(c: Context): Promise<unknown> {
    const text = await c.req.text();
    if (text.trim().length === 0) {
        return undefined;
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return null;
    }
}

function error_body(error: string): ErrorResponse {
    return { error };
}

function describe_error(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
