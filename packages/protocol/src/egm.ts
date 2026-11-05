// EGM, Google's Elephant-Goldfish Model (docs/designs/egm-adoption.md, build session 1). The
// daemon fetches EGM at a pinned commit into `<home>/egm/src`, the way it fetches the diff
// viewer, and generates one pi-subagents agent file per persona under `<home>/egm/pi/agents`
// (the adapter). A session's lead then runs EGM's skills; the Goldfish reviewers run as
// pi-subagents children of the lead. No EGM file enters the Spinner repo.

/** The Spinner home subdirectory that holds the checkout, the adapter and the marker. */
export const EGM_HOME_DIR = "egm";
/** The shallow clone of the pinned commit, under `EGM_HOME_DIR`. */
export const EGM_SOURCE_DIR = "src";
/** The generated pi-subagents agent files, under `EGM_HOME_DIR`. */
export const EGM_ADAPTER_DIR = "pi/agents";
/** Written last by a fetch: `{ sha, adapter_version, fetched }`. Absent means not fetched. */
export const EGM_MARKER_FILE = "fetched.json";

/** The fetch job (one shallow clone) is killed after this long. */
export const EGM_FETCH_TIMEOUT_MS = 300_000;
/** Bumped when the generated adapter text changes, so every home regenerates it. */
export const EGM_ADAPTER_VERSION = 1;

/** The session subdirectory where EGM's skills write briefs, drafts and reports. */
export const EGM_ARTIFACT_DIR = "design";
/** The session subdirectory that is the lead's `PI_SUBAGENTS_TEMP_ROOT`. */
export const EGM_RUNS_DIR = "egm-runs";

/** The 7 EGM skills, as pi discovers them under `<checkout>/skills`. */
export const EGM_SKILLS = [
    "egm-brainstorm",
    "egm-draft",
    "egm-review",
    "egm-review-loop",
    "egm-resolve",
    "egm-bootstrap",
    "egm-drift-report",
] as const;

export type EgmSkill = (typeof EGM_SKILLS)[number];

/** The 5 document standards under `resources/document_standards/`. */
export const EGM_STANDARDS = [
    "feature-spec-standard",
    "heilmeier-standard",
    "implementation-readiness-standard",
    "re-implementation-standard",
    "zoom-out-standard",
] as const;

/** The 9 persona files under `agents/`, without the `.md` suffix. */
export const EGM_PERSONA_FILES = [
    "zoom_out",
    "comprehension",
    "design_critic",
    "implementation_readiness",
    "codebase_details",
    "structural",
    "style",
    "synthesizer",
    "bootstrap_orchestrator",
] as const;

/**
 * The checkout paths the runtime needs. A fetch that misses one fails with that path; a home
 * that misses one counts as not fetched.
 */
export const EGM_REQUIRED_FILES: readonly string[] = [
    ...EGM_SKILLS.map((skill) => `skills/${skill}/SKILL.md`),
    "skills/egm-draft/references/design_doc.md",
    ...EGM_PERSONA_FILES.map((file) => `agents/${file}.md`),
    ...EGM_STANDARDS.map((standard) => `resources/document_standards/${standard}.md`),
    "resources/execution_instructions.md",
    "docs/harnesses.md",
    "LICENSE",
];

export const EGM_SOURCE_URL = "https://github.com/google/elephant-goldfish-model";
export const EGM_LICENSE = "Apache-2.0";
export const EGM_NOTICE =
    "Elephant-Goldfish Model by Google, Apache-2.0. " +
    "Spinner runs its skills from a pinned copy. " +
    "Not an officially supported Google product.";

/** The pi package that gives the lead the `subagent` tool. Without it EGM stays off. */
export const SUBAGENTS_PACKAGE = "pi-subagents";

/**
 * `absent` before the first fetch, `fetching` while the fetch runs, `ready` once the marker
 * matches the pin and the adapter version, `failed` with `error` set after a failed fetch.
 */
export type EgmFetchState = "absent" | "fetching" | "ready" | "failed";

