// Polls GitHub for every change with an open PR, writes the new facts and the derived stage
// to `session.yaml`, and notifies on transitions. One `gh` call per open PR per round, every
// `github.poll_seconds` (60 by default). A round that changes nothing writes nothing and
// notifies nobody. A session's changes are polled one by one, each focused
// (docs/designs/talk-change-ship.md, 2.2 and 2.6), so the facts of a change that is not
// checked out are as fresh as the current one's.
import assert from "node:assert/strict";
import type {
    PipelineConfig,
    PrFacts,
    PrThreadsView,
    Session,
    SessionSummary,
} from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";
import {
    focus_summary,
    list_sessions,
    read_session,
    write_session,
} from "../store/session-store.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SESSION_SPEC } from "../stack/runner.js";
import { load_spec } from "../stack/spec.js";
import { load_pipeline_config, pipeline_config_from_spec } from "./config.js";
import {
    fetch_owner_login,
    fetch_pr_response,
    parse_pr_url,
    pr_facts_from_response,
    type GhRunner,
} from "./github.js";
import type { Notifier } from "./notify.js";
import { poll_slack_activity } from "./post.js";
import type { SlackClient } from "./slack.js";
import {
    read_pr_threads,
    threads_from_response,
    with_flagged,
    write_pr_threads,
} from "./threads.js";
import { apply_pr_facts, refresh_session, session_prs, type Transition } from "./tracker.js";
import { autopilot_step, baseline_autopilot } from "./autopilot.js";
import { current_change, has_change, open_change_ids } from "./changes.js";

export interface PollOptions {
    gh: GhRunner;
    notify: Notifier;
    /** Directory `find_spec` searches for a `spinner.yaml` when a session names no project. */
    cwd: string;
    now?: () => Date;
    log?: (line: string) => void;
    /** Reads replies under a session's Slack post. No Slack poll when absent. */
    slack?: (summary: SessionSummary) => SlackClient;
    /**
     * The autopilot (docs/designs/talk-change-ship.md, 1.5). `enabled` is read each round
     * (`settings.agents.github: full`); `tell` sends the text to the session's lead and
     * answers false when it could not (no lead, pi did not start), so the facts are told at
     * the next round. No autopilot when absent.
     */
    autopilot?: {
        enabled: () => boolean;
        tell: (dir: string, text: string) => Promise<boolean>;
    };
}

export interface PollReport {
    /** Sessions that had at least one open PR to poll. */
    polled: string[];
    transitions: { dir: string; transition: Transition }[];
    errors: { dir: string; error: string }[];
}

/** Upper bound on PR fetches per round, so a runaway home cannot hammer the API. */
const FETCHES_PER_ROUND_MAX = 200;

/** One round over every session. Never throws: a failing session is reported and skipped. */
export async function poll_once(home: SpinnerHome, options: PollOptions): Promise<PollReport> {
    const now = options.now ?? (() => new Date());
    const log = options.log ?? (() => {});
    const report: PollReport = { polled: [], transitions: [], errors: [] };
    const listed = list_sessions(home);
    for (const failure of listed.errors) {
        report.errors.push(failure);
    }
    let owner_login: string | null = null;
    let fetches = 0;
    for (const entry of listed.sessions) {
        const ids = open_change_ids(entry.session);
        if (ids.length === 0) {
            continue;
        }
        try {
            const config = config_for_session(entry, home, options.cwd, log);
            owner_login ??= config.github.owner_login ?? (await fetch_owner_login(options.gh));
            for (const id of ids) {
                // Read again per change: the poll of the change before wrote the file, and
                // the lead may have started or switched a change since the list.
                const read = read_session(home, entry.dir);
                if (!read.ok || !has_change(read.summary.session, id)) {
                    continue;
                }
                const checked_out = current_change(read.summary.session).id === id;
                const focused = focus_summary(read.summary, id);
                const open = session_prs(focused.session).filter((pr) => is_open(pr.state));
                fetches += open.length;
                assert.ok(fetches <= FETCHES_PER_ROUND_MAX, `over ${FETCHES_PER_ROUND_MAX} PRs`);
                const facts = { config, owner_login, checked_out };
                const result = await poll_session(focused, open, facts, options, now());
                if (result !== null) {
                    report.transitions.push({ dir: entry.dir, transition: result });
                }
            }
            report.polled.push(entry.dir);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            report.errors.push({ dir: entry.dir, error: message });
            log(`poll ${entry.dir}: ${message}`);
        }
    }
    return report;
}

/**
 * The session's pipeline configuration: the spec copy under `stack/spinner.yaml` when the
 * session has one (so `write_repos` and the rest hold wherever the daemon runs), else the
 * project's spec by name, else the defaults.
 */
export function config_for_session(
    summary: SessionSummary,
    home: SpinnerHome,
    cwd: string,
    log: (line: string) => void,
): PipelineConfig {
    const copy = join(summary.path, SESSION_SPEC);
    if (existsSync(copy)) {
        return pipeline_config_from_spec(load_spec(copy).spec);
    }
    return config_for(summary.session, home, cwd, log);
}

/** The project's pipeline configuration, or the defaults when no spec can be found. */
export function config_for(
    session: Session,
    home: SpinnerHome,
    cwd: string,
    log: (line: string) => void,
): PipelineConfig {
    const loaded = load_pipeline_config(session.project, home, cwd);
    // A review session (s015) has no project by design; the defaults are not news.
    if (loaded.path === null && session.kind !== "review") {
        log(`${session.id}: no spinner.yaml for project "${session.project ?? ""}"; defaults`);
    }
    return loaded.config;
}

interface PollFacts {
    config: PipelineConfig;
    owner_login: string;
    /** True when the polled change is the one checked out in the worktrees. */
    checked_out: boolean;
}

