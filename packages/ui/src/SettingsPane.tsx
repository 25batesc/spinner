// The settings view of the side panel (the gear at the bottom of the activity bar): the
// theme, the default model for new agents, the harness, the review step and, last, About EGM.
// Each change is one `PUT /settings` of the whole document; the daemon answers with the
// `settings` event, which every window follows, so nothing here keeps a draft. Custom themes
// come from `GET /themes`; the invalid ones are listed greyed with their missing keys, and a
// button downloads `dark` as a start.
import { useEffect, useState } from "react";

import {
    BUILTIN_THEMES,
    PALETTE_COLOR_KEYS,
    THEME_SYSTEM,
    type Job,
    type ModelView,
    type Settings,
    type ThemePalette,
    type ThemesResponse,
} from "@spinner/protocol";

import { AboutEgm } from "./AboutEgm.tsx";
import { fetchModels, fetchSettingsPath } from "./events-client.ts";
import { PaneHead, type IconButtonProps } from "./PaneHead.tsx";
import { useLoaded } from "./remote.ts";
import { reviewModelsText, reviewN, withReview } from "./review-settings.ts";
import type { CostFigures } from "./state.ts";
import { paletteFor } from "./theme.ts";
import { UsageSection } from "./UsageSection.tsx";

export interface SettingsPaneProps {
    /** From the app's state: `GET /settings` at load, then the `settings` event. */
    settings: Settings | null;
    themes: ThemesResponse | null;
    onChange: (settings: Settings) => Promise<void>;
    /** The last `costs` event, for the Usage section's figures; null before the first. */
    costs: CostFigures | null;
    /** The app's jobs; About EGM reloads when an `egm` job starts or finishes. */
    jobs: readonly Job[];
    controls?: IconButtonProps[] | undefined;
    leading?: IconButtonProps | undefined;
}

/** Where a custom theme goes; the daemon's `path` names the settings file beside it. */
export const THEMES_DIR_HINT = "~/.spinner/themes/<name>.json";

/** The ten UI colours as a row of swatches, each with the key as its tooltip. */
export function Swatches({ palette }: { palette: ThemePalette }) {
    return (
        <span className="swatches" aria-label="Palette">
            {PALETTE_COLOR_KEYS.map((key) => (
                <span
                    key={key}
                    className="swatch"
                    title={`${key} ${palette[key]}`}
                    style={{ background: palette[key] }}
                />
            ))}
        </span>
    );
}

/** The `dark` built-in as a file, for the operator to edit into a custom theme. */
export function downloadDark(): void {
    const text = JSON.stringify(BUILTIN_THEMES.dark, null, 4);
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "my-theme.json";
    link.click();
    URL.revokeObjectURL(url);
}

/**
 * The `review` step's models (one per line) and count. A textarea needs a draft, so this
 * block saves on its button, not per keystroke; the `settings` event resets the draft.
 */
function ReviewBlock(props: { settings: Settings; onSave: (next: Settings) => void }) {
    const { settings } = props;
    const stored = reviewModelsText(settings);
    const storedN = reviewN(settings);
    const [models, setModels] = useState(stored);
    const [n, setN] = useState(storedN);
    useEffect(() => {
        setModels(stored);
        setN(storedN);
    }, [stored, storedN]);
    const dirty = models !== stored || n !== storedN;
    return (
        <fieldset className="setting review-setting">
            <legend>Review</legend>
            <label className="setting">
                <span>Models, one per line</span>
                <textarea
                    aria-label="Review models"
                    rows={4}
                    value={models}
                    onChange={(event) => setModels(event.target.value)}
                />
            </label>
            <label className="setting">
                <span>Reviews per PR</span>
                <input
                    type="number"
                    aria-label="Reviews per PR"
                    min={1}
                    max={20}
                    value={n}
                    onChange={(event) => setN(Number(event.target.value))}
                />
            </label>
            <p className="muted settings-hint">
                <code>review</code> starts the swarm: one reviewer per model, the first
                <em>n</em> of the list, on each open PR; they post inline comments as you.
            </p>
            <span className="review-actions">
                <button
                    type="button"
                    className="primary"
                    disabled={!dirty}
                    onClick={() => props.onSave(withReview(settings, models, n))}
                >
                    save review settings
                </button>
            </span>
        </fieldset>
    );
}

