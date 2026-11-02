import { useState } from "react";

import type { ApproveView, PostView } from "@spinner/protocol";

import { fetchApprove, fetchPost, useLoaded } from "./remote.ts";
import type { RunAction } from "./SessionsPane.tsx";

export interface PipelineActionsProps {
    dir: string | undefined;
    busy: boolean;
    /** True when the session has an open PR: what `review` needs. */
    openPr: boolean;
    run: RunAction;
    /** Moves on pipeline events; the confirm dialogs read the daemon's preview again. */
    revision: number;
}

type Confirm = "post" | "approve" | null;

interface DialogProps {
    dir: string;
    revision: number;
    run: RunAction;
    close: () => void;
}

function PostDialog(props: DialogProps) {
    const loaded = useLoaded(`${props.dir}#${props.revision}`, (s) => fetchPost(props.dir, s));
    const post: PostView | undefined = loaded.value;
    const send = () =>
        props.run(`/sessions/${props.dir}/post`, { confirm: true }).then(props.close);
    return (
        <div className="confirm" role="dialog" aria-label="Confirm Slack post">
            <h3>Post to Slack as you?</h3>
            {loaded.error !== null && <p className="needs-human">{loaded.error}</p>}
            {post !== undefined && (
                <>
                    <p className="muted">
                        channel {post.channel ?? "none"} · via {post.transport}
                        {post.reviewer !== null && ` · tags ${post.reviewer}`}
                    </p>
                    <pre className="confirm-text" aria-label="Message">{post.text}</pre>
                    {post.blocked !== null && <p className="needs-human">{post.blocked}</p>}
                    {post.posted !== null && <p className="muted">Already posted: {post.posted}</p>}
                </>
            )}
            <span className="confirm-actions">
                <button
                    className="primary"
                    disabled={post === undefined || post.blocked !== null}
                    onClick={() => void send()}
                >
                    post this message
                </button>
                <button onClick={props.close}>cancel</button>
            </span>
        </div>
    );
}

function ApproveDialog(props: DialogProps) {
    const loaded = useLoaded(`${props.dir}#${props.revision}`, (s) => fetchApprove(props.dir, s));
    const approve: ApproveView | undefined = loaded.value;
    const ready = approve?.prs.some((pr) => pr.blocked === null) === true;
    const send = () =>
        props.run(`/sessions/${props.dir}/approve`, { confirm: true }).then(props.close);
    return (
        <div className="confirm" role="dialog" aria-label="Confirm approval">
            <h3>Approve as you?</h3>
            {loaded.error !== null && <p className="needs-human">{loaded.error}</p>}
            <ul className="approve-list">
                {approve?.prs.map((pr) => (
                    <li key={`${pr.repo}#${pr.number}`}>
                        <strong>{pr.repo}#{pr.number}</strong> {pr.title}
                        <div className="muted">
                            head {pr.head.slice(0, 7)} · {pr.diff.files} files{" "}
                            +{pr.diff.additions} −{pr.diff.deletions} · {pr.open_threads} open
                            threads
                            {pr.approved && " · already approved"}
                        </div>
                        {pr.blocked !== null && <div className="needs-human">{pr.blocked}</div>}
                    </li>
                ))}
            </ul>
            <span className="confirm-actions">
                <button className="primary" disabled={!ready} onClick={() => void send()}>
                    approve
                </button>
                <button onClick={props.close}>cancel</button>
            </span>
        </div>
    );
}

/** One sentence per button, as its tooltip. */
export const PIPELINE_TIPS = {
    pr: "Open a pull request from this session's branch, one per changed repo.",
    review: "Start the review swarm: one reviewer per model on the PR; they post as you.",
    fix: "Have the fixer answer the open review threads.",
    post: "Post the review request to Slack as you, after a preview.",
    approve: "Approve the pull request as you, after a preview.",
    land: "Enqueue the PR in the merge queue and watch it to the merge.",
} as const;

/**
 * The pipeline group of the toolbar: `post` and `approve` open a dialog that shows what they
 * will send; `land` is the irreversible one and looks it.
 */
export function PipelineActions({ dir, busy, openPr, run, revision }: PipelineActionsProps) {
    const [confirm, setConfirm] = useState<Confirm>(null);
    const off = dir === undefined || busy;
    const job = (action: string) => () => void run(`/sessions/${dir}/${action}`);
    const close = () => setConfirm(null);
    return (
        <>
            <button disabled={off} title={PIPELINE_TIPS.pr} onClick={job("pr")}>create PR</button>
            <button disabled={off || !openPr} title={PIPELINE_TIPS.review} onClick={job("review")}>
                review
            </button>
            <button disabled={off} title={PIPELINE_TIPS.fix} onClick={job("fix")}>fix</button>
            <button disabled={off} title={PIPELINE_TIPS.post} onClick={() => setConfirm("post")}>
                post
            </button>
            <button
                disabled={off}
                title={PIPELINE_TIPS.approve}
                onClick={() => setConfirm("approve")}
            >
                approve
            </button>
            <button
                className="danger"
                disabled={off}
                title={PIPELINE_TIPS.land}
                onClick={job("land")}
            >
                land
            </button>
            {dir !== undefined && confirm === "post" && (
                <PostDialog dir={dir} revision={revision} run={run} close={close} />
            )}
            {dir !== undefined && confirm === "approve" && (
                <ApproveDialog dir={dir} revision={revision} run={run} close={close} />
            )}
        </>
    );
}
