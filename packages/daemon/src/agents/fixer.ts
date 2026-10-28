// The fixer role (docs/SESSION_PROTOCOL.md, "Threads" and the fixer rules). `spinner fix`
// renders `threads/` and calls `start_or_steer`: the agent named `fixer` is added from
// `agents/fixer/BRIEF.md` (written from the built-in template when the session has none) in
// the worktree of the first PR with open threads, with role `fixer` so the extension
// registers the `thread_*` tools, and prompted with the open threads; when it already runs it
// is steered with them instead. `threads.autofix` picks the threads handed over: `all` hands
// over bot and human threads, `bots` and `off` hand over bot threads and name the human ones
// as the operator's. `off` is logged, because a `fix` by hand is the operator asking.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PipelineConfig, SessionSummary, ThreadsView, ThreadView } from "@spinner/protocol";
import type { FixerDriver } from "../actions.js";
import type { SpinnerHome } from "../home.js";
import { load_pipeline_config } from "../pipeline/config.js";
import { agent_brief_path } from "./harness.js";
import type { AgentManager } from "./manager.js";

export const FIXER_NAME = "fixer";

/** Upper bound on threads one prompt lists; the fixer lists the rest with `thread_list`. */
const THREADS_IN_PROMPT_MAX = 40;

export interface FixerDriverDeps {
    home: SpinnerHome;
    agents: AgentManager;
    cwd: string;
    /** The fixer's model; the session's listed model or pi's default when absent. */
    model?: string;
    config?: (summary: SessionSummary) => PipelineConfig;
}

export function fixer_driver(deps: FixerDriverDeps): FixerDriver {
    const config_of =
        deps.config ??
        ((summary: SessionSummary) =>
            load_pipeline_config(summary.session.project, deps.home, deps.cwd).config);
    return {
        async start_or_steer(summary, threads, log) {
            const config = config_of(summary);
            const plan = plan_fixer_work(threads, config);
            if (config.threads.autofix === "off") {
                log("threads.autofix is off; the fixer runs because fix was started by hand");
            }
            if (plan.handled.length === 0) {
                log("no thread for the fixer to handle; nothing started");
                return;
            }
            ensure_fixer_brief(summary, config);
            const text = fixer_prompt(summary, plan, config);
            const running = deps.agents.get(summary.dir, FIXER_NAME);
            if (running !== null) {
                await running.steer(text);
                log(`steered the running fixer with ${plan.handled.length} thread(s)`);
                return;
            }
            const repo = plan.handled[0]?.repo;
            assert.ok(repo !== undefined);
            const handle = await deps.agents.add(summary, {
                name: FIXER_NAME,
                repo,
                ...(deps.model === undefined ? {} : { model: deps.model }),
            });
            await handle.prompt(text);
            log(`started the fixer in worktree ${repo} on ${plan.handled.length} thread(s)`);
        },
    };
}

export interface FixerThread {
    repo: string;
    number: number;
    thread: ThreadView;
}

export interface FixerPlan {
    handled: FixerThread[];
    /** Human threads left to the operator under `autofix: bots` or `off`. */
    left: FixerThread[];
}

/** Pure: which open threads the fixer gets, by `threads.autofix`. Flagged threads are skipped. */
export function plan_fixer_work(threads: ThreadsView, config: PipelineConfig): FixerPlan {
    const plan: FixerPlan = { handled: [], left: [] };
    for (const pr of threads.prs) {
        for (const thread of pr.threads) {
            if (thread.state !== "open" || thread.flagged !== null) {
                continue;
            }
            const entry: FixerThread = { repo: pr.repo, number: pr.number, thread };
            if (thread.author_kind === "human" && config.threads.autofix !== "all") {
                plan.left.push(entry);
            } else {
                plan.handled.push(entry);
            }
        }
    }
    return plan;
}