export interface EgmStatus {
    state: EgmFetchState;
    /** The commit the daemon pins (`EGM_PIN.sha`). */
    pinned_sha: string;
    /** The commit of the marker, null when no marker exists. */
    fetched_sha: string | null;
    /** ISO 8601 time of the marker, null when no marker exists. */
    fetched_at: string | null;
    adapter_version: number | null;
    error: string | null;
    source: string;
    license: string;
    notice: string;
    /** Whether the operator's pi settings list pi-subagents (`subagents_installed`). */
    subagents: boolean;
}

export interface EgmResponse {
    egm: EgmStatus;
}

// The design stage (docs/designs/egm-adoption.md, build session 2, Technical Plan T7). The
// daemon derives the stage from the files in `<session>/design/` and the `design` block of
// `session.yaml`; nobody sets it by hand.

/** The design stages, in order. `approved` hands over to the pipeline stage. */
export const DESIGN_STAGES = [
    "intake",
    "brainstorm",
    "drafting",
    "drafted",
    "design-review",
    "resolving",
    "design-ready",
    "approved",
] as const;

export type DesignStage = (typeof DESIGN_STAGES)[number];

/** `design` runs EGM up to an approved doc before the build; `direct` builds at once. */
export const DESIGN_TRACKS = ["design", "direct"] as const;

export type DesignTrack = (typeof DESIGN_TRACKS)[number];

/** The report of each `egm-review` stage, by EGM stage number. Stages 1 to 4 are other skills. */
export const REVIEW_STAGE_REPORTS = {
    "5": "zoom_out_report.md",
    "6": "comprehension_report.md",
    "7": "critic_report.md",
    "8": "intermediate_zoom_out_report.md",
    "9": "implementation_readiness_report.md",
} as const;

export type ReviewStageId = keyof typeof REVIEW_STAGE_REPORTS;

/** The concepts brief that `egm-brainstorm` writes. */
export const BRIEF_FILE = "concepts_brief.md";
/** The draft that `egm-draft` writes before the doc's final file. */
export const DRAFT_FILE = "design_draft.md";
/** The one report of a consolidated (`uninterrupted`) review. */
export const CONSOLIDATED_REPORT = "consolidated_review_report.md";
/** The report that `egm-resolve` works through; `Status: resolved` on its first line closes it. */
export const RESOLVE_REPORT = "goldfish_review_report.md";
/** The copy of the doc at approval. */
export const APPROVED_COPY = "approved.md";
/** `{ track, stage, approved, designs_dir }` for the extension, which has no YAML parser. */
export const DESIGN_STATE_FILE = ".state.json";
/** The reports of earlier review runs live in `reviews/<run id>/`. */
export const REVIEW_ARCHIVE_DIR = "reviews";

/** Every review report name: the five stage reports, the consolidated and the resolve report. */
export const REVIEW_REPORT_FILES: readonly string[] = [
    ...Object.values(REVIEW_STAGE_REPORTS),
    CONSOLIDATED_REPORT,
    RESOLVE_REPORT,
];

/** EGM's review presets, in EGM's words. */
export const REVIEW_PRESETS = [
    "interactive",
    "uninterrupted",
    "feature_spec",
    "implementation",
] as const;

export type ReviewPreset = (typeof REVIEW_PRESETS)[number];

/** An open gate: the one question the lead asked through `ask_question` (build session 3). */
export interface DesignGate {
    question: string;
    options: string[];
    /** ISO 8601 time the lead asked. */
    asked: string;
}

/** One approval of the design doc. `sha256` is the normalized hash (T7). */
export interface DesignApproval {
    /** Repo-relative path of the doc. */
    path: string;
    /** Repo key of the doc. */
    repo: string;
    sha256: string;
    /** ISO 8601 time of the approval. */
    at: string;
    /** The blockers the newest report listed when the operator approved. */
    blockers: number;
    /** The session round the approval belongs to. */
    round: number;
}

/** `design.approvals` keeps at most this many; past it the oldest drops. */
export const DESIGN_APPROVALS_MAX = 100;

