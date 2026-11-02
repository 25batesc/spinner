// The review swarm (MISSION.md s015 Plan item 3, s016 Plan item 2): one tty agent per model
// in `settings.review.models` on each target PR, each with the reviewer brief
// (`store/review-brief.ts`, the operator's `reviewer` role) in the PR repo's worktree and
// the role's skills through `--skill`. The swarm is bounded by the running-agents cap: a
// reviewer that cannot start waits in a queue per session as `queued`, and the next one
// starts on `agent.exited`. A reviewer is `reading` from its start; `done` when the last
// assistant text of its settled turn carries a `VERDICT:` line: the daemon saves that text
// as `artifacts/reviews/<model-slug>.md` and stops the pi, so the slot frees and the
// transcript stays for the tab; `failed` when it exits without one. Reviewers never post.
// When the last reviewer of a session lands, the lead gets the verdicts notice through the
// extension channel (or with its next prompt when it is not running). The states live in
// `session.yaml` under `review.swarm`, so the view and a restarted daemon read them.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
    PiEvent,
    ReviewRequest,
    SessionSummary,
    Settings,
    SwarmRecord,
    SwarmState,
} from "@spinner/protocol";
import {
    LEAD_NAME,
    REVIEW_AGENT_PREFIX,
    REVIEW_VERDICTS_DIR,
    REVIEW_VERDICT_PREFIX,
    model_slug,
} from "@spinner/protocol";
import type { EventBus } from "../event-bus.js";
import type { SpinnerHome } from "../home.js";
import { parse_pr_url } from "../pipeline/github.js";
import { review_settings, review_targets, type ReviewTarget } from "../pipeline/review.js";
import {
    default_review_skill,
    render_review_brief,
    review_kickoff,
    reviewer_skill_dirs,
    verdicts_notice,
} from "../store/review-brief.js";
import { list_sessions, read_session, write_session } from "../store/session-store.js";
import { agent_brief_path } from "./harness.js";
import { agent_history } from "./history.js";
import type { AgentManager } from "./manager.js";

/** Upper bound on reviewers waiting in one session's queue. */
const QUEUE_PER_SESSION_MAX = 100;

export interface SwarmDeps {
    home: SpinnerHome;
    agents: AgentManager;
    bus: EventBus;
    settings: () => Settings;
    log?: (line: string) => void;
    /** After a swarm step: the view on the bus, so the chips move. */
    refresh?: (dir: string) => Promise<void>;
    /** The default skill directory; `default_review_skill()` when absent. Tests pass one. */
    skill_default?: string;
}

export interface SwarmStartResult {
    started: string[];
    queued: string[];
}

interface Queued {
    dir: string;
    name: string;
    model: string;
    target: ReviewTarget;
}

/** What one `review` would start: the reviewers by name, model and PR, and the skill. */
export interface SwarmPlan {
    reviewers: Queued[];
    skill: string | null;
}

export class ReviewSwarm {
    private readonly queues = new Map<string, Queued[]>();
    /** The last assistant text per `dir/name`, from `turn_end`, for the verdict check. */
    private readonly last_text = new Map<string, string>();
    private readonly log: (line: string) => void;
    private readonly unsubscribe: () => void;

    constructor(private readonly deps: SwarmDeps) {
        this.log = deps.log ?? (() => undefined);
        this.unsubscribe = deps.bus.subscribe((event) => {
            if (event.type === "agent.event") {
                this.on_agent_event(event.session, event.agent, event.event);
            } else if (event.type === "agent.settled") {
                void this.on_settled(event.session, event.agent);
            } else if (event.type === "agent.exited") {
                void this.on_exited(event.session, event.agent);
            }
        });
    }

    close(): void {
        this.unsubscribe();
    }

    /**
     * On daemon start: reviewers the previous daemon left `queued` go back in the queue;
     * ones left `reading` without a process are `failed` (their pi died with the daemon
     * unless `adopt_all` resumed them, which runs before this).
     */
    async prime(): Promise<void> {
        for (const summary of list_sessions(this.deps.home).sessions) {
            const swarm = summary.session.review?.swarm ?? {};
            for (const [name, record] of Object.entries(swarm)) {
                const target = target_of(summary, record.pr);
                if (record.state === "queued" && target !== null) {
                    this.enqueue({ dir: summary.dir, name, model: record.model, target });
                } else if (record.state === "reading") {
                    if (this.deps.agents.get(summary.dir, name) === null) {
                        this.record(summary.dir, name, "failed");
                    }
                }
            }
            await this.start_queued(summary.dir);
        }
    }

