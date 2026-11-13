// The actions the daemon runs as jobs and the CLI runs in process: one function per action,
// each taking a `log` for the lines the CLI prints and the job streams as `job.log`. Routes
// and commands call these and nothing else, so the two surfaces cannot drift.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import type {
    AdoptRequest,
    ApproveRequest,
    ApproveView,
    DesignTrack,
    EgmStatus,
    ExtractRequest,
    ExtractResponse,
    FixRequest,
    LandRequest,
    NewSessionRequest,
    ChangeStartRequest,
    ResetRequest,
    PostRequest,
    PostView,
    PrRequest,
    SessionAdoptRequest,
    SessionSummary,
    SessionTitleRequest,
    StackSpec,
    ThreadResponse,
    ThreadsView,
    UpRequest,
    VerifyRequest,
} from "@spinner/protocol";
import type { SpinnerHome } from "./home.js";
import { adopt_into_session, adopt_prs } from "./pipeline/adopt.js";
import { pipeline_config_from_spec } from "./pipeline/config.js";
import {
    extract_prs,
    extract_refs,
    provisional_title,
    type ExtractRepo,
} from "./pipeline/extract.js";
import { origin_repo } from "./git/worktree.js";
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
import { start_change_job, switch_change_job } from "./pipeline/change-jobs.js";
import { current_change, has_change } from "./pipeline/changes.js";
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
    read_session_spec,
    stack_close,
    stack_down,
    stack_up,
    type CloseResult,
    type Log,
    type UpResult,
} from "./stack/runner.js";
import { list_projects } from "./projects.js";
import { find_spec, load_spec } from "./stack/spec.js";
import { create_session, read_session, write_session } from "./store/session-store.js";
import { SPEC_AUTHOR, type MissionWriter } from "./store/mission-writer.js";
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
 * fails before anything is written. With `text` (s014) the title is provisional: the first
 * line of the paste without its PR references; the lead agent sets the real one.
 */
export function new_session(ctx: ActionContext, input: NewSessionRequest): SessionSummary {
    const title = input.title ?? provisional_title(extract_refs(input.text ?? "", []).rest, null);
    assert.ok(title.trim().length > 0, "title must not be empty");
    if (input.project !== undefined) {
        load_spec(resolve_project(ctx, input.project));
    }
    if (input.adopt !== undefined && input.adopt.length > 0 && input.project === undefined) {
        throw new Error("`adopt` needs a `project`: a worktree needs a repo to come from");
    }
    const lead = input.text !== undefined;
    return create_session(ctx.home, {
        title,
        ...(input.slug === undefined ? {} : { slug: input.slug }),
        ...(lead ? { lead } : {}),
        ...(input.adopt === undefined || input.adopt.length === 0 ? {} : { adopted: input.adopt }),
    });
}

/**
 * `POST /sessions/extract`: the PR references in a paste, resolved against the project's
 * repos (the clone's `origin` owner, else `pipeline.github.org`), looked up on GitHub.
 */
export async function extract(ctx: ActionContext, input: ExtractRequest): Promise<ExtractResponse> {
    const repos =
        input.project === undefined
            ? []
            : await extract_repos(load_spec(resolve_project(ctx, input.project)).spec);
    return extract_prs(input.text, repos, { gh: ctx.gh });
}

/**
 * The project's repos as the extractor resolves against them: the GitHub name and owner from
 * each clone's `origin`, else the clone's directory name and `pipeline.github.org`.
 */
export async function extract_repos(spec: StackSpec): Promise<ExtractRepo[]> {
    const org = pipeline_config_from_spec(spec).github.org ?? null;
    const entries = Object.entries(spec.repos);
    const origins = await Promise.all(entries.map(([, repo]) => origin_repo(repo.path)));
    return entries.map(([key, repo], index) => ({
        key,
        owner: origins[index]?.owner ?? org,
        name: origins[index]?.name ?? basename(repo.path),
    }));
}

/**
 * `POST /sessions/:dir/adopt` (the lead's `adopt` tool): extracts the references, adopts the
 * adoptable ones into the session, and logs each refused one with its reason. A session
 * without a project cannot adopt. Returns the adopted URLs.
 */
