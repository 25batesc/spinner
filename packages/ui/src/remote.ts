// Reads and writes the routes that return data rather than a job: mission, threads, the post
// and approve previews, and the context files. The UI keeps what these return in component
// state only until the next event for the session moves a revision counter.
import { useEffect, useState } from "react";

import type {
    ApproveResponse,
    ApproveView,
    ContextFileResponse,
    ContextResponse,
    MissionSectionRequest,
    PostResponse,
    PostView,
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
