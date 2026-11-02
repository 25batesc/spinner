// The actions the daemon runs as jobs and the CLI runs in process: one function per action,
// each taking a `log` for the lines the CLI prints and the job streams as `job.log`. Routes
// and commands call these and nothing else, so the two surfaces cannot drift.
import assert from "node:assert/strict";
import { userInfo } from "node:os";
import { join } from "node:path";
import type {
    AdoptRequest,
    ApproveRequest,
    ApproveView,
    FixRequest,
    LandRequest,
    NewSessionRequest,
    ResetRequest,
    PostRequest,
    PostView,
    PrRequest,
    SessionSummary,
    ThreadResponse,
    ThreadsView,
    UpRequest,
    VerifyRequest,
} from "@spinner/protocol";
import type { SpinnerHome } from "./home.js";
import { adopt_prs } from "./pipeline/adopt.js";
import type { GhRunner } from "./pipeline/github.js";
import {
    gh_write_runner,
    git_runner,
    type GithubWriter,
} from "./pipeline/github-write.js";
import { config_for_session } from "./pipeline/poller.js";
import { approve_prs, approve_view } from "./pipeline/approve.js";
import { land_prs } from "./pipeline/land.js";
import { macos_notifier, type Notifier } from "./pipeline/notify.js";
import { post_message, post_view } from "./pipeline/post.js";
import { reset_session } from "./pipeline/reset.js";
import { open_prs, type PrOutcome } from "./pipeline/pr.js";
import { slack_client_from_env, type SlackClient } from "./pipeline/slack.js";
import {
    flag_thread,
    read_threads,
    refresh_threads,
    reply_thread,
    resolve_thread,
    type ThreadsDeps,
    type ThreadsDiff,
} from "./pipeline/threads.js";
import { unverify_session, verify_session } from "./pipeline/verify.js";
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
import { diff_home } from "./diff/fetch.js";
import { stop_viewers } from "./diff/viewer.js";

/**
 * The fixer agent, as `src/agents/` (ext) exports it: `fix` renders the threads and hands
 * them over. Absent until ext wires it; `fix` then logs that no fixer is wired.
 */
export interface FixerDriver {
    start_or_steer(summary: SessionSummary, threads: ThreadsView, log: Log): Promise<void>;
}

export interface ActionContext {
    home: SpinnerHome;
    /** Directory `find_spec` searches for a `spinner.yaml` when none is named. */
    cwd: string;
    /** Read-only `gh`; it refuses writes. */
    gh: GhRunner;
    /** `gh` and `git` for GitHub writes, behind the allow-list. The real ones when absent. */
    writer?: GithubWriter;
    fixer?: FixerDriver;
    /** Where `SLACK_USER_TOKEN` is read from. `process.env` when absent. */
    env?: NodeJS.ProcessEnv;
    /** The notifier `land` uses on merge. The macOS banner when absent. */
    notify?: Notifier;
    /** `land`'s wait between looks at the queue, for tests. */
    land_poll_ms?: number;
}

/** The Slack client for a session: real with `SLACK_USER_TOKEN`, else the fixture. */
export function slack_of(ctx: ActionContext, summary: SessionSummary): SlackClient {
    const record_dir = join(summary.path, "artifacts");
    return slack_client_from_env(ctx.env ?? process.env, record_dir);
}

/** The context's writer, or the real `gh` and `git`. */
export function writer_of(ctx: ActionContext): GithubWriter {
    return ctx.writer ?? { gh: gh_write_runner, git: git_runner };
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
    const title = input.title;
    assert.ok(title !== undefined && title.trim().length > 0, "title must not be empty");
    if (input.project !== undefined) {
        load_spec(resolve_project(ctx, input.project));
    }
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
    // The diff viewers are host processes of the session, so `down` ends them with the stack.
    await stop_viewers(summary, diff_home(ctx.home), log);
    await stack_down(ctx.home, summary, log);
}

