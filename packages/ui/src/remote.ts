// Reads and writes the routes that return data rather than a job: mission, threads, the post
// and approve previews, the context files, and the untick of `verify`. The UI keeps what these
// return in component state only until the next event for the session moves a revision counter.
import { useEffect, useState } from "react";

import type {
    AttachmentResponse,
    CommentResponse,
    CommentsResponse,
    NewCommentRequest,
    AgentCommandResponse,
    AgentEventsResponse,
    ApproveResponse,
    ApproveView,
    ContextFileResponse,
    ContextResponse,
    CostGroup,
    CostsResponse,
    DefaultBriefResponse,
    DesignAnswerRequest,
    DesignApproveRefusal,
    DesignApproveRequest,
    DesignApproveResponse,
    DesignChange,
    DesignChangesResponse,
    DesignFilesResponse,
    DesignRunRequest,
    DesignTrack,
    DesignTrackRequest,
    DiffRepoRequest,
    EgmResponse,
    ExtractRequest,
    ExtractResponse,
    InboxMessageRequest,
    InboxMessageResponse,
    MissionSectionRequest,
    MissionView,
    MissionViewResponse,
    PiEvent,
    PostResponse,
    PostView,
    ReviewDraft,
    ReviewDraftResponse,
    ReviewCancelResponse,
    ReviewPostResponse,
    SessionResponse,
    ThreadsView,
} from "@spinner/protocol";

async function failure(method: string, path: string, response: Response): Promise<Error> {
    return new Error(`${method} ${path} failed (${response.status}): ${await response.text()}`);
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(path, signal === undefined ? {} : { signal });
    if (!response.ok) {
        throw await failure("GET", path, response);
    }
    return (await response.json()) as T;
}

async function send<T>(method: "PUT" | "POST", path: string, body: unknown): Promise<T> {
    const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw await failure(method, path, response);
    }
    return (await response.json()) as T;
}

/**
 * The PRs of a paste, resolved against a project. Synchronous on the daemon. The compose box
 * calls it after a pause in the typing and aborts it when the text moves again.
 */
export async function extractPrs(
    body: ExtractRequest,
    signal: AbortSignal,
): Promise<ExtractResponse> {
    const path = "/sessions/extract";
    const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
    });
    if (!response.ok) {
        throw await failure("POST", path, response);
    }
    return (await response.json()) as ExtractResponse;
}

export async function fetchMission(dir: string, signal: AbortSignal): Promise<string> {
    const path = `/sessions/${dir}/mission`;
    const response = await fetch(path, { signal });
    if (!response.ok) {
        throw await failure("GET", path, response);
    }
    return response.text();
}

export async function putMissionSection(dir: string, body: MissionSectionRequest): Promise<void> {
    await send("PUT", `/sessions/${dir}/mission/section`, body);
}

/** The structured mission (s014); `mission.changed` carries the same shape after a write. */
export async function fetchMissionView(dir: string, signal: AbortSignal): Promise<MissionView> {
    const response = await getJson<MissionViewResponse>(`/sessions/${dir}/mission/view`, signal);
    return response.view;
}

/** Writes an `inbox/` message; the daemon delivers it and sends `inbox.message`. */
export async function postInbox(
    dir: string,
    body: InboxMessageRequest,
): Promise<InboxMessageResponse> {
    return send("POST", `/sessions/${dir}/inbox`, body);
}

export async function fetchThreads(dir: string, signal: AbortSignal): Promise<ThreadsView> {
    return (await getJson<{ threads: ThreadsView }>(`/sessions/${dir}/threads`, signal)).threads;
}

export async function refreshThreads(dir: string): Promise<ThreadsView> {
    const path = `/sessions/${dir}/threads/refresh`;
    const body = await send<{ threads: ThreadsView }>("POST", path, {});
    return body.threads;
}

export type ThreadVerb = "reply" | "resolve" | "flag";

export async function threadAction(
    dir: string,
    verb: ThreadVerb,
    thread: string,
    repo: string,
    body: Record<string, string>,
): Promise<void> {
    const id = encodeURIComponent(thread);
    const query = `?pr=${encodeURIComponent(repo)}`;
    await send("POST", `/sessions/${dir}/threads/${id}/${verb}${query}`, body);
}