    /** `settings.review.skill`, else the default when it exists, else none. */
    skill_dir(): string | null {
        const named = this.deps.settings().review?.skill;
        if (named !== undefined) {
            return named;
        }
        const fallback = this.deps.skill_default ?? default_review_skill();
        return existsSync(fallback) ? fallback : null;
    }

    /** The models one `review` runs, from the settings. */
    models(): readonly string[] {
        const { models, n } = review_settings(this.deps.settings());
        return models.slice(0, n);
    }

    /**
     * What `start` would do, without doing it: the targets and the models. Throws, for the
     * route's 409, when the session has no open PR, when a PR's repo has no worktree, or
     * when a reviewer of that PR still reads.
     */
    check(summary: SessionSummary, request: ReviewRequest): Promise<SwarmPlan> {
        const targets = review_targets(summary, request);
        const chosen = this.models();
        assert.ok(chosen.length > 0, "at least one review model");
        const plan: SwarmPlan = { reviewers: [], skill: this.skill_dir() };
        for (const target of targets) {
            const worktree = summary.session.repos[target.key]?.worktree;
            if (worktree === undefined) {
                const what = `${summary.dir} has no worktree for ${target.key}`;
                throw new Error(`${what}; nothing to read`);
            }
            for (const model of chosen) {
                const name = reviewer_name(model, target.key, targets.length > 1);
                const state = summary.session.review?.swarm[name]?.state;
                if (state === "reading" && this.deps.agents.get(summary.dir, name) !== null) {
                    throw new Error(`${name} still reads ${target.key}#${target.number}`);
                }
                plan.reviewers.push({ dir: summary.dir, name, model, target });
            }
        }
        return Promise.resolve(plan);
    }

    /**
     * The swarm on the session's open PRs, or the one `pr` names: one reviewer per model
     * and PR, started up to the cap and queued past it.
     */
    async start(
        summary: SessionSummary,
        request: ReviewRequest,
        log: (line: string) => void,
    ): Promise<SwarmStartResult> {
        const plan = await this.check(summary, request);
        const result: SwarmStartResult = { started: [], queued: [] };
        for (const reviewer of plan.reviewers) {
            this.ensure_brief(summary, reviewer.name, reviewer.model, reviewer.target, plan.skill);
            this.record(summary.dir, reviewer.name, "queued", {
                model: reviewer.model,
                pr: reviewer.target.key,
            });
            this.enqueue(reviewer);
        }
        result.started = await this.start_queued(summary.dir);
        const skills = reviewer_skill_dirs(plan.skill);
        for (const name of result.started) {
            const how = skills.length === 0 ? "without a skill" : `with ${skills.join(", ")}`;
            log(`${name} started ${how}`);
        }
        for (const entry of this.queues.get(summary.dir) ?? []) {
            result.queued.push(entry.name);
            log(`${entry.name} (${entry.model}) queued behind the cap`);
        }
        return result;
    }

    private enqueue(entry: Queued): void {
        const queue = this.queues.get(entry.dir) ?? [];
        assert.ok(queue.length < QUEUE_PER_SESSION_MAX, "too many reviewers queued");
        if (!queue.some((queued) => queued.name === entry.name)) {
            queue.push(entry);
        }
        this.queues.set(entry.dir, queue);
    }

    /** Starts queued reviewers of `dir`, in order, while the cap allows. Returns the names. */
    private async start_queued(dir: string): Promise<string[]> {
        const started: string[] = [];
        const queue = this.queues.get(dir) ?? [];
        while (queue.length > 0 && !this.deps.agents.at_cap) {
            const next = queue.shift();
            assert.ok(next !== undefined);
            if (await this.start_one(next)) {
                started.push(next.name);
            }
        }
        if (queue.length === 0) {
            this.queues.delete(dir);
        }
        return started;
    }

