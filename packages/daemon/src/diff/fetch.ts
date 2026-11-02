// Fetches the diff viewer's sources on first use: two shallow clones at the pinned commits,
// side by side under `<home>/diffview/src/`, then `npm install` in the viewer. A marker file
// records the pins that were fetched, so a moved pin fetches again and `spinner doctor` can
// say what is there. The whole fetch is bounded by `DIFF_FETCH_TIMEOUT_MS`.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIFF_FETCH_TIMEOUT_MS, DIFF_HOME_DIR } from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";
import { run as run_command, type RunOptions, type RunResult } from "../stack/shell.js";
import { DIFF_PINS, DIFF_VIEWER_BIN, type DiffPin } from "./pins.js";

export type Log = (line: string) => void;

/** The command runner, injectable so a test fetches nothing. */
export type Runner = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;

/** `<home>/diffview`: `DIFFVIEW_HOME` for the viewer and the CLI. */
export function diff_home(home: SpinnerHome): string {
    return join(home.root, DIFF_HOME_DIR);
}

/** `<home>/diffview/src`, the parent of both checkouts. */
export function diff_source_dir(home: SpinnerHome): string {
    return join(diff_home(home), "src");
}

/** The viewer's executable in the fetched checkout. It may not exist yet. */
export function diff_viewer_bin(home: SpinnerHome): string {
    return join(diff_source_dir(home), DIFF_PINS.viewer.dir, DIFF_VIEWER_BIN);
}

/** What the marker file records once a fetch succeeded. */
export interface FetchMarker {
    viewer: string;
    peanut: string;
    /** ISO 8601 time the fetch finished. */
    fetched: string;
}

function marker_path(home: SpinnerHome): string {
    return join(diff_source_dir(home), "fetched.json");
}

/** The marker of the last successful fetch, or null before one. */
export function read_fetch_marker(home: SpinnerHome): FetchMarker | null {
    const path = marker_path(home);
    if (!existsSync(path)) {
        return null;
    }
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
        return null;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record["viewer"] !== "string" || typeof record["peanut"] !== "string") {
        return null;
    }
    return {
        viewer: record["viewer"],
        peanut: record["peanut"],
        fetched: typeof record["fetched"] === "string" ? record["fetched"] : "",
    };
}

/** True when the fetched pins are the current ones and the executable is in place. */
export function diff_fetched(home: SpinnerHome): boolean {
    const marker = read_fetch_marker(home);
    if (marker === null) {
        return false;
    }
    if (marker.viewer !== DIFF_PINS.viewer.sha || marker.peanut !== DIFF_PINS.peanut.sha) {
        return false;
    }
    return existsSync(diff_viewer_bin(home));
}

/**
 * Clones both pins and installs the viewer. Removes a previous checkout first, so a moved
 * pin never leaves a mixed tree. Throws with the failing command's output on any failure.
 */
export async function fetch_diffview(
    home: SpinnerHome,
    log: Log,
    runner: Runner = run_command,
    timeout_ms: number = DIFF_FETCH_TIMEOUT_MS,
): Promise<FetchMarker> {
    assert.ok(timeout_ms > 0, "the fetch needs a positive bound");
    const deadline = Date.now() + timeout_ms;
    const source = diff_source_dir(home);
    mkdirSync(source, { recursive: true });
    rmSync(marker_path(home), { force: true });
    for (const pin of [DIFF_PINS.peanut, DIFF_PINS.viewer]) {
        await clone_pin(source, pin, log, runner, deadline);
    }
    const viewer = join(source, DIFF_PINS.viewer.dir);
    log(`npm install in ${viewer}`);
    await step(runner, "npm", ["install", "--no-audit", "--no-fund"], viewer, deadline);
    log(`check: node ${DIFF_VIEWER_BIN} --help`);
    await step(runner, "node", [DIFF_VIEWER_BIN, "--help"], viewer, deadline);
    const marker: FetchMarker = {
        viewer: DIFF_PINS.viewer.sha,
        peanut: DIFF_PINS.peanut.sha,
        fetched: new Date().toISOString(),
    };
    writeFileSync(marker_path(home), `${JSON.stringify(marker, null, 4)}\n`);
    log(`fetched diffview ${short(marker.viewer)} and peanut ${short(marker.peanut)}`);
    return marker;
}

async function clone_pin(
    source: string,
    pin: DiffPin,
    log: Log,
    runner: Runner,
    deadline: number,
): Promise<void> {
    const dir = join(source, pin.dir);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const url = `https://github.com/${pin.repo}.git`;
    log(`clone ${pin.repo} at ${short(pin.sha)} into ${dir}`);
    // A shallow fetch of one commit: `git clone` cannot take a sha, and the history is not
    // needed to run the viewer.
    await step(runner, "git", ["init", "--quiet"], dir, deadline);
    await step(runner, "git", ["remote", "add", "origin", url], dir, deadline);
    const fetch_args = ["fetch", "--quiet", "--depth", "1", "origin", pin.sha];
    await step(runner, "git", fetch_args, dir, deadline);
    await step(runner, "git", ["checkout", "--quiet", "FETCH_HEAD"], dir, deadline);
}

/** Runs one command inside what is left of the bound; a non-zero exit is an error. */
async function step(
    runner: Runner,
    command: string,
    args: string[],
    cwd: string,
    deadline: number,
): Promise<void> {
    const left = deadline - Date.now();
    if (left <= 0) {
        const minutes = DIFF_FETCH_TIMEOUT_MS / 60_000;
        throw new Error(`the diffview fetch passed its ${minutes} minute bound`);
    }
    const result = await runner(command, args, { cwd, timeout_ms: left });
    if (result.code !== 0) {
        const output = `${String(result.stdout)}\n${result.stderr}`.trim();
        throw new Error(`${command} ${args.join(" ")} exited ${result.code} in ${cwd}:\n${output}`);
    }
}

function short(sha: string): string {
    return sha.slice(0, 12);
}
