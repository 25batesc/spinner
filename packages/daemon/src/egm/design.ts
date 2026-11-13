// The design tracker (docs/designs/egm-adoption.md, Technical Plan T7, entry 2.12). It
// derives the design stage of every design-track session from the files in
// `<session>/design/` and the doc in the designs repo's worktree, writes the derived fields
// into `session.yaml`, and re-derives `session.stage` and `session.needs_human` in the same
// write, because no pipeline writer runs during the design phase and the UI shows
// `session.needs_human` for a session without PRs. It also writes `<session>/design/.state.json`
// for the extension's edit guard, which has no YAML parser.
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type {
    DesignChange,
    DesignFileView,
    DesignState,
    DesignView,
    GoldfishView,
    Session,
    SessionCost,
    SessionSummary,
} from "@spinner/protocol";
import {
    PLANS_REPO,
    APPROVED_COPY,
    DESIGN_DEFAULT_DIR,
    DESIGN_FILES_MAX,
    DESIGN_STATE_FILE,
    EGM_ARTIFACT_DIR,
    LEAD_NAME,
    RESOLVE_REPORT,
} from "@spinner/protocol";
import type { AgentManager } from "../agents/manager.js";
import type { EventBus } from "../event-bus.js";
import { run, type Runner } from "../git/pinned-clone.js";
import type { SpinnerHome } from "../home.js";
import { read_plan, write_plan } from "../plans/library.js";
import { last_assistant_text } from "../agents/swarm.js";
import { split_mission } from "../pipeline/mission-sections.js";
import { config_for_session } from "../pipeline/poller.js";
import { repo_base } from "../pipeline/pr.js";
import { refresh_session } from "../pipeline/tracker.js";
import { SESSION_SPEC, read_session_spec } from "../stack/runner.js";
import { SPEC_AUTHOR, type MissionWriter } from "../store/mission-writer.js";
import { read_session, write_session } from "../store/session-store.js";
import { check_design_doc } from "./design-doc.js";
import {
    derive_design,
    normalized_doc_hash,
    RESOLVED_LINE,
    type DesignResult,
} from "./derive-design.js";
import { clear_gate } from "./gate.js";
import {
    chip_state,
    child_key,
    read_attributions,
    running_steps,
    session_runs,
    type GoldfishRun,
    type GoldfishWatcher,
} from "./goldfish.js";

/** At most this many sessions get a doc watcher; past it a session refreshes on settle only. */
export const DOC_WATCHERS_MAX = 100;

export interface DesignTrackerDeps {
    home: SpinnerHome;
    /** The daemon's `ActionContext.cwd`, for `config_for_session`. */
    cwd: string;
    agents: AgentManager;
    bus: EventBus;
    /** The daemon's one mission writer, for the Goal pointer of `set_doc`. */
    writer: MissionWriter;
    /** Publishes the session's view after a write. */
    refresh: (dir: string) => Promise<void>;
    log: (line: string) => void;
    runner?: Runner;
    /** The Goldfish watcher (4.8); without it the view shows no Goldfish. */
    goldfish?: GoldfishWatcher;
    /** The session's cost (4.8); without it every Goldfish `usd` is 0. */
    cost?: (dir: string) => SessionCost;
}

/** Where a session's design doc lives: the designs repo, its worktree and the directory. */
export interface DesignsLocation {
    repo: string;
    /** Absolute. */
    worktree: string;
    /** Absolute, inside `worktree`. */
    dir: string;
}

/** `set_doc` refused the path: the route answers 400 with the message. */
export class DesignDocRefused extends Error {}
/** `set_doc` conflicts with an approval: the route answers 409 with the message. */
export class DesignDocConflict extends Error {}

/**
 * What the lead did since the last refresh (3.11). `settled`: its turn ended, so `waiting` is
 * derived again from its last text. `started`: the event time of its `agent_start`, which
 * ends `waiting` and clears a gate asked before it.
 */
interface LeadChange {
    settled?: boolean;
    started?: string;
}

/** The facts `refresh` and `view` both read from disk. */
interface DesignReads {
    files: DesignFileView[];
    result: DesignResult;
    doc_missing: boolean;
    /** The session's Goldfish runs; `[]` without the watcher. */
    runs: GoldfishRun[];
}