/** The review run that the app started (build session 3). Ids are `r1`, `r2`, … */
export interface DesignReviewRun {
    id: string;
    preset: ReviewPreset | null;
    /** ISO 8601 start time. */
    started: string;
}

/** The `design` block of `session.yaml`. `stage`, `needs` and `waiting` are derived. */
export interface DesignState {
    track: DesignTrack;
    stage?: DesignStage;
    /** The derived `needs_human` text of the design stage, or null. */
    needs?: string | null;
    /** True when the lead settled on a question. */
    waiting?: boolean;
    /** Repo-relative path of the design doc; absent until the lead calls `design_doc`. */
    doc?: string;
    /** Repo key of the doc. */
    repo?: string;
    review_run?: DesignReviewRun;
    gate?: DesignGate;
    approved?: DesignApproval;
    /** Every approval, oldest first; at most `DESIGN_APPROVALS_MAX`. */
    approvals?: DesignApproval[];
    /** True when the doc changed after the approval: the approval is invalidated. */
    changed_after_approval?: boolean;
}

/** One file directly in `<session>/design/`. */
export interface DesignFileView {
    name: string;
    bytes: number;
    /** ISO 8601 modification time. */
    mtime: string;
}

export type GoldfishState = "queued" | "running" | "done" | "failed" | "stopped";

/** One Goldfish run of the lead. Build session 4 fills these. */
export interface GoldfishView {
    run: string;
    step: number;
    agent: string;
    persona: string | null;
    state: GoldfishState;
    model: string | null;
    tokens: number;
    usd: number;
    started: string | null;
    last_activity: string | null;
    design_step: "brainstorm" | "draft" | "review" | "build" | null;
    transcript: boolean;
}

/**
 * The design facts of a `SessionView`. `stage` is null outside the design track. `reviews`,
 * `consolidated` and `resolve` describe the current review run. Until build session 4,
 * `goldfish` is `[]`, `goldfish_live` is 0 and `cost_by_stage` is `{}`.
 */
export interface DesignView {
    track: DesignTrack;
    stage: DesignStage | null;
    files: DesignFileView[];
    reviews: Record<ReviewStageId, boolean>;
    consolidated: boolean;
    resolve: "none" | "open" | "resolved";
    review_run: DesignReviewRun | null;
    doc: string | null;
    /**
     * The repo key of the doc, else of the designs repo; null without one. Optional, so a
     * fixture written before build session 3 still type-checks; the daemon always sets it.
     */
    repo?: string | null;
    /**
     * The absolute designs directory (`spinner.yaml` `designs`, T7), the one `.state.json`
     * carries; null when the designs repo has no worktree. Optional, as `repo`.
     */
    designs_dir?: string | null;
    doc_missing: boolean;
    approved: DesignApproval | null;
    approvals: DesignApproval[];
    changed_after_approval: boolean;
    gate: DesignGate | null;
    goldfish: GoldfishView[];
    goldfish_live: number;
    cost_by_stage: Partial<Record<"brainstorm" | "draft" | "review" | "build", number>>;
}

/** Body of `PUT /sessions/:dir/design/track`. */
export interface DesignTrackRequest {
    track: DesignTrack;
}

/** Body of `PUT /sessions/:dir/design/doc`: the absolute path of the doc. */
export interface DesignDocRequest {
    path: string;
}

/** The designs directory inside the designs repo, unless `spinner.yaml` `designs.dir` says. */
export const DESIGN_DEFAULT_DIR = "docs/designs";
/** The tracker lists at most this many files in `<session>/design/`; past it the newest win. */
export const DESIGN_FILES_MAX = 200;

/** The track a new paste session gets when EGM is ready and pi-subagents is installed. */
export const DESIGN_DEFAULT_TRACK: DesignTrack = "design";

// Gates and skills in the app (docs/designs/egm-adoption.md, build session 3, T8, T9).

/** Body of `PUT /sessions/:dir/design/gate`: the lead's `ask_question` tool. */
export interface DesignGateRequest {
    question: string;
    options: string[];
}

