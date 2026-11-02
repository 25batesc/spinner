// What the diff page shows, as pure functions of `SessionView.diff` and the `diff` job: the
// repos in `session.yaml` order, which one the page shows, the words for a repo that is not
// running, and the job's progress line. The page itself is `DiffPage.tsx`.
import type { DiffRepoView, Job, SessionView } from "@spinner/protocol";

import type { UiState } from "./state.ts";

/** The repos with a viewer entry, in the daemon's order. Empty from a daemon before s012. */
export function diffRepos(view: SessionView | undefined): [string, DiffRepoView][] {
    return Object.entries(view?.diff?.repos ?? {});
}

/** The repo the page shows: the picked one if it still exists, else the first. */
export function diffSelected(
    repos: [string, DiffRepoView][],
    picked: string | undefined,
): [string, DiffRepoView] | undefined {
    const found = repos.find(([name]) => name === picked);
    return found ?? repos[0];
}

/** True while any repo's viewer runs: the page then starts one repo at a time. */
export function diffAnyRunning(repos: [string, DiffRepoView][]): boolean {
    return repos.some(([, repo]) => repo.state === "running");
}

/** The newest `diff` job of a session, running or finished; its log is the progress. */
export function diffJob(state: UiState, dir: string): Job | undefined {
    const jobs = Object.values(state.jobs).filter(
        (job) => job.session === dir && job.action === "diff",
    );
    return jobs.sort((a, b) => b.started.localeCompare(a.started))[0];
}

/** `diff · running · cloning diff-viewer`: the job's state and its last log line. */
export function diffProgressLine(job: Job): string {
    const last = job.log.at(-1);
    const tail = job.state === "failed" && job.error !== null ? job.error : last;
    return tail === undefined ? `diff · ${job.state}` : `diff · ${job.state} · ${tail}`;
}

/** The sentence for a repo whose viewer is not running. */
export function diffRepoLine(name: string, repo: DiffRepoView): string {
    if (repo.state === "failed") {
        return `${name} failed: ${repo.error ?? "unknown error"}`;
    }
    return `${name} is ${repo.state}.`;
}

/** The key the desktop keeps one view under; `diff/` keeps it apart from a service's key. */
export function diffPreviewService(name: string): string {
    return `diff/${name}`;
}