export class DesignTracker {
    private readonly watchers = new Map<string, { path: string; watcher: FSWatcher }>();
    private readonly chains = new Map<string, Promise<void>>();
    private readonly logged = new Set<string>();
    /** The doc hash each session's agents were last told about (6.6); in memory only. */
    private readonly notified = new Map<string, string>();
    private readonly unsubscribe: () => void;
    private readonly runner: Runner;

    constructor(private readonly deps: DesignTrackerDeps) {
        this.runner = deps.runner ?? run;
        this.unsubscribe = deps.bus.subscribe((event) => {
            if (event.type === "agent.settled" && event.agent === LEAD_NAME) {
                void this.refresh(event.session, { settled: true });
            }
            if (
                event.type === "agent.event" &&
                event.agent === LEAD_NAME &&
                event.event.type === "agent_start"
            ) {
                void this.refresh(event.session, { started: event.ts });
            }
            if (event.type === "session.closed") {
                void this.stop_watcher(event.session);
            }
        });
    }

    /** On daemon start: a doc watcher and a refresh for every design-track session. */
    async prime(): Promise<void> {
        const root = this.deps.home.sessions;
        const dirs = existsSync(root) ? readdirSync(root) : [];
        for (const dir of dirs) {
            const read = read_session(this.deps.home, dir);
            if (read.ok && read.summary.session.design?.track === "design") {
                this.watch_doc(read.summary);
                await this.refresh(dir);
            }
        }
    }

    async close(): Promise<void> {
        this.unsubscribe();
        for (const dir of [...this.watchers.keys()]) {
            await this.stop_watcher(dir);
        }
    }

    /** Re-derives the design fields of one session, one refresh at a time per session. */
    refresh(dir: string, change: LeadChange = {}): Promise<void> {
        const previous = this.chains.get(dir) ?? Promise.resolve();
        const next = previous.then(() => this.refresh_now(dir, change));
        this.chains.set(
            dir,
            next.catch((error: unknown) => {
                this.deps.log(`design ${dir}: refresh failed: ${String(error)}`);
            }),
        );
        return next;
    }

    private async refresh_now(dir: string, change: LeadChange): Promise<void> {
        let published = false;
        if (change.started !== undefined && this.gate_before(dir, change.started)) {
            // A gate answered in the lead's terminal: the lead's next turn started after it.
            published = clear_gate(this.deps.home, dir);
        }
        const read = read_session(this.deps.home, dir);
        if (!read.ok || read.summary.session.design === undefined) {
            return;
        }
        const summary = read.summary;
        const before = summary.session;
        const copy: Session = structuredClone(before);
        const design = copy.design as DesignState;
        if (design.track === "design") {
            if (change.started !== undefined) {
                design.waiting = false;
            }
            let facts = this.reads(summary, true, design.waiting === true).result;
            if (change.settled === true) {
                const text = last_assistant_text(summary.path, LEAD_NAME).trim();
                design.waiting =
                    text.endsWith("?") && design.gate === undefined && facts.stage !== "approved";
                facts = this.reads(summary, true, design.waiting).result;
            }
            design.stage = facts.stage;
            design.needs = facts.needs;
            design.changed_after_approval = facts.changed_after_approval;
        }
        const config = config_for_session(summary, this.deps.home, this.deps.cwd, this.deps.log);
        const refreshed = refresh_session(before, copy, config, new Date());
        let wrote = false;
        if (design_fields_differ(before, refreshed.session)) {
            write_session({ ...summary, session: refreshed.session });
            wrote = true;
        }
        if (this.write_state(summary, refreshed.session.design as DesignState)) {
            wrote = true;
        }
        if (wrote || published) {
            await this.deps.refresh(dir);
        }
        await this.notify_change(summary, refreshed.session.design as DesignState);
    }