export async function adopt_refs(
    ctx: ActionContext,
    summary: SessionSummary,
    input: SessionAdoptRequest,
    log: Log,
): Promise<string[]> {
    const loaded = read_session_spec(summary);
    const repos = await extract_repos(loaded.spec);
    const extracted = await extract_prs(input.refs.join(" "), repos, { gh: ctx.gh });
    const urls: string[] = [];
    for (const pr of extracted.prs) {
        if (pr.adoptable && pr.url !== null) {
            urls.push(pr.url);
            continue;
        }
        log(`refused ${pr.ref}: ${pr.reason ?? "not adoptable"}`);
    }
    if (urls.length === 0) {
        throw new Error("no adoptable pull request among the references; see the log");
    }
    const names = Object.fromEntries(repos.map((repo) => [repo.key, repo.name]));
    await adopt_into_session(ctx.home, summary, { urls, loaded, names, gh: ctx.gh, log });
    return urls;
}

/** The author of an operator's own write, as the routes default it. */
export const OPERATOR_AUTHOR = "operator";

/** An agent's title write while the operator's title is pinned: the route answers 409. */
export class TitlePinned extends Error {}

/**
 * `PUT /sessions/:dir/title` (dogfood #27). The operator's title renames and pins it
 * (`pinned` defaults to true); `pinned` alone pins or unpins. An agent may only send a
 * title, refused with `TitlePinned` while the title is pinned. Answers the session and the
 * old title when the title changed, else null, for the route's Log line.
 */
export function retitle(
    ctx: ActionContext,
    summary: SessionSummary,
    request: SessionTitleRequest,
    author: string,
): { summary: SessionSummary; was: string | null } {
    assert.ok(request.title !== undefined || request.pinned !== undefined, "an empty request");
    const operator = author === OPERATOR_AUTHOR;
    const fresh = read_session(ctx.home, summary.dir);
    assert.ok(fresh.ok, `${summary.dir} must exist to set its title`);
    const old = fresh.summary.session.title;
    if (!operator && request.pinned !== undefined) {
        throw new Error("only the operator pins or unpins a title");
    }
    if (!operator && fresh.summary.session.title_pinned === true) {
        throw new TitlePinned(
            `the operator pinned the title "${old}"; keep it, or ask the operator to unpin it`,
        );
    }
    let current = fresh.summary;
    if (request.title !== undefined && request.title !== old) {
        current = set_title(ctx, summary, request.title);
    }
    const pin = request.pinned ?? (operator && request.title !== undefined ? true : undefined);
    if (pin !== undefined) {
        if (pin) {
            current.session.title_pinned = true;
        } else {
            delete current.session.title_pinned;
        }
        write_session(current);
    }
    return { summary: current, was: current.session.title === old ? null : old };
}

/**
 * `PUT /sessions/:dir/title` and the provisional title's upgrade: `session.yaml` and the
 * `# id · title` line of MISSION.md. The caller serializes against the mission writer.
 */
