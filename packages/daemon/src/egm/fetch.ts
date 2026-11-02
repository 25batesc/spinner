// Fetches EGM at the pin (docs/designs/egm-adoption.md, T2), the way `diff/fetch.ts` fetches
// the diff viewer: a shallow clone of one commit into `<home>/egm/src`, a check of the
// runtime files, the generated adapter under `<home>/egm/pi/agents`, and the marker
// `<home>/egm/fetched.json` last. The fetch runs no install step and no code from the
// checkout. A moved pin or a moved adapter version fetches again.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    EGM_ADAPTER_DIR,
    EGM_ADAPTER_VERSION,
    EGM_FETCH_TIMEOUT_MS,
    EGM_HOME_DIR,
    EGM_LICENSE,
    EGM_MARKER_FILE,
    EGM_NOTICE,
    EGM_REQUIRED_FILES,
    EGM_SOURCE_DIR,
    EGM_SOURCE_URL,
    type EgmStatus,
} from "@spinner/protocol";
import { clone_at_sha, run, type Log, type Runner } from "../git/pinned-clone.js";
import type { SpinnerHome } from "../home.js";
import { write_adapter } from "./adapter.js";
import { EGM_PIN } from "./pins.js";
import { subagents_installed } from "./spawn.js";

/** `<home>/egm`. */
export function egm_home(home: SpinnerHome): string {
    return join(home.root, EGM_HOME_DIR);
}

/** `<home>/egm/src`, the checkout. */
export function egm_source_dir(home: SpinnerHome): string {
    return join(egm_home(home), EGM_SOURCE_DIR);
}

/** `<home>/egm/pi/agents`, the generated pi-subagents agent files. */
export function egm_adapter_dir(home: SpinnerHome): string {
    return join(egm_home(home), EGM_ADAPTER_DIR);
}

export function marker_path(home: SpinnerHome): string {
    return join(egm_home(home), EGM_MARKER_FILE);
}

export interface EgmMarker {
    sha: string;
    adapter_version: number;
    /** ISO 8601 time the fetch finished. */
    fetched: string;
}

/** The marker of the last successful fetch, or null before one or for an unreadable file. */
export function read_egm_marker(home: SpinnerHome): EgmMarker | null {
    const path = marker_path(home);
    if (!existsSync(path)) {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null) {
        return null;
    }
    const record = parsed as Record<string, unknown>;
    const { sha, adapter_version, fetched } = record;
    if (typeof sha !== "string" || typeof adapter_version !== "number") {
        return null;
    }
    return { sha, adapter_version, fetched: typeof fetched === "string" ? fetched : "" };
}

/** The first required file missing from the checkout, or null when all exist. */
function first_missing(home: SpinnerHome): string | null {
    const source = egm_source_dir(home);
    return EGM_REQUIRED_FILES.find((file) => !existsSync(join(source, file))) ?? null;
}

/** True when the marker matches the pin and the adapter version and every file is there. */
export function egm_fetched(home: SpinnerHome): boolean {
    const marker = read_egm_marker(home);
    if (marker === null) {
        return false;
    }
    if (marker.sha !== EGM_PIN.sha || marker.adapter_version !== EGM_ADAPTER_VERSION) {
        return false;
    }
    return first_missing(home) === null;
}

/**
 * Clones the pin, checks the runtime files, writes the adapter and then the marker. Throws
 * with the failing command's output or the first missing path; a throw leaves no marker.
 */
export async function fetch_egm(
    home: SpinnerHome,
    log: Log,
    runner: Runner = run,
    timeout_ms: number = EGM_FETCH_TIMEOUT_MS,
): Promise<EgmMarker> {
    assert.ok(timeout_ms > 0, "the fetch needs a positive bound");
    const deadline = Date.now() + timeout_ms;
    mkdirSync(egm_home(home), { recursive: true });
    rmSync(marker_path(home), { force: true });
    const source = egm_source_dir(home);
    rmSync(source, { recursive: true, force: true });
    await clone_at_sha({
        dir: source,
        repo: EGM_PIN.repo,
        sha: EGM_PIN.sha,
        log,
        runner,
        deadline,
        timeout_ms,
        what: "EGM",
    });
    const missing = first_missing(home);
    if (missing !== null) {
        throw new Error(`the EGM checkout misses ${join(source, missing)}`);
    }
    const names = write_adapter(source, egm_adapter_dir(home));
    const marker: EgmMarker = {
        sha: EGM_PIN.sha,
        adapter_version: EGM_ADAPTER_VERSION,
        fetched: new Date().toISOString(),
    };
    writeFileSync(marker_path(home), `${JSON.stringify(marker, null, 4)}\n`);
    log(`fetched EGM ${EGM_PIN.sha.slice(0, 12)} and ${names.length} adapter agents`);
    return marker;
}

/** The daemon's one EGM fetcher: the state for `GET /egm` and a single-flight fetch. */
export class EgmFetcher {
    readonly home: SpinnerHome;
    private readonly env: NodeJS.ProcessEnv;
    private readonly runner: Runner;
    private fetching: Promise<boolean> | null = null;
    private error: string | null = null;

    constructor(home: SpinnerHome, env: NodeJS.ProcessEnv, runner: Runner = run) {
        this.home = home;
        this.env = env;
        this.runner = runner;
    }

    status(): EgmStatus {
        const marker = read_egm_marker(this.home);
        return {
            state: this.state(),
            pinned_sha: EGM_PIN.sha,
            fetched_sha: marker?.sha ?? null,
            fetched_at: marker?.fetched ?? null,
            adapter_version: marker?.adapter_version ?? null,
            error: this.error,
            source: EGM_SOURCE_URL,
            license: EGM_LICENSE,
            notice: EGM_NOTICE,
            subagents: subagents_installed(this.env),
        };
    }

    /**
     * True at once when EGM is fetched. Otherwise one fetch shared by every caller during
     * it; false with the error kept when it throws.
     */
    ensure(log: Log): Promise<boolean> {
        if (egm_fetched(this.home)) {
            return Promise.resolve(true);
        }
        if (this.fetching === null) {
            this.fetching = fetch_egm(this.home, log, this.runner)
                .then(() => {
                    this.error = null;
                    return true;
                })
                .catch((error: unknown) => {
                    this.error = error instanceof Error ? error.message : String(error);
                    return false;
                })
                .finally(() => {
                    this.fetching = null;
                });
        }
        return this.fetching;
    }

    private state(): EgmStatus["state"] {
        if (this.fetching !== null) {
            return "fetching";
        }
        if (egm_fetched(this.home)) {
            return "ready";
        }
        return this.error === null ? "absent" : "failed";
    }
}
