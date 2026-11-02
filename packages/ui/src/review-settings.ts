// `settings.review` as the Settings view edits it: the model list, one per line, and the
// count. The daemon validates the whole document on `PUT /settings` (`n` from 1 to 20).
import { REVIEW_MODELS_DEFAULT, REVIEW_N_DEFAULT, type Settings } from "@spinner/protocol";

/** The textarea's text: the configured models, else the defaults, one per line. */
export function reviewModelsText(settings: Settings): string {
    const models = settings.review?.models ?? REVIEW_MODELS_DEFAULT;
    return models.join("\n");
}

export function reviewN(settings: Settings): number {
    return settings.review?.n ?? REVIEW_N_DEFAULT;
}

/** The lines of the textarea as model ids: trimmed, blank lines dropped, duplicates folded. */
export function parseModels(text: string): string[] {
    const models: string[] = [];
    for (const line of text.split("\n")) {
        const model = line.trim();
        if (model !== "" && !models.includes(model)) {
            models.push(model);
        }
    }
    return models;
}

/**
 * The settings with `review.models` and `review.n` set; the other review keys (`command`)
 * stay. An empty list falls back to the defaults by leaving `models` out.
 */
export function withReview(settings: Settings, modelsText: string, n: number): Settings {
    const models = parseModels(modelsText);
    const review: NonNullable<Settings["review"]> = { ...settings.review, n };
    if (models.length === 0) {
        delete review.models;
    } else {
        review.models = models;
    }
    return { ...settings, review };
}