/** Preview comments (s054), newest first. */
export async function fetchComments(dir: string, signal: AbortSignal): Promise<CommentsResponse> {
    return getJson<CommentsResponse>(`/sessions/${dir}/comments`, signal);
}

/** Saves a PNG (base64, no `data:` prefix) under the session; answers its path. */
export async function postAttachment(dir: string, png: string): Promise<AttachmentResponse> {
    return send("POST", `/sessions/${dir}/attachments`, { mime: "image/png", data: png });
}

export async function postComment(dir: string, body: NewCommentRequest): Promise<CommentResponse> {
    return send("POST", `/sessions/${dir}/comments`, body);
}

/** The operator's reply or resolve on a preview comment. */
export async function commentAction(
    dir: string,
    id: string,
    verb: "reply" | "resolve",
    text?: string,
): Promise<CommentResponse> {
    const body = text === undefined ? {} : { text };
    return send("POST", `/sessions/${dir}/comments/${encodeURIComponent(id)}/${verb}`, body);
}

/** The Slack post of the session's current change, or of change `change`. */
export async function fetchPost(
    dir: string,
    signal: AbortSignal,
    change?: string,
): Promise<PostView> {
    const query = change === undefined ? "" : `?change=${encodeURIComponent(change)}`;
    return (await getJson<PostResponse>(`/sessions/${dir}/post${query}`, signal)).post;
}

export async function fetchApprove(dir: string, signal: AbortSignal): Promise<ApproveView> {
    return (await getJson<ApproveResponse>(`/sessions/${dir}/approve`, signal)).approve;
}

/**
 * Clears the verify tick. Synchronous on the daemon: the cleared view answers, and a
 * `session.updated` follows, which is what moves the checkbox.
 */
export async function deleteVerify(dir: string): Promise<SessionResponse> {
    const path = `/sessions/${dir}/verify`;
    const response = await fetch(path, { method: "DELETE" });
    if (!response.ok) {
        throw await failure("DELETE", path, response);
    }
    return (await response.json()) as SessionResponse;
}

// The review lead's routes (s016, the contract of 14:07). The UI names the paths here only.

/** `GET /sessions/:dir/review/briefing`: `artifacts/briefing.md` as markdown; 404 before. */
export async function fetchReviewBriefing(dir: string, signal: AbortSignal): Promise<string> {
    const path = `/sessions/${dir}/review/briefing`;
    const response = await fetch(path, { signal });
    if (!response.ok) {
        throw await failure("GET", path, response);
    }
    return response.text();
}

/** `PUT /sessions/:dir/review/draft`: the operator's edit; 400 lists every fault. */
export async function putReviewDraft(
    dir: string,
    draft: ReviewDraft,
): Promise<ReviewDraftResponse> {
    return send("PUT", `/sessions/${dir}/review/draft`, draft);
}

/** `DELETE /sessions/:dir/review/draft`: the draft is dropped; the lead may write another. */
export async function deleteReviewDraft(dir: string): Promise<void> {
    const path = `/sessions/${dir}/review/draft`;
    const response = await fetch(path, { method: "DELETE" });
    if (!response.ok) {
        throw await failure("DELETE", path, response);
    }
}

/** `POST /sessions/:dir/review/post`: the draft goes to GitHub as one review; the URL answers. */
export async function postReview(dir: string): Promise<ReviewPostResponse> {
    return send("POST", `/sessions/${dir}/review/post`, {});
}

/** `POST /sessions/:dir/review/approve`: one APPROVE "LGTM" at the PR's head, no swarm. */
export async function postReviewApprove(dir: string): Promise<ReviewPostResponse> {
    return send("POST", `/sessions/${dir}/review/approve`, {});
}

/** `POST /sessions/:dir/review/cancel`: the reviewers and a review's lead stop. */
export async function postReviewCancel(dir: string): Promise<ReviewCancelResponse> {
    return send("POST", `/sessions/${dir}/review/cancel`, {});
}

/**
 * Stops one repo's diff viewer, or every repo's when `repo` is absent. Synchronous on the
 * daemon; the `session.updated` that follows is what empties the page.
 */
export async function postDiffStop(dir: string, repo?: string): Promise<SessionResponse> {
    const body: DiffRepoRequest = repo === undefined ? {} : { repo };
    return send("POST", `/sessions/${dir}/diff/stop`, body);
}