/** Polls the open PRs of one change. `entry` is focused on it; the write stores that change. */
async function poll_session(
    entry: SessionSummary,
    open: PrFacts[],
    poll: PollFacts,
    options: PollOptions,
    now: Date,
): Promise<Transition | null> {
    const { config, owner_login } = poll;
    let session = entry.session;
    const views: PrThreadsView[] = [];
    for (const pr of open) {
        const ref = parse_pr_url(pr.url);
        assert.ok(ref !== null, `${entry.dir}: repo ${pr.repo} has a PR without a GitHub URL`);
        const response = await fetch_pr_response(options.gh, ref);
        const context = { config: config.github, owner_login };
        const facts = pr_facts_from_response(response, context);
        // The same response renders `threads/`, so the fixer's file is as fresh as the board
        // and no second call is made. Flags survive the render.
        const previous = read_pr_threads(entry, pr.repo, pr.number);
        const view = threads_from_response(pr.repo, response, context, previous);
        write_pr_threads(entry, view, previous);
        views.push(view);
        session = apply_pr_facts(session, pr.repo, with_flagged(facts, view.flagged));
    }
    const refreshed = refresh_session(entry.session, session, config, now);
    await run_autopilot(entry, refreshed.session, views, poll.checked_out, options);
    const changed = JSON.stringify(refreshed.session) !== JSON.stringify(entry.session);
    if (changed) {
        write_session({ ...entry, session: refreshed.session });
    }
    if (options.slack !== undefined && session.pipeline?.slack_post) {
        const current = { ...entry, session: refreshed.session };
        await poll_slack_activity(current, options.slack(current), config, now);
    }
    if (refreshed.transition !== null) {
        const message = transition_message(refreshed.session, refreshed.transition);
        await options.notify("Spinner", message, entry.dir);
    }
    return refreshed.transition;
}

/**
 * Tells the lead what is new on the session's pull requests and records it in `session`
 * (mutated: the caller writes it). A session seen without a state gets the baseline and no
 * message. A message that cannot be delivered leaves the state as it was.
 */
async function run_autopilot(
    entry: SessionSummary,
    session: Session,
    views: readonly PrThreadsView[],
    checked_out: boolean,
    options: PollOptions,
): Promise<void> {
    const autopilot = options.autopilot;
    if (autopilot === undefined || !autopilot.enabled() || session.kind === "review") {
        return;
    }
    const pipeline = session.pipeline ?? { verified_locally: false, slack_post: null };
    session.pipeline = pipeline;
    if (pipeline.autopilot === undefined) {
        pipeline.autopilot = baseline_autopilot(session, views);
        return;
    }
    const step = autopilot_step(session, views, pipeline.autopilot);
    for (const line of step.stopped) {
        (options.log ?? (() => {}))(`autopilot ${entry.dir}: stopped: ${line}`);
        await options.notify("Spinner", `${session.id} autopilot stopped: ${line}`, entry.dir);
    }
    const message = step.message;
    const text = message === null ? null : with_change_note(session, checked_out, message);
    if (text === null || (await autopilot.tell(entry.dir, text))) {
        pipeline.autopilot = step.state;
    }
}

/**
 * The autopilot's message with the change it is about. For a change that is not checked
 * out, the lead is told how to get to it: its worktrees are on another branch.
 */
export function with_change_note(session: Session, checked_out: boolean, message: string): string {
    const change = current_change(session);
    if (checked_out) {
        return message;
    }
    return (
        `${message}\n\nThese pull requests belong to change ${change.id} "${change.title}" ` +
        `(branch ${session.branch}), which is not checked out. Commit your work in progress, ` +
        `run \`change switch ${change.id}\`, handle the above, wait until the fix is pushed, ` +
        "then switch back to the change you were on."
    );
}

/** `session` is focused on the change of the transition; a second change adds its title. */
export function transition_message(session: Session, transition: Transition): string {
    const several = (session.changes ?? []).length > 0;
    const change = several ? ` · ${current_change(session).title}` : "";
    const head = `${session.id} ${session.slug}${change}: ${transition.from} → ${transition.to}`;
    const parts = [head, ...transition.queue_changes];
    if (session.needs_human !== null) {
        parts.push(`needs you: ${session.needs_human}`);
    }
    return parts.join(" · ");
}

export interface Poller {
    stop(): void;
    /** One round now, after the running one when there is one; for the `review` job. */
    round(): Promise<PollReport>;
}

/**
 * Runs `poll_once` now and then every `interval_ms` until stopped. Rounds never overlap: a
 * slow round delays the next one instead of stacking. This loop is intentionally unbounded;
 * `stop()` is the only exit.
 */
export function start_poller(
    home: SpinnerHome,
    options: PollOptions,
    interval_ms: number,
    on_round: (report: PollReport) => void,
): Poller {
    assert.ok(interval_ms >= 1000, "poll interval must be at least one second");
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;
    // Rounds chain on one promise, so a round asked for from outside (`round()`) waits for
    // the loop's own and the loop's next waits for it.
    let chain: Promise<unknown> = Promise.resolve();
    const run = (): Promise<PollReport> => {
        const next = chain.then(() => poll_once(home, options));
        chain = next.catch(() => undefined);
        return next;
    };
    const round = async (): Promise<void> => {
        const report = await run();
        if (stopped) {
            return;
        }
        on_round(report);
        timer = setTimeout(() => void round(), interval_ms);
    };
    void round();
    return {
        round: run,
        stop: () => {
            stopped = true;
            if (timer !== null) {
                clearTimeout(timer);
            }
        },
    };
}

function is_open(state: PrFacts["state"]): boolean {
    return state === "open" || state === "draft";
}
