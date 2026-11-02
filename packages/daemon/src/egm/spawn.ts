// What a lead of an EGM session gets at spawn (docs/designs/egm-adoption.md, T3): the skills
// directory, the adapter directory, the run directory and the artifact directory. EGM is on
// for a lead when EGM is fetched, the session is an ordinary one (not a review), and the
// operator's pi settings list pi-subagents.
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    EGM_ARTIFACT_DIR,
    EGM_RUNS_DIR,
    SUBAGENTS_PACKAGE,
    type SessionSummary,
} from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";
import { egm_adapter_dir, egm_fetched, egm_source_dir } from "./fetch.js";

export interface EgmSpawn {
    /** `<home>/egm/src`. */
    root: string;
    /** `<home>/egm/src/skills`, passed as `--skill`. */
    skills_dir: string;
    /** `<home>/egm/pi/agents`, `PI_SUBAGENT_EXTRA_AGENT_DIRS`. */
    agents_dir: string;
    /** `<session>/egm-runs`, `PI_SUBAGENTS_TEMP_ROOT`. */
    runs_dir: string;
    /** `<session>/design`. */
    artifacts_dir: string;
}

/** `$PI_CODING_AGENT_DIR/settings.json`, else `~/.pi/agent/settings.json`. */
export function pi_settings_path(env: NodeJS.ProcessEnv): string {
    const dir = env["PI_CODING_AGENT_DIR"];
    const agent_dir = dir !== undefined && dir !== "" ? dir : join(homedir(), ".pi", "agent");
    return join(agent_dir, "settings.json");
}

/**
 * True when the `packages` list of the operator's pi settings has an entry whose source ends
 * with `pi-subagents` once a trailing `@<version>` is removed. A project's `.pi/settings.json`
 * is not read. A missing or invalid file is false.
 */
export function subagents_installed(env: NodeJS.ProcessEnv): boolean {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(pi_settings_path(env), "utf8"));
    } catch {
        return false;
    }
    if (typeof parsed !== "object" || parsed === null) {
        return false;
    }
    const packages = (parsed as Record<string, unknown>)["packages"];
    if (!Array.isArray(packages)) {
        return false;
    }
    return packages.some((entry: unknown) => names_subagents(package_source(entry)));
}

function package_source(entry: unknown): string | null {
    if (typeof entry === "string") {
        return entry;
    }
    if (typeof entry === "object" && entry !== null) {
        const source = (entry as Record<string, unknown>)["source"];
        return typeof source === "string" ? source : null;
    }
    return null;
}

function names_subagents(source: string | null): boolean {
    if (source === null) {
        return false;
    }
    // The version follows at least one character, so a scoped name keeps its leading `@`.
    const unversioned = source.replace(/(?<=.)@[^@/]+$/, "");
    return unversioned.endsWith(SUBAGENTS_PACKAGE);
}

/**
 * The EGM paths for a lead's spawn, or null when EGM is off for this session. Creates the
 * artifact and run directories.
 */
export function egm_spawn(
    home: SpinnerHome,
    summary: SessionSummary,
    env: NodeJS.ProcessEnv,
): EgmSpawn | null {
    if (!egm_fetched(home)) {
        return null;
    }
    if ((summary.session.kind ?? "session") !== "session") {
        return null;
    }
    if (!subagents_installed(env)) {
        return null;
    }
    const artifacts_dir = join(summary.path, EGM_ARTIFACT_DIR);
    const runs_dir = join(summary.path, EGM_RUNS_DIR);
    mkdirSync(artifacts_dir, { recursive: true });
    mkdirSync(runs_dir, { recursive: true });
    const root = egm_source_dir(home);
    return {
        root,
        skills_dir: join(root, "skills"),
        agents_dir: egm_adapter_dir(home),
        runs_dir,
        artifacts_dir,
    };
}