    /**
     * Once per doc hash after the approval is invalidated (D7, 6.6): tells every running agent
     * of the session which sections changed, by steer where the harness has no `notify`. A
     * missing doc counts as changed and is told once as well.
     */
    private async notify_change(summary: SessionSummary, design: DesignState): Promise<void> {
        const dir = summary.dir;
        if (design.track !== "design" || design.changed_after_approval !== true) {
            this.notified.delete(dir);
            return;
        }
        const doc_path = this.doc_path(summary);
        const present = doc_path !== null && existsSync(doc_path);
        const key = present ? normalized_doc_hash(readFileSync(doc_path, "utf8")) : "missing";
        if (this.notified.get(dir) === key) {
            return;
        }
        this.notified.set(dir, key);
        const headings = this.changes(summary).map((change) => change.heading);
        const sections = headings.length === 0 ? "the doc" : headings.join(", ");
        const text =
            `The design doc changed in ${sections}; the approval is invalidated. ` +
            "Your code writes stay locked until the operator re-approves.";
        await this.deps.agents.notify_all(dir, text, { steer_fallback: true });
    }

    /**
     * The `## ` sections that differ between `approved.md` and the doc now, by heading and
     * body (6.6). Empty without an approval, without the copy, or when the hash matches.
     */
    changes(summary: SessionSummary): DesignChange[] {
        const approval = summary.session.design?.approved;
        const copy = join(summary.path, EGM_ARTIFACT_DIR, APPROVED_COPY);
        if (approval === undefined || !existsSync(copy)) {
            return [];
        }
        const doc_path = this.doc_path(summary);
        const current =
            doc_path !== null && existsSync(doc_path) ? readFileSync(doc_path, "utf8") : "";
        if (current.length > 0 && normalized_doc_hash(current) === approval.sha256) {
            return [];
        }
        return changed_sections(readFileSync(copy, "utf8"), current);
    }

    /** True when the session has a gate asked before `time` (an ISO 8601 event time). */
    private gate_before(dir: string, time: string): boolean {
        const read = read_session(this.deps.home, dir);
        const gate = read.ok ? read.summary.session.design?.gate : undefined;
        if (gate === undefined) {
            return false;
        }
        return Date.parse(time) > Date.parse(gate.asked);
    }

    /** `.state.json` on both tracks, only when its content changed. Returns whether it wrote. */
    private write_state(summary: SessionSummary, design: DesignState): boolean {
        const location = this.designs_of(summary);
        const state = {
            track: design.track,
            stage: design.stage ?? null,
            approved: design.approved !== undefined && design.changed_after_approval !== true,
            designs_dir: location?.dir ?? null,
        };
        const text = `${JSON.stringify(state, null, 4)}\n`;
        const file = join(summary.path, EGM_ARTIFACT_DIR, DESIGN_STATE_FILE);
        if (existsSync(file) && readFileSync(file, "utf8") === text) {
            return false;
        }
        mkdirSync(join(summary.path, EGM_ARTIFACT_DIR), { recursive: true });
        writeFileSync(file, text);
        return true;
    }

    /**
     * The designs repo and directory from the session's spec copy: `designs`, else the first
     * repo and `DESIGN_DEFAULT_DIR`. Null when that repo has no worktree in this session.
     */
    designs_of(summary: SessionSummary): DesignsLocation | null {
        if (summary.session.kind === "plan") {
            // A planning session writes into its plan's directory of the library
            // (docs/designs/talk-change-ship.md, 4.2); `design.doc` is relative to the library.
            const plans = this.deps.home.plans;
            return { repo: PLANS_REPO, worktree: plans, dir: join(plans, summary.dir) };
        }
        const spec_file = join(summary.path, SESSION_SPEC);
        const spec = existsSync(spec_file) ? read_session_spec(summary).spec : null;
        const repos = summary.session.repos ?? {};
        const first = Object.keys(spec?.repos ?? repos)[0];
        const repo = spec?.designs?.repo ?? first;
        const worktree = repo === undefined ? undefined : repos[repo]?.worktree;
        if (repo === undefined || worktree === undefined) {
            return null;
        }
        const root = join(summary.path, worktree);
        return { repo, worktree: root, dir: join(root, spec?.designs?.dir ?? DESIGN_DEFAULT_DIR) };
    }

