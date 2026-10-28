// The actions the daemon runs as jobs and the CLI runs in process: one function per action,
// each taking a `log` for the lines the CLI prints and the job streams as `job.log`. Routes
// and commands call these and nothing else, so the two surfaces cannot drift.
import assert from "node:assert/strict";
import { userInfo } from "node:os";
import type {
    AdoptRequest,
    NewSessionRequest,
    SessionSummary,
    UpRequest,
    VerifyRequest,
} from "@spinner/protocol";
import type { SpinnerHome } from "./home.js";
import { adopt_prs } from "./pipeline/adopt.js";
import type { GhRunner } from "./pipeline/github.js";
import { config_for } from "./pipeline/poller.js";
import { verify_session } from "./pipeline/verify.js";
import {
    attach_project,
    stack_close,
    stack_down,
    stack_up,
    type CloseResult,
    type Log,
    type UpResult,
} from "./stack/runner.js";
import { list_projects } from "./projects.js";
import { find_spec, load_spec } from "./stack/spec.js";
import { create_session } from "./store/session-store.js";

export interface ActionContext {
    home: SpinnerHome;
    /** Directory `find_spec` searches for a `spinner.yaml` when none is named. */
    cwd: string;
    gh: GhRunner;
}

/**
 * A project as a path, a directory name under `local/` or `<home>/projects/`, or the `name:`
 * of any spec `GET /projects` lists (so its names round-trip). Returns the spec path.
 */
export function resolve_project(ctx: ActionContext, project: string): string {
    try {
        return find_spec(project, ctx.home, ctx.cwd);
    } catch (error) {
        const match = list_projects(ctx.home, () => undefined).find((p) => p.name === project);
        if (match === undefined) {
            throw error;
        }
        return match.path;
    }
}

/**
 * The synchronous half of `new`: the session directory exists when this returns, so the job
 * that follows has a session to belong to. The spec is loaded first, so a bad `--project`
 * fails before anything is written.
 */
export function new_session(ctx: ActionContext, input: NewSessionRequest): SessionSummary {
    assert.ok(input.title.trim().length > 0, "title must not be empty");
    if (input.project !== undefined) {
        load_spec(resolve_project(ctx, input.project));
    }
    const title = input.title;
    const slug = input.slug;
    return create_session(ctx.home, slug === undefined ? { title } : { title, slug });
}

/** The job half of `new`: worktrees and the spec copy, when the session has a project. */
export async function attach_new_session(
    ctx: ActionContext,
    summary: SessionSummary,
    project: string | undefined,
    log: Log,
): Promise<SessionSummary> {
    log(`created ${summary.path}`);
    if (project === undefined) {
        return summary;
    }
    const loaded = load_spec(resolve_project(ctx, project));
    const attached = await attach_project(summary, loaded, log);
    log(`project ${loaded.spec.name} attached; next: spinner up ${summary.session.id}`);
    return attached;
}

export async function adopt(
    ctx: ActionContext,
    input: AdoptRequest,
    log: Log,
): Promise<SessionSummary> {
    const project = input.project === undefined ? undefined : resolve_project(ctx, input.project);
    const summary = await adopt_prs(ctx.home, {
        urls: input.urls,
        ...(project === undefined ? {} : { project }),
        ...(input.title === undefined ? {} : { title: input.title }),
        cwd: ctx.cwd,
        gh: ctx.gh,
        log,
    });
    log(`adopted ${summary.path}`);
    log(`stage: ${summary.session.stage}; needs_human: ${summary.session.needs_human ?? "-"}`);
    return summary;
}

export async function up(
    ctx: ActionContext,
    summary: SessionSummary,
    input: UpRequest,
    log: Log,
): Promise<UpResult> {
    const result = await stack_up(ctx.home, summary, { build: input.build === true }, log);
    for (const [service, host] of Object.entries(result.hosts)) {
        log(`${service.padEnd(12)} http://${host}`);
    }
    log(`up in ${(result.elapsed_ms / 1000).toFixed(1)} s`);
    return result;
}

export async function down(ctx: ActionContext, summary: SessionSummary, log: Log): Promise<void> {
    await stack_down(ctx.home, summary, log);
}

export async function close(
    ctx: ActionContext,
    summary: SessionSummary,
    log: Log,
): Promise<CloseResult> {
    const result = await stack_close(ctx.home, summary, log);
    log(`archived to ${result.archived_path}`);
    return result;
}

export function verify(
    ctx: ActionContext,
    summary: SessionSummary,
    input: VerifyRequest,
    log: Log,
): SessionSummary {
    // The "no spinner.yaml, defaults" note is a diagnostic; `adopt` already printed it once
    // for a session without a project, so the verify output stays the two lines it was.
    const config = config_for(summary.session, ctx.home, ctx.cwd, () => undefined);
    const by = input.by ?? userInfo().username;
    const verified = verify_session(ctx.home, { dir: summary.dir, by, config });
    const heads = Object.entries(verified.session.pipeline?.verified_heads ?? {})
        .map(([repo, head]) => `${repo}@${head.slice(0, 7)}`)
        .join(", ");
    log(`verified ${summary.dir}: ${heads}`);
    const needs = verified.session.needs_human ?? "-";
    log(`stage: ${verified.session.stage}; needs_human: ${needs}`);
    return verified;
}
