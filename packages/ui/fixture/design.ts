// The design routes of the fixture daemon (docs/designs/egm-adoption.md, entry 3.24, Technical
// Plan T8 and T9). `PUT /sessions/:dir/design/gate` opens a gate as the lead's `ask_question`
// does; `POST …/design/answer` clears it and records the text; `POST …/design/run` records the
// skill, clears any gate and, for a review, starts the next review run. Each refuses as the
// daemon does: 400 for a bad body, 409 while the lead is not running. The fixture does not run
// a skill, so no stage moves. `POST …/design/approve` approves as the daemon's T10 steps 1, 2
// and 5 do, through the blocker confirmation, and moves the stage to `approved`; `DELETE`
// removes the approval (entry 6.18). `GET …/design/received` and `…/design/approve-received`
// are the fixture's own routes: the answers, runs and approve bodies it received, for the
// driver to read.
import type { ServerResponse } from "node:http";

import {
    DESIGN_ANSWER_MAX,
    DESIGN_GATE_OPTION_MAX,
    DESIGN_GATE_OPTIONS_MAX,
    DESIGN_GATE_QUESTION_MAX,
    DESIGN_RUN_ARGS_MAX,
    EGM_SKILLS,
    REVIEW_PRESETS,
    type DesignApproval,
    type DesignApproveRefusal,
    type DesignApproveRequest,
    type DesignRunRequest,
    type DesignStage,
    type DesignView,
    type EgmSkill,
    type ReviewPreset,
    type SessionView,
} from "@spinner/protocol";

import { LISTED_BLOCKERS, gateNeeds } from "./data.ts";

/** The part of the fixture daemon these routes use. */
export interface DesignHost {
    sessions: Map<string, SessionView>;
    update(next: SessionView): void;
}

/** What the fixture received per session, for `GET …/design/received`. */
export interface DesignReceived {
    answers: string[];
    runs: DesignRunRequest[];
}

export const DESIGN_ROUTE =
    /^\/sessions\/([^/]+)\/design\/(gate|answer|run|received|approve|approve-received)$/;

/** The stage lines of `needs_human` that stay once the lead works again (T7, lines 6 and 7). */
const STAGE_NEEDS: Partial<Record<DesignStage, string>> = {
    drafted: "review the design",
    "design-ready": "approve the design",
};

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
}

/** The first fault of a gate body, as the daemon's `set_gate` throws it; null when valid. */
export function gateFault(body: Record<string, unknown>): string | null {
    const { question, options } = body;
    if (typeof question !== "string" || question.trim() === "") {
        return "question must be a non-empty string";
    }
    if (question.length > DESIGN_GATE_QUESTION_MAX) {
        return `question is over ${DESIGN_GATE_QUESTION_MAX} characters`;
    }
    if (!Array.isArray(options) || options.some((option) => typeof option !== "string")) {
        return "options must be an array of strings";
    }
    if (options.length < 2 || options.length > DESIGN_GATE_OPTIONS_MAX) {
        return `options must have 2 to ${DESIGN_GATE_OPTIONS_MAX} entries`;
    }
    if ((options as string[]).some((option) => option.length > DESIGN_GATE_OPTION_MAX)) {
        return `an option is over ${DESIGN_GATE_OPTION_MAX} characters`;
    }
    return null;
}

/** The first fault of a run body, as the daemon's route checks it; null when valid. */
export function runFault(body: Record<string, unknown>): string | null {
    const { skill, args, preset } = body;
    if (typeof skill !== "string" || !(EGM_SKILLS as readonly string[]).includes(skill)) {
        return `unknown skill ${String(skill)}`;
    }
    if (preset !== undefined) {
        if (skill !== "egm-review") {
            return "a preset goes only with egm-review";
        }
        if (!(REVIEW_PRESETS as readonly unknown[]).includes(preset)) {
            return `unknown preset ${String(preset)}`;
        }
    }
    if (args !== undefined && (typeof args !== "string" || args.length > DESIGN_RUN_ARGS_MAX)) {
        return `args must be a string of at most ${DESIGN_RUN_ARGS_MAX} characters`;
    }
    return null;
}

/** The hash the fixture records for an approval; the daemon hashes the normalized doc. */
export const APPROVED_SHA = "c0ffee5a1e0f".padEnd(64, "0");