    /**
     * The lead's `design_doc` tool. Refuses while an approval stands, and any path that
     * `check_design_doc` refuses; else records the doc, points the Goal at it and refreshes.
     */
    async set_doc(dir: string, path: string): Promise<SessionSummary> {
        const read = read_session(this.deps.home, dir);
        assert.ok(read.ok, `${dir} must exist to name its design doc`);
        const design = read.summary.session.design;
        assert.ok(design !== undefined, `${dir} has no design block`);
        if (design.approved !== undefined && design.changed_after_approval !== true) {
            throw new DesignDocConflict("the design is approved; clear the approval first");
        }
        const location = this.designs_of(read.summary);
        if (location === null) {
            throw new DesignDocRefused("this session has no worktree of the designs repo");
        }
        const refusal = await check_design_doc({
            path,
            worktree: location.worktree,
            designs_dir: location.dir,
            base: repo_base(read.summary, location.repo),
            current: design.repo === location.repo ? (design.doc ?? null) : null,
            runner: this.runner,
        });
        if (refusal !== null) {
            throw new DesignDocRefused(refusal);
        }
        const doc = relative(location.worktree, path);
        const fresh = read_session(this.deps.home, dir);
        assert.ok(fresh.ok && fresh.summary.session.design !== undefined);
        const named = { ...fresh.summary.session.design, doc, repo: location.repo };
        fresh.summary.session.design = named;
        write_session(fresh.summary);
        if (location.repo === PLANS_REPO) {
            // The library's record names the document, so the plan stands without its session.
            const record = read_plan(this.deps.home, dir);
            if (record !== null) {
                const updated = new Date().toISOString();
                write_plan(this.deps.home, { ...record, doc: basename(path), updated });
            }
        }
        await this.deps.writer.write(dir, {
            section: "goal",
            mode: "replace",
            author: SPEC_AUTHOR,
            text: `The design doc holds the goal: \`${location.repo}/${doc}\`.`,
        });
        this.watch_doc(fresh.summary);
        await this.refresh(dir);
        const check = read_session(this.deps.home, dir);
        assert.ok(check.ok, `${dir} must read back after set_doc`);
        return check.summary;
    }

    /** The design facts for `build_session_view`: the same reads as `refresh`, no writes. */
    view(summary: SessionSummary): DesignView | undefined {
        const design = summary.session.design;
        if (design === undefined) {
            return undefined;
        }
        const reads = this.reads(summary, false, design.waiting === true);
        const on_design = design.track === "design";
        const location = this.designs_of(summary);
        return {
            track: design.track,
            stage: on_design ? reads.result.stage : null,
            files: reads.files,
            reviews: reads.result.reviews,
            consolidated: reads.result.consolidated,
            resolve: reads.result.resolve,
            review_run: design.review_run ?? null,
            doc: design.doc ?? null,
            repo: design.repo ?? location?.repo ?? null,
            designs_dir: location?.dir ?? null,
            doc_missing: reads.doc_missing,
            approved: design.approved ?? null,
            approvals: design.approvals ?? [],
            changed_after_approval: reads.result.changed_after_approval,
            gate: design.gate ?? null,
            ...this.goldfish_fields(summary, reads.runs),
        };
    }

    /** `goldfish`, `goldfish_live` and `cost_by_stage` of the view (4.8). */
    private goldfish_fields(
        summary: SessionSummary,
        runs: GoldfishRun[],
    ): Pick<DesignView, "goldfish" | "goldfish_live" | "cost_by_stage"> {
        if (this.deps.goldfish === undefined) {
            return { goldfish: [], goldfish_live: 0, cost_by_stage: {} };
        }
        const children = this.deps.cost?.(summary.dir).children ?? {};
        const steps = read_attributions(summary.path);
        const goldfish: GoldfishView[] = [];
        const cost_by_stage: DesignView["cost_by_stage"] = {};
        for (const run of runs) {
            const design_step = steps[run.run] ?? null;
            for (const step of run.steps) {
                const usd = children[child_key(run.run, step.index)]?.usd ?? 0;
                goldfish.push({
                    run: run.run,
                    step: step.index,
                    agent: step.agent,
                    persona: step.agent.startsWith("egm-") ? step.agent.slice(4) : null,
                    state: chip_state(step.status, run.state),
                    model: step.model,
                    tokens: step.tokens,
                    usd,
                    started: iso_or_null(step.started ?? run.started),
                    last_activity: iso_or_null(step.last_activity),
                    design_step,
                    transcript: step.session_file !== null && existsSync(step.session_file),
                });
                if (design_step !== null) {
                    cost_by_stage[design_step] = (cost_by_stage[design_step] ?? 0) + usd;
                }
            }
        }
        return { goldfish, goldfish_live: this.deps.goldfish.live_count(), cost_by_stage };
    }

