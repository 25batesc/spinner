// The confirm dialogs of the PR view's `post` and `approve` (ChangesRail.tsx), which show
// what they will send, and one sentence per pipeline action as its tooltip.
import type { ApproveView, PostView } from "@spinner/protocol";

import { fetchApprove, fetchPost, useLoaded } from "./remote.ts";
import type { RunAction } from "./SessionsPane.tsx";

interface DialogProps {
    dir: string;
    /** Id of the change to act on (the PR view); the current change when absent. */
    change?: string;
    revision: number;
    run: RunAction;
    close: () => void;
}

export function PostDialog(props: DialogProps) {
    const query = props.change === undefined ? "" : `?change=${encodeURIComponent(props.change)}`;
    const key = `${props.dir}#${props.change ?? ""}#${props.revision}`;
    const loaded = useLoaded(key, (s) => fetchPost(props.dir, s, props.change));
    const post: PostView | undefined = loaded.value;
    const send = () =>
        props.run(`/sessions/${props.dir}/post${query}`, { confirm: true }).then(props.close);
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

export function ApproveDialog(props: DialogProps) {
    const query = props.change === undefined ? "" : `?change=${encodeURIComponent(props.change)}`;
    const key = `${props.dir}#${props.change ?? ""}#${props.revision}`;
    const loaded = useLoaded(key, (s) => fetchApprove(props.dir, s, props.change));
    const approve: ApproveView | undefined = loaded.value;
    const ready = approve?.prs.some((pr) => pr.blocked === null) === true;
    const send = () =>
        props.run(`/sessions/${props.dir}/approve${query}`, { confirm: true }).then(props.close);
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
    pr: "Open a pull request from this change, one per changed repo.",
    review: "Start the review swarm: one reviewer per model on the PR; they post as you.",
    fix: "Have the fixer answer the open review threads.",
    post: "Post the review request to Slack as you, after a preview.",
    approve: "Approve the pull request as you, after a preview.",
    land: "Enqueue the PR in the merge queue and watch it to the merge.",
} as const;
