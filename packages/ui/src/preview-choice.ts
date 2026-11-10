// What the previews pane shows per session: the view tab (`previews` or `diff`), the service
// tab and the diff repo. Kept in localStorage, which the main window and a popped-out pane
// window share, so a pop-out opens on the tab the operator was on and the main window shows
// the pop-out's last tab when it docks back (dogfooding, 2026-11-10).

export const PREVIEW_CHOICE_KEY = "spinner.preview-choice.v1";

/** Sessions kept; the oldest entries past this go, so the record stays small. */
export const PREVIEW_CHOICE_SESSIONS_MAX = 50;

export interface PreviewChoice {
    tab?: string;
    service?: string;
    repo?: string;
}

export interface ChoiceStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

type Record_ = Record<string, PreviewChoice>;

function readAll(storage: ChoiceStorage | undefined): Record_ {
    try {
        const raw = storage?.getItem(PREVIEW_CHOICE_KEY);
        if (raw === null || raw === undefined) {
            return {};
        }
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return {};
        }
        return parsed as Record_;
    } catch {
        return {};
    }
}

/** The choice for `dir`; an empty record when none was saved or the storage is unusable. */
export function loadPreviewChoice(storage: ChoiceStorage | undefined, dir: string): PreviewChoice {
    const choice = readAll(storage)[dir];
    return typeof choice === "object" && choice !== null ? choice : {};
}

/** Merges `patch` into the session's choice and writes it; a storage error is ignored. */
export function savePreviewChoice(
    storage: ChoiceStorage | undefined,
    dir: string,
    patch: PreviewChoice,
): void {
    if (storage === undefined) {
        return;
    }
    const all = readAll(storage);
    const next: Record_ = { ...all, [dir]: { ...(all[dir] ?? {}), ...patch } };
    const dirs = Object.keys(next);
    for (const stale of dirs.slice(0, Math.max(0, dirs.length - PREVIEW_CHOICE_SESSIONS_MAX))) {
        if (stale !== dir) {
            delete next[stale];
        }
    }
    try {
        storage.setItem(PREVIEW_CHOICE_KEY, JSON.stringify(next));
    } catch {
        // A full or forbidden storage: the choice lives for this page only.
    }
}

export function localChoiceStorage(): ChoiceStorage | undefined {
    try {
        return window.localStorage;
    } catch {
        return undefined;
    }
}