    /** Lists the design files, reads the resolve report and the doc, and derives. */
    private reads(summary: SessionSummary, log_cap: boolean, waiting: boolean): DesignReads {
        const design = summary.session.design as DesignState;
        const files = this.design_files(summary, log_cap);
        const lead_busy = this.deps.agents.is_busy(summary.dir, LEAD_NAME);
        const runs =
            this.deps.goldfish === undefined ? [] : session_runs(summary.path, lead_busy);
        const doc_path = this.doc_path(summary);
        const doc_missing = doc_path !== null && !existsSync(doc_path);
        const doc_hash =
            doc_path === null || doc_missing
                ? null
                : normalized_doc_hash(readFileSync(doc_path, "utf8"));
        const result = derive_design({
            files: files.map((file) => file.name),
            resolve_first_line: resolve_status_line(
                join(summary.path, EGM_ARTIFACT_DIR, RESOLVE_REPORT),
            ),
            doc: design.doc ?? null,
            doc_hash,
            doc_missing,
            approved: design.approved ?? null,
            review_run: design.review_run ?? null,
            gate: design.gate ?? null,
            waiting,
            // The manager's busy flag runs from the lead's `agent_start` to `agent_settled`.
            lead_busy,
            // A running Goldfish keeps the "lead waits" line off (T5).
            goldfish_running: running_steps(runs),
        });
        return { files, result, doc_missing, runs };
    }

    /** `<session>/design/*.md` without dotfiles; past the cap the newest by mtime. */
    private design_files(summary: SessionSummary, log_cap: boolean): DesignFileView[] {
        const root = join(summary.path, EGM_ARTIFACT_DIR);
        if (!existsSync(root)) {
            return [];
        }
        const files: DesignFileView[] = [];
        for (const entry of readdirSync(root, { withFileTypes: true })) {
            if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.endsWith(".md")) {
                continue;
            }
            const stat = statSync(join(root, entry.name));
            files.push({ name: entry.name, bytes: stat.size, mtime: stat.mtime.toISOString() });
        }
        files.sort((a, b) => b.mtime.localeCompare(a.mtime) || a.name.localeCompare(b.name));
        if (files.length <= DESIGN_FILES_MAX) {
            return files;
        }
        if (log_cap && !this.logged.has(`files:${summary.dir}`)) {
            this.logged.add(`files:${summary.dir}`);
            this.deps.log(`design ${summary.dir}: more than ${DESIGN_FILES_MAX} files; the newest`);
        }
        return files.slice(0, DESIGN_FILES_MAX);
    }

    /** The files of `<session>/design/`, as the view lists them (5.3). */
    files(summary: SessionSummary): DesignFileView[] {
        return this.design_files(summary, false);
    }

    /** The doc's absolute path in the worktree of `design.repo`, or null before `design_doc`. */
    doc_path(summary: SessionSummary): string | null {
        const design = summary.session.design;
        if (design?.doc === undefined || design.repo === undefined) {
            return null;
        }
        if (design.repo === PLANS_REPO) {
            return join(this.deps.home.plans, design.doc);
        }
        const worktree = summary.session.repos?.[design.repo]?.worktree;
        if (worktree === undefined) {
            return null;
        }
        return join(summary.path, worktree, design.doc);
    }

    /** One chokidar watcher on the doc file; each event refreshes the session. */
    private watch_doc(summary: SessionSummary): void {
        const path = this.doc_path(summary);
        const current = this.watchers.get(summary.dir);
        if (path === null || current?.path === path) {
            return;
        }
        if (current !== undefined) {
            void current.watcher.close();
            this.watchers.delete(summary.dir);
        }
        if (this.watchers.size >= DOC_WATCHERS_MAX) {
            if (!this.logged.has(`watch:${summary.dir}`)) {
                this.logged.add(`watch:${summary.dir}`);
                this.deps.log(
                    `design ${summary.dir}: ${DOC_WATCHERS_MAX} doc watchers run; ` +
                        "this doc refreshes when the lead settles",
                );
            }
            return;
        }
        const watcher = chokidar.watch(path, {
            ignoreInitial: true,
            awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
        });
        watcher.on("all", () => void this.refresh(summary.dir));
        watcher.on("error", (error) => this.deps.log(`design ${summary.dir}: ${String(error)}`));
        this.watchers.set(summary.dir, { path, watcher });
    }

    private async stop_watcher(dir: string): Promise<void> {
        const current = this.watchers.get(dir);
        this.watchers.delete(dir);
        await current?.watcher.close();
    }
}

