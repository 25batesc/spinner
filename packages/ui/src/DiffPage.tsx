// The `diff` view of the right pane: one `diffview` page per repo of the session, with a repo
// switcher over them. The viewers are the daemon's (`SessionView.diff`); the page starts them
// through the `diff` job and shows that job's progress until a repo turns `running`. The
// viewer's URL is embedded directly (a top-level view in the desktop app, a frame in the
// browser) and the frame gets focus on show so the viewer's own keys reach it.
import { preview_key, type Job, type SessionView } from "@spinner/protocol";

import {
    diffAnyRunning,
    diffPreviewService,
    diffProgressLine,
    diffRepoLine,
    diffRepos,
    diffSelected,
} from "./diff-view.ts";
import { Preview } from "./Preview.tsx";
import type { RunAction } from "./SessionForms.tsx";
import { Tabs } from "./Tabs.tsx";

export interface DiffPageProps {
    view: SessionView;
    /** True while any job runs on this session; the start button waits. */
    busy: boolean;
    run: RunAction;
    /** The newest `diff` job of this session, for the progress line. */
    job: Job | undefined;
    /** The repo the operator picked; the pane owns it so a pop-out takes the shown repo. */
    picked: string | undefined;
    onPick: (repo: string) => void;
}

/** The page's words for a repo that is not running: the fetch, the job, then the repo. */
function DiffStatus({ view, job, name }: Pick<DiffPageProps, "view" | "job"> & { name: string }) {
    const diff = view.diff;
    const repo = diff?.repos[name];
    if (diff === undefined || repo === undefined) {
        return null;
    }
    if (job?.state === "running") {
        return <p className="muted diff-progress">{diffProgressLine(job)}</p>;
    }
    if (diff.fetch === "failed") {
        return (
            <p className="needs-human diff-progress">
                fetch failed: {diff.fetch_error ?? "unknown error"}
            </p>
        );
    }
    if (job?.state === "failed") {
        return <p className="needs-human diff-progress">{diffProgressLine(job)}</p>;
    }
    const tone = repo.state === "failed" ? "needs-human" : "muted";
    return <p className={`${tone} diff-progress`}>{diffRepoLine(name, repo)}</p>;
}

export function DiffPage({ view, busy, run, job, picked, onPick }: DiffPageProps) {
    const repos = diffRepos(view);
    const selected = diffSelected(repos, picked);
    const dir = view.summary.dir;
    if (selected === undefined) {
        return <p className="muted">This session has no repos: nothing to diff.</p>;
    }
    const [name, repo] = selected;
    const starting = job?.state === "running";
    // The first start brings every viewer up; once one runs, a stopped repo starts alone.
    const one = diffAnyRunning(repos);
    const start = () => void run(`/sessions/${dir}/diff/start`, one ? { repo: name } : {});
    return (
        <div className="diff-page">
            <Tabs
                labels={repos.map(([label]) => label)}
                selected={name}
                onSelect={onPick}
                grey={repos.filter(([, r]) => r.state !== "running").map(([label]) => label)}
                dots={Object.fromEntries(repos.map(([label, r]) => [label, r.state]))}
            />
            {repo.state === "running" && repo.url !== null ? (
                <Preview
                    key={repo.url}
                    previewKey={preview_key(dir, diffPreviewService(name))}
                    url={repo.url}
                    title={`diff · ${name}`}
                    topLevel={false}
                    focus
                />
            ) : (
                <div className="diff-empty">
                    <DiffStatus view={view} job={job} name={name} />
                    <button
                        type="button"
                        className="primary diff-start"
                        disabled={busy || starting}
                        onClick={start}
                    >
                        {one ? `start diff · ${name}` : "start diff"}
                    </button>
                </div>
            )}
        </div>
    );
}