    /** One reviewer: `add` in the PR repo's worktree with the role's skills, then the kickoff. */
    private async start_one(entry: Queued): Promise<boolean> {
        const read = read_session(this.deps.home, entry.dir);
        if (!read.ok) {
            return false;
        }
        const skill = this.skill_dir();
        const skills = reviewer_skill_dirs(skill);
        try {
            const handle = await this.deps.agents.add(
                read.summary,
                { name: entry.name, model: entry.model, repo: entry.target.key },
                skills.length === 0 ? {} : { skills },
            );
            this.last_text.delete(key_of(entry.dir, entry.name));
            this.record(entry.dir, entry.name, "reading");
            await this.refresh(entry.dir);
            const pr = parse_pr_url(entry.target.url);
            assert.ok(pr !== null, `${entry.target.url} is not a GitHub PR URL`);
            const head = read.summary.session.repos[entry.target.key]?.pr?.head ?? "";
            await handle.prompt(
                review_kickoff({ model: entry.model, pr, url: entry.target.url, skill }, head),
            );
            return true;
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.log(`reviewer ${entry.name} in ${entry.dir} did not start: ${reason}`);
            this.record(entry.dir, entry.name, "failed");
            await this.refresh(entry.dir);
            await this.notify_lead_when_landed(entry.dir);
            return false;
        }
    }

    private on_agent_event(dir: string, agent: string, event: PiEvent): void {
        if (!agent.startsWith(REVIEW_AGENT_PREFIX) || event.type !== "turn_end") {
            return;
        }
        const message = (event as { message?: { role?: string; content?: unknown } }).message;
        if (message?.role !== "assistant") {
            return;
        }
        const text = text_of(message.content);
        if (text.length > 0) {
            this.last_text.set(key_of(dir, agent), text);
        }
    }

    /** A `VERDICT:` line in the last assistant text: the verdict file, `done`, the pi stops. */
    private async on_settled(dir: string, agent: string): Promise<void> {
        const record = this.swarm_record(dir, agent);
        if (record === null || record.state !== "reading") {
            return;
        }
        const read = read_session(this.deps.home, dir);
        const text =
            this.last_text.get(key_of(dir, agent)) ??
            (read.ok ? last_assistant_text(read.summary.path, agent) : "");
        if (!has_verdict_line(text) || !read.ok) {
            return;
        }
        const file = write_verdict(read.summary.path, record.model, text);
        this.record(dir, agent, "done");
        this.log(`reviewer ${agent} in ${dir} done: ${file}`);
        await this.refresh(dir);
        try {
            await this.deps.agents.stop(dir, agent);
        } catch {
            // Already gone: the exit handler runs either way.
        }
        await this.notify_lead_when_landed(dir);
    }

    /** An exit without a verdict is `failed`; either way the next queued reviewer starts. */
    private async on_exited(dir: string, agent: string): Promise<void> {
        const record = this.swarm_record(dir, agent);
        if (record !== null && record.state === "reading") {
            this.record(dir, agent, "failed");
            this.log(`reviewer ${agent} in ${dir} exited without a verdict: failed`);
            await this.refresh(dir);
            await this.notify_lead_when_landed(dir);
        }
        for (const queued_dir of [...this.queues.keys()]) {
            await this.start_queued(queued_dir);
        }
    }

    /**
     * When no reviewer of `dir` is `queued` or `reading` any more, the lead gets the verdicts
     * notice: through the channel when it runs, else with its next prompt.
     */
    private async notify_lead_when_landed(dir: string): Promise<void> {
        const read = read_session(this.deps.home, dir);
        if (!read.ok) {
            return;
        }
        const swarm = read.summary.session.review?.swarm ?? {};
        const entries = Object.entries(swarm);
        if (entries.length === 0) {
            return;
        }
        if (entries.some(([, record]) => record.state === "queued" || record.state === "reading")) {
            return;
        }
        if ((this.queues.get(dir) ?? []).length > 0) {
            return;
        }
        const done = entries.filter(([, record]) => record.state === "done");
        const failed = entries.filter(([, record]) => record.state === "failed");
        const first = entries[0];
        assert.ok(first !== undefined);
        const target = target_of(read.summary, first[1].pr);
        const pr = target === null ? null : parse_pr_url(target.url);
        if (target === null || pr === null) {
            return;
        }
        const text = verdicts_notice({
            pr,
            url: target.url,
            head: read.summary.session.repos[target.key]?.pr?.head ?? "",
            skill: this.skill_dir(),
            files: done.map(([, record]) => verdict_file(record.model)),
            failed: failed.map(([name]) => name),
        });
        const lead = this.deps.agents.get(dir, LEAD_NAME);
        if (lead === null || lead.notify === undefined) {
            this.deps.agents.queue_for_next_prompt(dir, LEAD_NAME, text);
            this.log(`verdicts of ${dir} landed; the notice waits for ${LEAD_NAME}'s next prompt`);
            return;
        }
        try {
            const disposition = await lead.notify(text);
            this.log(`verdicts of ${dir} landed; ${LEAD_NAME} notified (${disposition})`);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.deps.agents.queue_for_next_prompt(dir, LEAD_NAME, text);
            this.log(`verdicts of ${dir} landed; notify ${LEAD_NAME} failed (${reason}); queued`);
        }
    }

