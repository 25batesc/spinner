// Reads and writes the routes that return data rather than a job: mission, threads, the post
// and approve previews, the context files, and the untick of `verify`. The UI keeps what these
// return in component state only until the next event for the session moves a revision counter.
import { useEffect, useState } from "react";

import type {
    ApproveResponse,
    ApproveView,
    ContextFileResponse,
    ContextResponse,
    CostGroup,
    CostsResponse,
    DefaultBriefResponse,
    DiffRepoRequest,
    MissionSectionRequest,
    PostResponse,
    PostView,
    SessionResponse,
    ThreadsView,
} from "@spinner/protocol";

import type { ExtractRequest, ExtractResponse } from "./compose.ts";

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

export async function fetchPost(dir: string, signal: AbortSignal): Promise<PostView> {
    return (await getJson<PostResponse>(`/sessions/${dir}/post`, signal)).post;
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