export function set_title(
    ctx: ActionContext,
    summary: SessionSummary,
    title: string,
): SessionSummary {
    assert.ok(title.trim().length > 0, "title must not be empty");
    const fresh = read_session(ctx.home, summary.dir);
    assert.ok(fresh.ok, `${summary.dir} must exist to set its title`);
    fresh.summary.session.title = title.trim();
    write_session(fresh.summary);
    const file = join(summary.path, "MISSION.md");
    if (existsSync(file)) {
        const text = readFileSync(file, "utf8");
        const heading = `# ${fresh.summary.session.id} · ${title.trim()}`;
        const next = /^# .*$/m.test(text)
            ? text.replace(/^# .*$/m, heading)
            : `${heading}\n\n${text}`;
        writeFileSync(file, next);
    }
    return fresh.summary;
}

/** The Goal that `set_design_track` writes until the lead names its doc (2.20). */
export const DESIGN_GOAL_PENDING =
    "The design doc holds the goal. Spinner names it here once the lead calls design_doc.";
/** The one Done when item of a design-track session (2.20). */
export const DESIGN_DONE_WHEN = "The design is approved and every Plan item is ticked.";

/** The one line the lead gets when the operator changes the track (dogfood #44). */
export const TRACK_NOTICES: Record<DesignTrack, string> = {
    direct:
        "The operator switched this session to the direct track. Write the Goal, Done when " +
        "and Plan with mission_goal, mission_done_when and mission_plan, then build.",
    design:
        "The operator switched this session to the design track. Spinner now writes the Goal " +
        "and Done when; wait for the operator to start an EGM skill.",
};

/**
 * Writes `design.track`, creating the `design` block (docs/designs/egm-adoption.md, D1, 2.20).
 * A session whose build started keeps its track. `design` needs EGM ready and pi-subagents.
 * On `design` the Goal and Done when become the design pointers, as author `spinner`. A
 * change of an existing track writes the `spinner` Log line `track: <new> (was <old>)`; the
 * route tells the lead (`TRACK_NOTICES`).
 */
export async function set_design_track(
    ctx: ActionContext,
    writer: MissionWriter,
    summary: SessionSummary,
    track: DesignTrack,
    egm: EgmStatus,
): Promise<SessionSummary> {
    const fresh = read_session(ctx.home, summary.dir);
    assert.ok(fresh.ok, `${summary.dir} must exist to set its track`);
    const session = fresh.summary.session;
    const started = Object.values(session.repos ?? {}).some((repo) => repo.changed);
    if (session.design !== undefined && started) {
        throw new Error("the build has started; the track is fixed");
    }
    if (track === "design" && egm.state !== "ready") {
        const reason = egm.error === null ? egm.state : `${egm.state}: ${egm.error}`;
        throw new Error(`EGM is not available: ${reason}`);
    }
    if (track === "design" && !egm.subagents) {
        throw new Error("EGM is not available: pi-subagents is not installed");
    }
    const previous = session.design?.track;
    session.design = { ...(session.design ?? {}), track };
    write_session(fresh.summary);
    // A change of an existing track is a milestone (dogfood #44); the first track a new
    // session gets is not, and setting the same track again changes nothing.
    if (previous !== undefined && previous !== track) {
        await writer.write(summary.dir, {
            section: "log",
            mode: "append",
            text: `track: ${track} (was ${previous})`,
            author: SPEC_AUTHOR,
        });
    }
    if (track === "design") {
        const author = SPEC_AUTHOR;
        await writer.write(summary.dir, {
            section: "goal",
            mode: "replace",
            text: DESIGN_GOAL_PENDING,
            author,
        });
        await writer.write(summary.dir, {
            section: "done_when",
            mode: "replace",
            text: `- [ ] ${DESIGN_DONE_WHEN}`,
            author,
        });
    }
    const check = read_session(ctx.home, summary.dir);
    assert.ok(check.ok, `${summary.dir} must read back after the track write`);
    return check.summary;
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
    const on_change = await on_change_for_up(ctx, summary, input.change, log);
    const result = await stack_up(ctx.home, on_change, { build: input.build === true }, log);
    for (const [service, host] of Object.entries(result.hosts)) {
        log(`${service.padEnd(12)} http://${host}`);
    }
    log(`up in ${(result.elapsed_ms / 1000).toFixed(1)} s`);
    return result;
}

/**
 * `test locally` on a change (docs/designs/talk-change-ship.md, 3.1): when `change` is not
 * the current one, the worktrees switch to it, and a stack that was up stops, so `up` starts
 * every service on the change's code. Refused while an agent is in a turn: it writes to the
 * worktrees. The database is kept as it is.
 */
export async function on_change_for_up(
    ctx: ActionContext,
    summary: SessionSummary,
    change: string | undefined,
    log: Log,
): Promise<SessionSummary> {
    const session = summary.session;
    if (change === undefined || current_change(session).id === change) {
        return summary;
    }
    if (!has_change(session, change)) {
        throw new Error(`no change ${change} in ${summary.dir}`);
    }
    const working = Object.entries(session.agents ?? {})
        .filter(([, agent]) => agent.process === "running")
        .map(([name]) => name);
    if (working.length > 0) {
        throw new Error(
            `test locally refused: ${working.join(", ")} is working in the worktrees; ` +
                "wait for the turn to end, or stop the agent",
        );
    }
    const was_up = session.stack.state === "up";
    const switched = await change_switch(ctx, summary, change, log);
    if (!was_up) {
        return switched;
    }
    log("stopping the stack: its services restart on the change's code");
    await stack_down(ctx.home, switched, log);
    const fresh = read_session(ctx.home, summary.dir);
    assert.ok(fresh.ok, fresh.ok ? "" : fresh.error);
    return fresh.summary;
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

/** `change start`: a new branch in every worktree; the current change is put aside. */
export async function change_start(
    ctx: ActionContext,
    summary: SessionSummary,
    input: ChangeStartRequest,
    log: Log,
): Promise<SessionSummary> {
    const config = config_for_session(summary, ctx.home, ctx.cwd, log);
    return start_change_job(ctx.home, summary, input, { git: writer_of(ctx).git, config, log });
}

/** `change switch`: the branch of change `id` checked out in every worktree. */
export async function change_switch(
    ctx: ActionContext,
    summary: SessionSummary,
    id: string,
    log: Log,
): Promise<SessionSummary> {
    const config = config_for_session(summary, ctx.home, ctx.cwd, log);
    return switch_change_job(ctx.home, summary, id, { git: writer_of(ctx).git, config, log });
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
