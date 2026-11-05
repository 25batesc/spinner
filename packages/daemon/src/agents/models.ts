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

/** After a failed fetch, `window_of` asks again only after this long, not on every view. */
export const MODELS_RETRY_MS = 5 * 60_000;

export interface ModelCatalogOptions {
    /** Called once when a fetch succeeded, so the views can show the windows. */
    on_loaded?: () => void;
    log?: (line: string) => void;
    now?: () => number;
}

/**
 * The model list for the daemon's lifetime, with a synchronous context window lookup for the
 * session view (dogfood #45). `window_of` never waits: before the list is loaded it starts
 * one fetch in the background and answers null. A failure is not cached; the next lookup
 * fetches again after `MODELS_RETRY_MS`.
 */
export class ModelCatalog {
    private cached: ModelView[] | null = null;
    private loading: Promise<ModelView[]> | null = null;
    private failed_at: number | null = null;
    private readonly windows = new Map<string, number>();
    private readonly now: () => number;

    constructor(
        private readonly fetch_list: () => Promise<ModelView[]>,
        private readonly options: ModelCatalogOptions = {},
    ) {
        this.now = options.now ?? (() => Date.now());
    }

    /** The list; concurrent callers share one fetch. */
    list(): Promise<ModelView[]> {
        if (this.cached !== null) {
            return Promise.resolve(this.cached);
        }
        this.loading ??= this.fetch_list().then(
            (models) => {
                this.loading = null;
                this.cached = models;
                for (const model of models) {
                    if (model.contextWindow > 0) {
                        this.windows.set(`${model.provider}/${model.id}`, model.contextWindow);
                    }
                }
                this.options.on_loaded?.();
                return models;
            },
            (error: unknown) => {
                this.loading = null;
                this.failed_at = this.now();
                throw error;
            },
        );
        return this.loading;
    }

    /** The window of `provider/id` in tokens, or null while unknown. Never waits. */
    window_of(model: string): number | null {
        if (this.cached !== null) {
            return this.windows.get(model) ?? null;
        }
        const waiting = this.failed_at !== null && this.now() - this.failed_at < MODELS_RETRY_MS;
        if (this.loading === null && !waiting) {
            this.list().catch((error: unknown) => {
                const reason = error instanceof Error ? error.message : String(error);
                this.options.log?.(`models: the list did not load (${reason})`);
            });
        }
        return null;
    }
}