/** The first fault of an approve body, as the daemon's route checks it; null when valid. */
export function approveFault(body: Record<string, unknown>): string | null {
    const { build, blockers_confirmed: confirmed } = body;
    if (typeof build !== "boolean") {
        return "build must be a boolean";
    }
    if (confirmed !== undefined && !(Number.isInteger(confirmed) && (confirmed as number) >= 0)) {
        return "blockers_confirmed must be a whole number";
    }
    return null;
}

export class DesignFixture {
    received = new Map<string, DesignReceived>();
    /** The approve bodies per session, for `GET …/design/approve-received`. */
    approves = new Map<string, DesignApproveRequest[]>();

    readonly host: DesignHost;

    constructor(host: DesignHost) {
        this.host = host;
    }

    /**
     * Handles a design route; false when `path` is not one, so the caller goes on. The body
     * is read by then, so every matched path answers here, a 404 included.
     */
    handle(
        method: string, path: string, body: Record<string, unknown>, response: ServerResponse,
    ): boolean {
        const match = DESIGN_ROUTE.exec(path);
        const dir = match?.[1] ?? "";
        const verb = match?.[2];
        if (match === null) {
            return false;
        }
        const current = this.host.sessions.get(dir);
        if (current?.design === undefined) {
            sendJson(response, { error: `no design session ${dir}` }, 404);
            return true;
        }
        if (method === "GET" && verb === "received") {
            sendJson(response, this.of(dir));
        } else if (method === "PUT" && verb === "gate") {
            this.gate(response, current, body);
        } else if (method === "POST" && verb === "answer") {
            this.answer(response, current, body);
        } else if (method === "POST" && verb === "run") {
            this.run(response, current, body);
        } else if (method === "POST" && verb === "approve") {
            this.approve(response, current, body);
        } else if (method === "DELETE" && verb === "approve") {
            this.unapprove(response, current);
        } else if (method === "GET" && verb === "approve-received") {
            sendJson(response, { approves: this.approves.get(dir) ?? [] });
        } else {
            sendJson(response, { error: `no route ${method} ${path}` }, 404);
        }
        return true;
    }

    of(dir: string): DesignReceived {
        const known = this.received.get(dir);
        if (known !== undefined) {
            return known;
        }
        const made: DesignReceived = { answers: [], runs: [] };
        this.received.set(dir, made);
        return made;
    }

    gate(response: ServerResponse, current: SessionView, body: Record<string, unknown>): void {
        const fault = gateFault(body);
        if (fault !== null) {
            sendJson(response, { error: fault }, 400);
            return;
        }
        const question = body["question"] as string;
        const gate = { question, options: body["options"] as string[], asked: now() };
        this.write(current, { gate }, gateNeeds(question));
        sendJson(response, { ok: true });
    }

    answer(response: ServerResponse, current: SessionView, body: Record<string, unknown>): void {
        const text = body["text"];
        if (typeof text !== "string" || text.trim() === "" || text.length > DESIGN_ANSWER_MAX) {
            sendJson(response, { error: `text must be 1 to ${DESIGN_ANSWER_MAX} characters` }, 400);
            return;
        }
        if (!current.agents_running.includes("lead")) {
            sendJson(response, { error: "the lead is not running; resume it from its tab" }, 409);
            return;
        }
        this.of(current.summary.dir).answers.push(text);
        this.write(current, { gate: null }, this.stageNeeds(current));
        sendJson(response, { ok: true, disposition: "started" });
    }