export async function fetchContext(path: string, signal: AbortSignal): Promise<ContextResponse> {
    return getJson<ContextResponse>(`${path}/context`, signal);
}

export async function putContext(
    path: string,
    file: string,
    content: string,
): Promise<ContextFileResponse> {
    return send<ContextFileResponse>("PUT", `${path}/context`, { path: file, content });
}

/** The brief `POST /sessions/:dir/agents` would write for `name` in `repo`, to prefill the form. */
export async function fetchDefaultBrief(
    dir: string,
    name: string,
    repo: string,
    signal: AbortSignal,
): Promise<string> {
    const query = new URLSearchParams();
    if (name !== "") {
        query.set("name", name);
    }
    if (repo !== "") {
        query.set("repo", repo);
    }
    const path = `/sessions/${dir}/agents/default-brief?${query.toString()}`;
    return (await getJson<DefaultBriefResponse>(path, signal)).brief;
}

export interface Loaded<T> {
    value: T | undefined;
    error: string | null;
}

/**
 * Loads `read` again whenever `key` changes, which includes a revision counter. Keeps the last
 * value while a reload runs, so a panel does not blink on every event.
 */
export function useLoaded<T>(
    key: string,
    read: (signal: AbortSignal) => Promise<T>,
): Loaded<T> {
    const [state, setState] = useState<{ key: string; loaded: Loaded<T> }>({
        key,
        loaded: { value: undefined, error: null },
    });
    useEffect(() => {
        const abort = new AbortController();
        read(abort.signal).then(
            (value) => setState({ key, loaded: { value, error: null } }),
            (error: unknown) => {
                if (!abort.signal.aborted) {
                    setState((old) => ({
                        key,
                        loaded: { value: old.loaded.value, error: String(error) },
                    }));
                }
            },
        );
        return () => abort.abort();
        // `read` is a fresh closure on every render; `key` names what it reads.
    }, [key]);
    const sameSession = state.key.split("#")[0] === key.split("#")[0];
    return sameSession ? state.loaded : { value: undefined, error: null };
}

/**
 * `GET /egm`: the fetch state and the pin, for the About EGM block in settings. The fetch
 * itself is `postAction("/egm/fetch")`, a job `egm`.
 */
export async function fetchEgm(signal: AbortSignal): Promise<EgmResponse> {
    return getJson<EgmResponse>("/egm", signal);
}

/**
 * `PUT /sessions/:dir/design/track` (entry 2.35): the track chip's pick. 409 once a repo has
 * commits, and for `design` while EGM is not available; the error text names the reason.
 */
export async function putDesignTrack(dir: string, track: DesignTrack): Promise<SessionResponse> {
    const body: DesignTrackRequest = { track };
    return send("PUT", `/sessions/${dir}/design/track`, body);
}

/**
 * `POST /sessions/:dir/design/run` (entry 3.23): starts an EGM skill in the lead. 400 for a
 * bad body, 409 when the lead is not running; the error text names the reason.
 */
export async function postDesignRun(
    dir: string,
    body: DesignRunRequest,
): Promise<AgentCommandResponse> {
    return send("POST", `/sessions/${dir}/design/run`, body);
}

/**
 * `POST /sessions/:dir/design/answer` (entry 3.23): clears the gate and prompts the lead with
 * the text. The `session.updated` that follows removes the card.
 */
export async function postDesignAnswer(
    dir: string,
    text: string,
): Promise<AgentCommandResponse> {
    const body: DesignAnswerRequest = { text };
    return send("POST", `/sessions/${dir}/design/answer`, body);
}

/**
 * `GET /sessions/:dir/egm/goldfish/:run/:step/events` (entry 4.18): one Goldfish step's
 * transcript events. Null on a 404, which the daemon answers while the step has no transcript
 * file yet or after its run left the newest runs.
 */
export async function fetchGoldfishEvents(
    dir: string,
    run: string,
    step: number,
    signal: AbortSignal,
): Promise<PiEvent[] | null> {
    const path = `/sessions/${dir}/egm/goldfish/${encodeURIComponent(run)}/${step}/events`;
    const response = await fetch(path, { signal });
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw await failure("GET", path, response);
    }
    return ((await response.json()) as AgentEventsResponse).events;
}

// The design workspace's reads (entries 5.12 and 5.14). Each markdown route answers text.