/** The prompt or steer: the threads, one line each, and the rules in short. */
export function fixer_prompt(
    summary: SessionSummary,
    plan: FixerPlan,
    config: PipelineConfig,
): string {
    const id = summary.session.id;
    const lines = [
        `Review threads to address in session ${id}. Use \`thread_list\` for the full text.`,
        "",
    ];
    for (const entry of plan.handled.slice(0, THREADS_IN_PROMPT_MAX)) {
        lines.push(`- ${thread_line(entry)}`);
    }
    if (plan.handled.length > THREADS_IN_PROMPT_MAX) {
        const more = plan.handled.length - THREADS_IN_PROMPT_MAX;
        lines.push(`- and ${more} more; see \`thread_list\``);
    }
    if (plan.left.length > 0) {
        lines.push("", "Human threads the operator handles (do not reply, resolve or flag them):");
        for (const entry of plan.left) {
            lines.push(`- ${thread_line(entry)}`);
        }
    }
    lines.push(
        "",
        "For every thread above: fix it and `thread_reply` with one line on what changed, or",
        "`thread_reply` with the reason and `thread_flag` it. Do not skip a thread.",
        "`thread_resolve` only after the fix is pushed and the checks are green.",
        config.threads.resolve_human
            ? "Human threads: reply, fix and resolve like bot threads."
            : "Human threads: reply, then leave them open for the reviewer.",
        "One commit per batch: `fix(review): address N review comments`. One Log line per batch.",
    );
    return lines.join("\n");
}

function thread_line(entry: FixerThread): string {
    const thread = entry.thread;
    const where = thread.path === null ? "" : ` · ${thread.path}:${thread.line ?? "-"}`;
    const first = thread.body.split("\n")[0] ?? "";
    const body = first.length > 120 ? `${first.slice(0, 117)}...` : first;
    const who = `(${thread.author_kind}, ${thread.author})`;
    return `${entry.repo}#${entry.number} ${thread.label} ${who}${where}: ${body}`;
}

/** Writes `agents/fixer/BRIEF.md` from the template when the session has none. */
export function ensure_fixer_brief(summary: SessionSummary, config: PipelineConfig): string {
    const path = agent_brief_path(summary.path, FIXER_NAME);
    if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, render_fixer_brief(summary.session.id, config.threads.resolve_human));
    }
    return path;
}

/**
 * The fixer's brief. `examples/sessions/s005-drive-prs-home/agents/fixer/BRIEF.md` is the same
 * text for the example session; a session template copied with `spinner new --from` brings
 * its own.
 */
export function render_fixer_brief(session_id: string, resolve_human: boolean): string {
    const human = resolve_human
        ? "4. Human threads: reply, fix and resolve them like bot threads " +
          "(`threads.resolve_human` is on)."
        : "4. Human threads: reply, then leave them open for the reviewer " +
          "(`threads.resolve_human` is off).";
    return [
        "# fixer",
        "",
        `Role: review-thread fixer for session ${session_id}. ` +
            "You answer every open review thread on the session's PRs.",
        "",
        "## Owns",
        "- The files the threads point at, in the worktree you start in. Nothing else.",
        "",
        "## Do not edit",
        "- Files outside the threads' scope. Flag a thread that asks for them.",
        "",
        "## Every turn",
        "1. Read `.spinner/MISSION.md` in full.",
        "2. Run `thread_list` to see the open threads with their ids.",
        "3. For each open thread, do one of two things. Fix it and `thread_reply` with one " +
            "line that says what changed. Or `thread_reply` with a one-line reason and " +
            "`thread_flag` it.",
        human,
        "5. Flag a thread that asks a design question, disagrees with the approach, or " +
            "touches something outside the session. Do not argue with it.",
        "6. Commit one batch of fixes as `fix(review): address N review comments`, then push " +
            "the branch. Never force-push. Never rebase.",
        "7. `thread_resolve` a thread only after its fix is pushed and the checks are green.",
        "8. Append one Log line per batch with `mission_log`: " +
            "`resolved T1, T2 on backend#412; T3 flagged (design question)`.",
        "9. Do not skip a thread. Do not wait for a review bot to come back.",
        "",
        "## Finish",
        "1. Every open thread has a reply, and is resolved or flagged.",
        "2. Set your Roster row with `mission_roster`: Doing = `done`, Blocked? = `no`.",
        "",
    ].join("\n");
}