    run(response: ServerResponse, current: SessionView, body: Record<string, unknown>): void {
        const fault = runFault(body);
        if (fault !== null) {
            sendJson(response, { error: fault }, 400);
            return;
        }
        if (!current.agents_running.includes("lead")) {
            sendJson(response, { error: "the lead is not running; resume it from its tab" }, 409);
            return;
        }
        const design = current.design as DesignView;
        const skill = body["skill"] as EgmSkill;
        const preset = body["preset"] as ReviewPreset | undefined;
        if (skill === "egm-review" && preset !== undefined && design.doc === null) {
            sendJson(response, { error: "no design doc yet" }, 409);
            return;
        }
        const repos = Object.values(current.summary.session.repos);
        if (skill === "egm-drift-report" && repos.some((repo) => repo.changed)) {
            sendJson(response, { error: "the worktree has this round's unlanded commits" }, 409);
            return;
        }
        const request: DesignRunRequest = { skill };
        if (typeof body["args"] === "string") {
            request.args = body["args"];
        }
        if (preset !== undefined) {
            request.preset = preset;
        }
        this.of(current.summary.dir).runs.push(request);
        const reviews = skill === "egm-review" || skill === "egm-review-loop";
        const next = reviews ? nextRun(design.review_run?.id ?? null) : null;
        const change: Partial<DesignView> = { gate: null };
        if (next !== null) {
            change.review_run = { id: next, preset: preset ?? null, started: now() };
        }
        this.write(current, change, this.stageNeeds(current));
        sendJson(response, { ok: true, disposition: "started" });
    }

    /**
     * T10 steps 1, 2 and 5: 409 without a doc, while resolving, with an open gate, while
     * `blockers_confirmed` does not confirm the listed blockers, and with `build` while the
     * lead is not running; else the approval stands and the stage is `approved`. The fixture
     * runs no lead, so `build` is only recorded. The texts are the daemon's (`approve.ts`).
     */
    approve(response: ServerResponse, current: SessionView, body: Record<string, unknown>): void {
        const fault = approveFault(body);
        if (fault !== null) {
            sendJson(response, { error: fault }, 400);
            return;
        }
        const dir = current.summary.dir;
        const design = current.design as DesignView;
        const request = body as unknown as DesignApproveRequest;
        this.approves.set(dir, [...(this.approves.get(dir) ?? []), request]);
        const listed = LISTED_BLOCKERS[dir] ?? 0;
        const refuse = (error: string, blockers: number | null) => {
            const refusal: DesignApproveRefusal = { error, blockers };
            sendJson(response, refusal, 409);
        };
        if (design.doc === null) {
            refuse("no design doc yet", null);
        } else if (design.stage === "resolving") {
            refuse("the review findings are not resolved yet", null);
        } else if (design.gate !== null) {
            refuse("the lead asked a question; answer it first", null);
        } else if (listed > 0 && request.blockers_confirmed !== listed) {
            refuse(`The newest review report lists ${listed} blockers.`, listed);
        } else if (request.build && !current.agents_running.includes("lead")) {
            refuse("the lead is not running; resume it from its tab, or approve without the build",
                null);
        } else {
            const approval: DesignApproval = {
                path: design.doc, repo: design.repo ?? "web", sha256: APPROVED_SHA, at: now(),
                blockers: listed, round: current.round ?? 1,
            };
            const change: Partial<DesignView> = {
                stage: "approved", approved: approval, approvals: [...design.approvals, approval],
                changed_after_approval: false,
            };
            this.write(current, change, null);
            sendJson(response, { session: this.host.sessions.get(dir) });
        }
    }

    /** `DELETE …/design/approve`: the approval goes, `approvals` keeps it; else a no-op. */
    unapprove(response: ServerResponse, current: SessionView): void {
        const design = current.design as DesignView;
        if (design.approved === null) {
            sendJson(response, { session: current });
            return;
        }
        const change: Partial<DesignView> = {
            stage: "design-ready", approved: null, changed_after_approval: false,
        };
        this.write(current, change, STAGE_NEEDS["design-ready"] ?? null);
        sendJson(response, { session: this.host.sessions.get(current.summary.dir) });
    }

    /** The `needs_human` once no gate is open: the stage's own line, else none. */
    stageNeeds(current: SessionView): string | null {
        const stage = current.design?.stage ?? null;
        return stage === null ? null : STAGE_NEEDS[stage] ?? null;
    }

    write(current: SessionView, change: Partial<DesignView>, needs: string | null): void {
        const design = { ...(current.design as DesignView), ...change };
        const session = { ...current.summary.session, needs_human: needs };
        this.host.update({ ...current, design, summary: { ...current.summary, session } });
    }
}

/** `r1` after none, `r3` after `r2`: the next review run id (entry 3.8). */
function nextRun(id: string | null): string {
    const number = id === null ? 0 : Number(id.slice(1));
    return `r${number + 1}`;
}

function now(): string {
    return new Date().toISOString();
}
