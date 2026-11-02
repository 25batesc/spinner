// The `review` pipeline step (MISSION.md s014, Plan item 10): `POST /sessions/:dir/review`
// starts one job per open PR of the session that runs the operator's `review-blast <pr url>
// --models <a,b,c> --n <n>` script. The script is resolved like `SPINNER_PI`: the
// `SPINNER_REVIEW_BLAST` environment variable, then `settings.review.command`, then
// `review-blast` on PATH. Its stdout and stderr go to the job log line by line, bounded at
// `REVIEW_TIMEOUT_MS`. The route refuses a session without an open PR and a PR whose review
// still runs. After a run the thread poller runs once, so the new review comments show
// without waiting for the next round.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ReviewRequest, SessionSummary, Settings } from "@spinner/protocol";
import { REVIEW_MODELS_DEFAULT, REVIEW_N_DEFAULT } from "@spinner/protocol";

/** The time one `review-blast` run gets before the job fails. */
const REVIEW_TIMEOUT_MS = 20 * 60_000;
import type { Log } from "../stack/runner.js";

/** The environment variable that names the script, before the settings and PATH. */
export const REVIEW_BLAST_ENV = "SPINNER_REVIEW_BLAST";

/** What `review-blast` is called when nothing names it. */
export const REVIEW_BLAST_DEFAULT = "review-blast";

/** Upper bound on bytes kept from one stream's partial last line. */
const LINE_BYTES_MAX = 64 * 1024;

/** The script to run: the environment, then PATH. */
export function resolve_review_blast(env: NodeJS.ProcessEnv, settings: Settings): string {
    assert.ok(settings.theme.length > 0, "settings");
    const from_env = env[REVIEW_BLAST_ENV];
    if (from_env !== undefined && from_env.length > 0) {
        return from_env;
    }
    return REVIEW_BLAST_DEFAULT;
}

export interface ReviewTarget {
    /** Repo key of `session.repos`. */
    key: string;
    number: number;
    url: string;
}

/**
 * The PRs a review runs on: every open or draft PR of the session, or the one `pr` names.
 * Throws when the session has none, or when `pr` names a repo without an open PR.
 */
export function review_targets(summary: SessionSummary, input: ReviewRequest): ReviewTarget[] {
    const open: ReviewTarget[] = [];
    for (const [key, repo] of Object.entries(summary.session.repos)) {
        const pr = repo.pr;
        if (pr === null || pr === undefined) {
            continue;
        }
        if (pr.state !== "open" && pr.state !== "draft") {
            continue;
        }
        open.push({ key, number: pr.number, url: pr.url });
    }
    if (input.pr !== undefined) {
        const one = open.filter((target) => target.key === input.pr);
        if (one.length === 0) {
            throw new Error(`${summary.dir} has no open PR for repo "${input.pr}"`);
        }
        return one;
    }
    if (open.length === 0) {
        throw new Error(`${summary.dir} has no open PR to review`);
    }
    return open;
}

export interface ReviewRunInput {
    bin: string;
    url: string;
    models: readonly string[];
    n: number;
    /** The script's working directory: the session directory. */
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout_ms?: number;
}

/** The arguments `review-blast` gets. */
export function review_args(url: string, models: readonly string[], n: number): string[] {
    assert.ok(url.startsWith("https://"), "a PR URL");
    assert.ok(models.length > 0, "at least one model");
    assert.ok(n >= 1, "at least one review");
    return [url, "--models", models.join(","), "--n", String(n)];
}

/** The models and the count from the settings, else the defaults. */
export function review_settings(settings: Settings): { models: readonly string[]; n: number } {
    return {
        models: settings.review?.models ?? REVIEW_MODELS_DEFAULT,
        n: settings.review?.n ?? REVIEW_N_DEFAULT,
    };
}

/**
 * Runs the script once and streams both outputs to `log`. Resolves on exit 0; throws with
 * the exit code or the signal otherwise, and after `timeout_ms` with the process killed.
 */
export function run_review_blast(input: ReviewRunInput, log: Log): Promise<void> {
    const args = review_args(input.url, input.models, input.n);
    const timeout_ms = input.timeout_ms ?? REVIEW_TIMEOUT_MS;
    log(`$ ${input.bin} ${args.join(" ")}`);
    return new Promise((resolve, reject) => {
        const child = spawn(input.bin, args, {
            cwd: input.cwd,
            env: input.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let timed_out = false;
        const timer = setTimeout(() => {
            timed_out = true;
            child.kill("SIGTERM");
        }, timeout_ms);
        const out = line_sink((line) => log(line));
        const err = line_sink((line) => log(`stderr: ${line}`));
        child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(new Error(`${input.bin}: ${error.message}`));
        });
        child.on("close", (code, signal) => {
            clearTimeout(timer);
            out.flush();
            err.flush();
            if (timed_out) {
                reject(new Error(`${input.bin} ran past ${timeout_ms / 60_000} minutes; killed`));
                return;
            }
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`${input.bin} exited with ${code ?? `signal ${signal ?? "?"}`}`));
        });
    });
}

/** Splits a stream into lines for the log; the partial last line waits for the next chunk. */
function line_sink(emit: (line: string) => void): { push(chunk: Buffer): void; flush(): void } {
    let rest = "";
    return {
        push(chunk) {
            rest += chunk.toString("utf8");
            const parts = rest.split("\n");
            rest = parts.pop() ?? "";
            if (rest.length > LINE_BYTES_MAX) {
                parts.push(rest);
                rest = "";
            }
            for (const part of parts) {
                emit(part);
            }
        },
        flush() {
            if (rest.length > 0) {
                emit(rest);
                rest = "";
            }
        },
    };
}