export async function close(
    ctx: ActionContext,
    summary: SessionSummary,
    log: Log,
): Promise<CloseResult> {
    await stop_viewers(summary, diff_home(ctx.home), log);
    const result = await stack_close(ctx.home, summary, log);
    log(`archived to ${result.archived_path}`);
    return result;
}

/** `spinner pr`: push every changed repo and open one PR per repo as the operator. */
export async function pr(
    ctx: ActionContext,
    summary: SessionSummary,
    input: PrRequest,
    log: Log,
): Promise<PrOutcome[]> {
    const config = config_for_session(summary, ctx.home, ctx.cwd, log);
    const result = await open_prs(ctx.home, summary, input, {
        gh: ctx.gh,
        writer: writer_of(ctx),
        config,
        log,
    });
    const needs = result.summary.session.needs_human ?? "-";
    log(`stage: ${result.summary.session.stage}; needs_human: ${needs}`);
    return result.outcomes;
}

/** `GET .../post`: the composed message and whether `post` may send it. No Slack call. */
export function post_preview(
    ctx: ActionContext,
    summary: SessionSummary,
    to: string | undefined,
): PostView {
    const config = config_for_session(summary, ctx.home, ctx.cwd, () => {});
    return post_view(summary, config, slack_of(ctx, summary), to);
}

/** `spinner post --yes` / `POST .../post {confirm: true}`: send the composed message. */
export async function post(
    ctx: ActionContext,
    summary: SessionSummary,
    input: PostRequest,
    log: Log,
): Promise<PostView> {
    const config = config_for_session(summary, ctx.home, ctx.cwd, log);
    const result = await post_message(ctx.home, summary, input, {
        config,
        slack: slack_of(ctx, summary),
        log,
    });
    const needs = result.summary.session.needs_human ?? "-";
    log(`stage: ${result.summary.session.stage}; needs_human: ${needs}`);
    return result.view;
}

/** `GET .../approve`: head, diff stat and open threads per PR; no write. */
export async function approve_preview(
    ctx: ActionContext,
    summary: SessionSummary,
): Promise<ApproveView> {
    const config = config_for_session(summary, ctx.home, ctx.cwd, () => {});
    return approve_view(summary, { gh: ctx.gh, config });
}

/** `spinner approve --yes` / `POST .../approve {confirm: true}`: submit the review. */
export async function approve(
    ctx: ActionContext,
    summary: SessionSummary,
    input: ApproveRequest,
    log: Log,
): Promise<string[]> {
    const config = config_for_session(summary, ctx.home, ctx.cwd, log);
    const result = await approve_prs(ctx.home, summary, input, {
        gh: ctx.gh,
        writer: writer_of(ctx),
        config,
        log,
    });
    const needs = result.summary.session.needs_human ?? "-";
    log(`stage: ${result.summary.session.stage}; needs_human: ${needs}`);
    return result.approved;
}

/** `spinner land`: enqueue with `expectedHeadOid`, watch, rebase and re-enqueue on pop-out. */
export async function land(
    ctx: ActionContext,
    summary: SessionSummary,
    input: LandRequest,
    log: Log,
): Promise<string[]> {
    const config = config_for_session(summary, ctx.home, ctx.cwd, log);
    const result = await land_prs(ctx.home, summary, input, {
        gh: ctx.gh,
        writer: writer_of(ctx),
        config,
        log,
        notify: ctx.notify ?? macos_notifier,
        ...(ctx.land_poll_ms === undefined ? {} : { poll_ms: ctx.land_poll_ms }),
    });
    const needs = result.summary.session.needs_human ?? "-";
    log(`stage: ${result.summary.session.stage}; needs_human: ${needs}`);
    return result.merged;
}