async function getText(path: string, signal: AbortSignal): Promise<string> {
    const response = await fetch(path, { signal });
    if (!response.ok) {
        throw await failure("GET", path, response);
    }
    return response.text();
}

/** `GET /sessions/:dir/design/files`: the files of `<session>/design/` and the archived runs. */
export async function fetchDesignFiles(
    dir: string,
    signal: AbortSignal,
): Promise<DesignFilesResponse> {
    return getJson<DesignFilesResponse>(`/sessions/${dir}/design/files`, signal);
}

/** `GET /sessions/:dir/design/files/:name`: one file of `<session>/design/`. */
export async function fetchDesignFile(
    dir: string,
    name: string,
    signal: AbortSignal,
): Promise<string> {
    return getText(`/sessions/${dir}/design/files/${encodeURIComponent(name)}`, signal);
}

/** `GET /sessions/:dir/design/reviews/:run/:name`: one report of an archived review run. */
export async function fetchReviewFile(
    dir: string,
    run: string,
    name: string,
    signal: AbortSignal,
): Promise<string> {
    const path = `/sessions/${dir}/design/reviews/${encodeURIComponent(run)}/` +
        encodeURIComponent(name);
    return getText(path, signal);
}

/** `GET /sessions/:dir/design/doc`: the design doc from the worktree; 404 before `design.doc`. */
export async function fetchDesignDoc(dir: string, signal: AbortSignal): Promise<string> {
    return getText(`/sessions/${dir}/design/doc`, signal);
}

// Approval (entries 6.1 and 6.18, Technical Plan T10).

/** A 409 of `POST …/design/approve`: the daemon's reason, and the listed blockers or null. */
export class ApproveRefused extends Error {
    readonly blockers: number | null;

    constructor(refusal: DesignApproveRefusal) {
        super(refusal.error);
        this.blockers = refusal.blockers;
    }
}

/**
 * `POST /sessions/:dir/design/approve`: approves the doc, seeds the Plan from its entries
 * (session-workspace.md T4; the counts come back in `seed`) and, with `build`, prompts the
 * lead with the build message. A 409 throws `ApproveRefused`; the dialog asks for the blocker
 * confirmation when its count is above 0, and shows the seed's refusal otherwise.
 */
export async function postDesignApprove(
    dir: string,
    body: DesignApproveRequest,
): Promise<DesignApproveResponse> {
    const path = `/sessions/${dir}/design/approve`;
    const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (response.status === 409) {
        throw new ApproveRefused((await response.json()) as DesignApproveRefusal);
    }
    if (!response.ok) {
        throw await failure("POST", path, response);
    }
    return (await response.json()) as DesignApproveResponse;
}

/** `DELETE /sessions/:dir/design/approve`: removes the approval; the approvals keep it. */
export async function deleteDesignApprove(dir: string): Promise<SessionResponse> {
    const path = `/sessions/${dir}/design/approve`;
    const response = await fetch(path, { method: "DELETE" });
    if (!response.ok) {
        throw await failure("DELETE", path, response);
    }
    return (await response.json()) as SessionResponse;
}

/** `GET /sessions/:dir/design/approved`: the doc as approved; 404 before an approval. */
export async function fetchDesignApproved(dir: string, signal: AbortSignal): Promise<string> {
    return getText(`/sessions/${dir}/design/approved`, signal);
}

/** `GET /sessions/:dir/design/changes`: the `## ` sections changed since the approval. */
export async function fetchDesignChanges(
    dir: string,
    signal: AbortSignal,
): Promise<DesignChange[]> {
    const path = `/sessions/${dir}/design/changes`;
    return (await getJson<DesignChangesResponse>(path, signal)).changes;
}

/** `GET /sessions/:dir/rounds/:round/log`: the Log of an earlier round, as markdown. */
export async function fetchRoundLog(
    dir: string,
    round: number,
    signal: AbortSignal,
): Promise<string> {
    return getText(`/sessions/${dir}/rounds/${round}/log`, signal);
}

/** `GET /costs` over a span of local-zone days, grouped. The Usage section's report. */
export async function fetchCosts(
    from: string,
    to: string,
    group: CostGroup,
    signal: AbortSignal,
): Promise<CostsResponse> {
    const query = new URLSearchParams({ from, to, group });
    return getJson(`/costs?${query.toString()}`, signal);
}
