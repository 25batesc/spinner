// EGM, Google's Elephant-Goldfish Model, as a set of skills. The daemon fetches EGM at a
// pinned commit into `<home>/egm/src`, the way it fetches the diff viewer, and generates one
// pi-subagents agent file per persona under `<home>/egm/pi/agents` (the adapter). A lead can
// then run `/skill:egm-brainstorm`, `egm-draft`, `egm-review` and the rest when the operator
// asks for one; the Goldfish reviewers run as pi-subagents children of the lead. No EGM file
// enters the Spinner repo.
//
// Until 2026-11-23 Spinner also ran EGM as a lifecycle: a design track with stages, gates,
// an approval and tabs for each step. The operator found it too slow and too costly, and it
// grew the scope of every project. It is gone. The skills remain, nothing enforces them, and
// what they write is ordinary session files under `<session>/egm/`.

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

/**
 * The session subdirectory where EGM's skills write briefs, drafts and reports. The Files
 * view shows it like any other directory. Sessions from before 2026-11-23 have their files
 * in `design/`, which stays where it is.
 */
export const EGM_ARTIFACT_DIR = "egm";
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

// The lead's subagents. An EGM skill starts its Goldfish reviewers through pi-subagents, and
// the lead can start any other subagent the same way. The daemon reads the status files that
// pi-subagents writes under `<session>/egm-runs/` and shows each step as a row of the agents
// table with its state, tokens and cost.

export type GoldfishState = "queued" | "running" | "done" | "failed" | "stopped";

/** One subagent step of the lead. */
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
    transcript: boolean;
}

/** The watcher polls a session's runs this often while it watches the session. */
export const GOLDFISH_POLL_MS = 2_000;
/** The watcher keeps polling this long after the lead's last `agent.settled`. */
export const GOLDFISH_SETTLE_POLL_MS = 30_000;
/** The watcher reads at most this many run directories per session, the newest. */
export const GOLDFISH_RUNS_MAX = 200;