/** `spinner reset`: the next round on the same session. */
export async function reset(
    ctx: ActionContext,
    summary: SessionSummary,
    input: ResetRequest,
    log: Log,
): Promise<SessionSummary> {
    const config = config_for_session(summary, ctx.home, ctx.cwd, log);
    return reset_session(ctx.home, summary, input, {
        git: writer_of(ctx).git,
        config,
        log,
        stack: true,
    });
}

function threads_deps(ctx: ActionContext, summary: SessionSummary, log: Log): ThreadsDeps {
    const config = config_for_session(summary, ctx.home, ctx.cwd, log);
    return { gh: ctx.gh, writer: writer_of(ctx), config, log };
}

/** The threads from the last render; no GitHub call. */
export function threads(ctx: ActionContext, summary: SessionSummary): ThreadsView {
    assert.ok(ctx.home.root.length > 0);
    return read_threads(summary);
}

/** Re-renders `threads/` from GitHub for every open PR. */
export async function threads_refresh(
    ctx: ActionContext,
    summary: SessionSummary,
    log: Log,
): Promise<{ view: ThreadsView; diffs: ThreadsDiff[] }> {
    const result = await refresh_threads(ctx.home, summary, threads_deps(ctx, summary, log));
    return { view: result.view, diffs: result.diffs };
}

export function thread_reply(
    ctx: ActionContext,
    summary: SessionSummary,
    input: { thread: string; pr?: string; text: string },
    log: Log,
): Promise<ThreadResponse> {
    return reply_thread(ctx.home, summary, input, threads_deps(ctx, summary, log));
}

export function thread_resolve(
    ctx: ActionContext,
    summary: SessionSummary,
    input: { thread: string; pr?: string },
    log: Log,
): Promise<ThreadResponse> {
    return resolve_thread(ctx.home, summary, input, threads_deps(ctx, summary, log));
}

export function thread_flag(
    ctx: ActionContext,
    summary: SessionSummary,
    input: { thread: string; pr?: string; reason: string },
    log: Log,
): ThreadResponse {
    return flag_thread(ctx.home, summary, input, threads_deps(ctx, summary, log));
}

/**
 * `spinner fix`: render the threads from GitHub, then start or steer the fixer agent on them.
 * The fixer is ext's; until it is wired, the job stops after the render and says so.
 */
export async function fix(
    ctx: ActionContext,
    summary: SessionSummary,
    input: FixRequest,
    log: Log,
): Promise<{ view: ThreadsView; diffs: ThreadsDiff[] }> {
    const result = await threads_refresh(ctx, summary, log);
    const view =
        input.pr === undefined
            ? result.view
            : { ...result.view, prs: result.view.prs.filter((pr) => pr.repo === input.pr) };
    if (input.pr !== undefined && view.prs.length === 0) {
        throw new Error(`no PR for repo "${input.pr}" in ${summary.dir}`);
    }
    const open = view.prs.reduce((sum, pr) => sum + pr.open_bot + pr.open_human, 0);
    log(`${open} open thread(s) across ${view.prs.length} PR(s)`);
    if (ctx.fixer === undefined) {
        log("no fixer agent is wired into this daemon; threads/ is rendered, nothing started");
        return { view, diffs: result.diffs };
    }
    await ctx.fixer.start_or_steer(summary, view, log);
    return { view, diffs: result.diffs };
}

export function verify(
    ctx: ActionContext,
    summary: SessionSummary,
    input: VerifyRequest,
    log: Log,
): SessionSummary {
    // The "no spinner.yaml, defaults" note is a diagnostic; `adopt` already printed it once
    // for a session without a project, so the verify output stays the two lines it was.
    const config = config_for_session(summary, ctx.home, ctx.cwd, () => undefined);
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

/** `DELETE /sessions/:dir/verify`: the tick was a mistake; the stage asks for the test again. */
export function unverify(ctx: ActionContext, summary: SessionSummary): SessionSummary {
    const config = config_for_session(summary, ctx.home, ctx.cwd, () => undefined);
    return unverify_session(ctx.home, { dir: summary.dir, config });
}