/** `split_mission` asserts fewer than 100 sections; a doc past this is compared whole. */
const DOC_SECTIONS_MAX = 98;

/**
 * The `## ` sections of two docs that differ, by heading (the n-th section of a repeated
 * heading pairs with the n-th) and by body with trailing space trimmed. The approved order
 * first, then the sections only the current doc has. Text above the first `## ` is not a
 * section, so the status line never counts.
 */
export function changed_sections(approved: string, current: string): DesignChange[] {
    const too_many = (text: string): boolean =>
        text.split("\n").filter((line) => line.startsWith("## ")).length > DOC_SECTIONS_MAX;
    if (too_many(approved) || too_many(current)) {
        return [{ heading: "(the whole doc)", approved, current }];
    }
    const before = keyed_sections(approved);
    const after = keyed_sections(current);
    const changes: DesignChange[] = [];
    for (const [key, section] of before) {
        const now = after.get(key);
        if (now === undefined || now.body !== section.body) {
            changes.push({
                heading: section.heading,
                approved: section.body,
                current: now?.body ?? null,
            });
        }
    }
    for (const [key, section] of after) {
        if (!before.has(key)) {
            changes.push({ heading: section.heading, approved: null, current: section.body });
        }
    }
    return changes;
}

function keyed_sections(text: string): Map<string, { heading: string; body: string }> {
    const sections = new Map<string, { heading: string; body: string }>();
    const seen = new Map<string, number>();
    for (const block of split_mission(text.replace(/\r\n/g, "\n"))) {
        if (block.heading === "") {
            continue;
        }
        const index = seen.get(block.heading) ?? 0;
        seen.set(block.heading, index + 1);
        sections.set(`${block.heading}#${index}`, {
            heading: block.heading,
            body: block.body.trimEnd(),
        });
    }
    return sections;
}

function iso_or_null(ms: number | null): string | null {
    return ms === null ? null : new Date(ms).toISOString();
}

/** True when a field the tracker derives differs between the read and the refreshed copy. */
function design_fields_differ(before: Session, after: Session): boolean {
    if (before.stage !== after.stage || before.needs_human !== after.needs_human) {
        return true;
    }
    const a = before.design;
    const b = after.design;
    return (
        a?.stage !== b?.stage ||
        (a?.needs ?? null) !== (b?.needs ?? null) ||
        a?.changed_after_approval !== b?.changed_after_approval ||
        a?.waiting !== b?.waiting
    );
}

/**
 * The resolve report's status line. `egm-resolve` Step 5 says "add a `Status: resolved` line at
 * the top"; a lead writes it as the first line, or in bold a few lines down under the title
 * (session 3, run F). Any of the first lines that reads `Status: resolved` once the markdown
 * emphasis is stripped counts; otherwise the first non-empty line, so the caller sees why.
 */
function resolve_status_line(path: string): string | null {
    if (!existsSync(path)) {
        return null;
    }
    const lines = readFileSync(path, "utf8")
        .split(/\r?\n/)
        .filter((text) => text.trim().length > 0)
        .slice(0, RESOLVE_STATUS_LINES_MAX);
    for (const line of lines) {
        const plain = line.replace(/[*_#`]/g, "").trim();
        if (plain.toLowerCase().startsWith(RESOLVED_LINE.toLowerCase())) {
            return RESOLVED_LINE;
        }
    }
    const first = lines[0];
    return first === undefined ? null : first.trim();
}

/** How far down a resolve report the status line may sit. */
const RESOLVE_STATUS_LINES_MAX = 10;
