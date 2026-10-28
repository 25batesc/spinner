// `GET /models`: the models pi can run, asked from a short-lived `pi --mode rpc --no-session`
// once per daemon lifetime. pi's answer is `get_available_models` in
// `@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts`; only the four fields the
// picker shows are kept.
import type { ModelView } from "@spinner/protocol";
import { spawn_pi } from "./pi-rpc.js";

/** Upper bound on models listed; pi's catalog is a few hundred entries. */
const MODELS_MAX = 2_000;

export async function fetch_models(pi: string, cwd: string): Promise<ModelView[]> {
    const process_ = await spawn_pi({
        pi,
        cwd,
        session_dir: cwd,
        session_id: "spinner-models",
        extra_args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates"],
    });
    try {
        const response = await process_.send({ type: "get_available_models" });
        return models_of(response.data);
    } finally {
        await process_.stop();
    }
}

/** Pure: pi's `{ models: Model[] }` into `ModelView[]`. Entries without an id are dropped. */
export function models_of(data: unknown): ModelView[] {
    if (typeof data !== "object" || data === null || !("models" in data)) {
        return [];
    }
    const list = (data as { models: unknown }).models;
    if (!Array.isArray(list)) {
        return [];
    }
    const models: ModelView[] = [];
    for (const entry of list.slice(0, MODELS_MAX)) {
        if (typeof entry !== "object" || entry === null) {
            continue;
        }
        const record = entry as Record<string, unknown>;
        if (typeof record["id"] !== "string" || typeof record["provider"] !== "string") {
            continue;
        }
        models.push({
            provider: record["provider"],
            id: record["id"],
            contextWindow: number_or_zero(record["contextWindow"]),
            reasoning: record["reasoning"] === true,
        });
    }
    return models;
}

function number_or_zero(value: unknown): number {
    return typeof value === "number" ? value : 0;
}

/** Caches the list for the daemon's lifetime; a failure is not cached. */
export function models_source(pi: () => string, cwd: string): () => Promise<ModelView[]> {
    let cached: ModelView[] | null = null;
    return async () => {
        if (cached === null) {
            cached = await fetch_models(pi(), cwd);
        }
        return cached;
    };
}