    private swarm_record(dir: string, agent: string): SwarmRecord | null {
        if (!agent.startsWith(REVIEW_AGENT_PREFIX)) {
            return null;
        }
        const read = read_session(this.deps.home, dir);
        if (!read.ok) {
            return null;
        }
        return read.summary.session.review?.swarm[agent] ?? null;
    }

    /** Writes the reviewer's state (and on the first write, its model and PR) to the file. */
    private record(
        dir: string,
        name: string,
        state: SwarmState,
        facts?: Pick<SwarmRecord, "model" | "pr">,
    ): void {
        const read = read_session(this.deps.home, dir);
        if (!read.ok) {
            return;
        }
        const session = read.summary.session;
        session.review ??= { swarm: {} };
        const current = session.review.swarm[name];
        const base =
            facts ?? (current === undefined ? null : { model: current.model, pr: current.pr });
        assert.ok(base !== null, `reviewer ${name} has no record in ${dir}`);
        session.review.swarm[name] = { model: base.model, pr: base.pr, state };
        write_session(read.summary);
    }

    private ensure_brief(
        summary: SessionSummary,
        name: string,
        model: string,
        target: ReviewTarget,
        skill: string | null,
    ): void {
        const path = agent_brief_path(summary.path, name);
        if (existsSync(path)) {
            return;
        }
        const pr = parse_pr_url(target.url);
        assert.ok(pr !== null, `${target.url} is not a GitHub PR URL`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, render_review_brief({ name, model, pr, url: target.url, skill }));
    }

    private async refresh(dir: string): Promise<void> {
        if (this.deps.refresh !== undefined) {
            await this.deps.refresh(dir);
        }
    }
}

/** `review-<model-slug>`, or `review-<repo>-<model-slug>` when the session has several PRs. */
export function reviewer_name(model: string, repo: string, several: boolean): string {
    const slug = model_slug(model);
    assert.ok(slug.length > 0, `model ${model} yields no name`);
    if (several) {
        return `${REVIEW_AGENT_PREFIX}${model_slug(repo)}-${slug}`;
    }
    return `${REVIEW_AGENT_PREFIX}${slug}`;
}

/**
 * True when a line of the text is `VERDICT: BLOCKING` or `VERDICT: CLEAR`. The brief's
 * template line (`VERDICT: BLOCKING | CLEAR`), which an echo of the kickoff would carry,
 * names both and does not count.
 */
export function has_verdict_line(text: string): boolean {
    return text.split("\n").some((line) => {
        const trimmed = line.trim().replace(/^[`*_\s]+|[`*_\s]+$/g, "");
        if (!trimmed.startsWith(REVIEW_VERDICT_PREFIX)) {
            return false;
        }
        const verdict = trimmed.slice(REVIEW_VERDICT_PREFIX.length).trim();
        return verdict === "BLOCKING" || verdict === "CLEAR";
    });
}

/** `artifacts/reviews/<model-slug>.md`, relative to the session directory. */
export function verdict_file(model: string): string {
    return `${REVIEW_VERDICTS_DIR}/${model_slug(model)}.md`;
}

/** Writes the verdict text to its file under the session; returns the relative path. */
export function write_verdict(session_path: string, model: string, text: string): string {
    assert.ok(text.trim().length > 0, "a verdict must not be empty");
    const relative = verdict_file(model);
    const path = join(session_path, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
    return relative;
}

/** The last assistant message's text in the agent's transcript, or empty. */
export function last_assistant_text(session_path: string, agent: string): string {
    const events = agent_history(session_path, agent);
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type !== "message_end" || event.message.role !== "assistant") {
            continue;
        }
        return text_of(event.message.content);
    }
    return "";
}

function text_of(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }
    return content
        .filter((part): part is { type: "text"; text: string } => {
            return typeof part === "object" && part !== null && part.type === "text";
        })
        .map((part) => part.text)
        .join("\n");
}

function target_of(summary: SessionSummary, key: string): ReviewTarget | null {
    const pr = summary.session.repos[key]?.pr;
    if (pr === null || pr === undefined) {
        return null;
    }
    return { key, number: pr.number, url: pr.url };
}

function key_of(dir: string, name: string): string {
    return `${dir}/${name}`;
}