export function SettingsPane(props: SettingsPaneProps) {
    const { settings, themes, onChange, costs, jobs, controls, leading } = props;
    const [error, setError] = useState<string | null>(null);
    const models: ModelView[] = useLoaded("models", fetchModels).value ?? [];
    const path = useLoaded("settings-path", fetchSettingsPath).value ?? null;
    const change = (next: Settings) => {
        onChange(next).then(
            () => setError(null),
            (failure: unknown) => setError(String(failure)),
        );
    };
    if (settings === null) {
        return (
            <section className="pane sessions-pane settings-pane" aria-label="Settings">
                <PaneHead name="settings" controls={controls} leading={leading} />
                <p className="muted">Loading the settings…</p>
            </section>
        );
    }
    const listed = themes?.themes ?? [];
    const custom = listed.filter((entry) => entry.source === "user");
    const palette =
        paletteFor(settings.theme, listed) ??
        (window.matchMedia("(prefers-color-scheme: light)").matches
            ? BUILTIN_THEMES.light
            : BUILTIN_THEMES.dark);
    return (
        <section className="pane sessions-pane settings-pane" aria-label="Settings">
            <PaneHead name="settings" controls={controls} leading={leading} />
            <form className="settings" onSubmit={(event) => event.preventDefault()}>
                <label className="setting">
                    <span>Theme</span>
                    <select
                        aria-label="Theme"
                        value={settings.theme}
                        onChange={(event) => change({ ...settings, theme: event.target.value })}
                    >
                        <option value={THEME_SYSTEM}>system</option>
                        <option value="light">light</option>
                        <option value="dark">dark</option>
                        <option value="rainbow">rainbow</option>
                        {custom.map((entry) => (
                            <option key={entry.name} value={entry.name}>{entry.name}</option>
                        ))}
                    </select>
                    <Swatches palette={palette} />
                </label>
                {themes !== null && themes.invalid.length > 0 && (
                    <ul className="invalid-themes" aria-label="Invalid themes">
                        {themes.invalid.map((entry) => (
                            <li key={entry.name} className="muted" title={entry.path}>
                                <s>{entry.name}</s>{" "}
                                {entry.missing.length > 0
                                    ? `missing ${entry.missing.join(", ")}`
                                    : entry.reason}
                            </li>
                        ))}
                    </ul>
                )}
                <p className="muted settings-hint">
                    Custom themes live in <code>{THEMES_DIR_HINT}</code>
                    {path !== null && <> (settings: <code>{path}</code>)</>}.{" "}
                    <button type="button" className="link" onClick={downloadDark}>
                        copy dark as a starting point
                    </button>
                </p>
                <UsageSection live={costs} />
                <label className="setting">
                    <span>Default model</span>
                    <select
                        aria-label="Default model"
                        value={settings.default_model ?? ""}
                        onChange={(event) => {
                            const value = event.target.value;
                            const next = { ...settings };
                            if (value === "") {
                                delete next.default_model;
                            } else {
                                next.default_model = value;
                            }
                            change(next);
                        }}
                    >
                        <option value="">pi's default</option>
                        {models.map((m) => (
                            <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                                {m.provider}/{m.id}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="setting">
                    <span>Harness</span>
                    <select
                        aria-label="Harness"
                        value={settings.agents?.harness ?? "tty"}
                        onChange={(event) => {
                            const harness = event.target.value === "rpc" ? "rpc" : "tty";
                            change({ ...settings, agents: { ...settings.agents, harness } });
                        }}
                    >
                        <option value="tty">tty (pi's terminal in the tab)</option>
                        <option value="rpc">rpc (headless chat)</option>
                    </select>
                </label>
                <ReviewBlock settings={settings} onSave={change} />
                {error !== null && <p className="needs-human">{error}</p>}
                <AboutEgm jobs={jobs} />
            </form>
        </section>
    );
}