/** A gate has at most this many options; EGM's gates have 2 to 6. */
export const DESIGN_GATE_OPTIONS_MAX = 6;
/** The longest gate question, in characters. */
export const DESIGN_GATE_QUESTION_MAX = 2000;
/** The longest gate option, in characters. */
export const DESIGN_GATE_OPTION_MAX = 300;

/** Body of `POST /sessions/:dir/design/answer`: the text that answers the lead. */
export interface DesignAnswerRequest {
    text: string;
}

/** The longest answer, in characters. */
export const DESIGN_ANSWER_MAX = 4000;

/** Body of `POST /sessions/:dir/design/run`: an EGM skill to start in the lead. */
export interface DesignRunRequest {
    skill: EgmSkill;
    args?: string;
    /** Only with `egm-review`. */
    preset?: ReviewPreset;
}

/** The longest argument text, given or composed, in characters. */
export const DESIGN_RUN_ARGS_MAX = 4000;
/** Review run ids go up to `r99`, because the archive route matches `^r\d{1,2}$`. */
export const REVIEW_RUNS_MAX = 99;
/** The replies that `egm-resolve` Step 4 interprets; the resolve card sends one. */
export const RESOLVE_ANSWERS = ["Auto accept", "Continue", "Interactive breakdown"] as const;

// Goldfish visibility (docs/designs/egm-adoption.md, build session 4, T5, T6). The daemon
// reads the status files that pi-subagents writes under `<session>/egm-runs/` and shows each
// Goldfish step as a chip with its state, tokens and cost.

/** The watcher polls a session's runs this often while it watches the session. */
export const GOLDFISH_POLL_MS = 2_000;
/** The watcher keeps polling this long after the lead's last `agent.settled`. */
export const GOLDFISH_SETTLE_POLL_MS = 30_000;
/** The watcher reads at most this many run directories per session, the newest. */
export const GOLDFISH_RUNS_MAX = 200;
/** While this many Goldfish run across all sessions, `POST …/design/run` answers 409 (D8). */
export const GOLDFISH_LIVE_MAX = 12;
/** `{ "<runId>": "<design step>" }` under `<session>/egm-runs/`: each run's design step. */
export const GOLDFISH_RUNS_FILE = "runs.json";

// The design workspace (docs/designs/egm-adoption.md, build session 5).

/** `GET /sessions/:dir/design/files`: the files of `<session>/design/` and the archived runs. */
export interface DesignFilesResponse {
    files: DesignFileView[];
    /** The `r<n>` directories of `<session>/design/reviews/`, newest first. */
    review_runs: string[];
}

/** A design file name the workspace routes accept; a name that starts with `.` is refused too. */
export const DESIGN_FILE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}\.md$/;

// Approval and the build (docs/designs/egm-adoption.md, build session 6, T10).

/**
 * Body of `POST /sessions/:dir/design/approve`. `build` prompts the lead with the build
 * message (D5). `blockers_confirmed` must equal the blockers the newest report lists when
 * that count is above 0 (D2, review M17).
 */
export interface DesignApproveRequest {
    build: boolean;
    blockers_confirmed?: number;
}

/**
 * What the seed did at approval (docs/designs/session-workspace.md, T4): one Plan item per
 * doc entry, owner null. `stale` lists the entry ids of items whose entry's title changed;
 * `orphaned` the ids of items whose entry left the doc. Both stay in place; the seed never
 * rewrites a token.
 */
export interface SeedResult {
    /** Repo-relative path of the doc. */
    doc_path: string;
    /** The first 12 characters of the approval hash. */
    sha12: string;
    added: number;
    kept: number;
    stale: string[];
    orphaned: string[];
}

/** The 409 body of `POST /sessions/:dir/design/approve`. `blockers` is null for other refusals. */
export interface DesignApproveRefusal {
    error: string;
    blockers: number | null;
}

/** One `## ` section that differs between `approved.md` and the doc; null when absent. */
export interface DesignChange {
    heading: string;
    approved: string | null;
    current: string | null;
}

/** `GET /sessions/:dir/design/changes`: an empty list without a change. */
export interface DesignChangesResponse {
    changes: DesignChange[];
}
