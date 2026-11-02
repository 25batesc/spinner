// Themes and operator settings (s011, Contracts "settings and themes"). A theme is one
// `ThemePalette`: the ten UI colours and a terminal block with the 16 ANSI colours,
// foreground, background and cursor, so the web UI and the desktop app share one
// definition. The built-ins `light` and `dark` are the JSON files under `themes/`; the
// operator adds `~/.spinner/themes/<name>.json`. `validate_palette` is the one check both
// the daemon (`GET /themes`) and a UI preview run; a file with missing keys is reported with
// the keys and not listed. `Settings` is `~/.spinner/settings.yaml`, the operator's
// preferences, distinct from the daemon's `config.yaml`.
import dark from "./themes/dark.json" with { type: "json" };
import light from "./themes/light.json" with { type: "json" };
import rainbow from "./themes/rainbow.json" with { type: "json" };

/** The 16 ANSI colours as xterm.js names them, plus the three the terminal needs. */
export const TERMINAL_COLOR_KEYS = [
    "foreground",
    "background",
    "cursor",
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "bright_black",
    "bright_red",
    "bright_green",
    "bright_yellow",
    "bright_blue",
    "bright_magenta",
    "bright_cyan",
    "bright_white",
] as const;

export type TerminalColorKey = (typeof TERMINAL_COLOR_KEYS)[number];

/** The UI colours; every value is a CSS colour, `#rrggbb` in the built-ins. */
export const PALETTE_COLOR_KEYS = [
    "bg",
    "surface",
    "border",
    "text",
    "muted",
    "accent",
    "ok",
    "warn",
    "fail",
    "link",
] as const;

export type PaletteColorKey = (typeof PALETTE_COLOR_KEYS)[number];

export type TerminalPalette = Record<TerminalColorKey, string>;

export type ThemePalette = Record<PaletteColorKey, string> & { terminal: TerminalPalette };

/** The names `settings.theme` takes besides a custom theme's file name. */
export const THEME_BUILTIN_NAMES = ["light", "dark", "rainbow"] as const;
export type ThemeBuiltinName = (typeof THEME_BUILTIN_NAMES)[number];

/** `system` follows the OS; the UI picks `light` or `dark` from `prefers-color-scheme`. */
export const THEME_SYSTEM = "system";

export const BUILTIN_THEMES: Record<ThemeBuiltinName, ThemePalette> = {
    light: light as ThemePalette,
    dark: dark as ThemePalette,
    /** The silly one: the palette is static; the UI animates its accent and its titles. */
    rainbow: rainbow as ThemePalette,
};

/** A custom theme's name is its file name without `.json`. */
export const THEME_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type PaletteCheck =
    | { ok: true; palette: ThemePalette }
    | { ok: false; missing: string[]; reason: string };

/**
 * Checks a parsed JSON value against `ThemePalette`. `missing` lists every key that is
 * absent or not a non-empty string, as `terminal.red` for the terminal block. Unknown keys
 * pass; a theme may carry extra colours a later UI uses.
 */
export function validate_palette(input: unknown): PaletteCheck {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return { ok: false, missing: [...PALETTE_COLOR_KEYS, "terminal"], reason: "not an object" };
    }
    const record = input as Record<string, unknown>;
    const missing: string[] = [];
    for (const key of PALETTE_COLOR_KEYS) {
        if (!is_color(record[key])) {
            missing.push(key);
        }
    }
    const terminal = record["terminal"];
    if (typeof terminal !== "object" || terminal === null || Array.isArray(terminal)) {
        missing.push("terminal");
    } else {
        const block = terminal as Record<string, unknown>;
        for (const key of TERMINAL_COLOR_KEYS) {
            if (!is_color(block[key])) {
                missing.push(`terminal.${key}`);
            }
        }
    }
    if (missing.length > 0) {
        return { ok: false, missing, reason: `missing ${missing.join(", ")}` };
    }
    return { ok: true, palette: input as ThemePalette };
}

function is_color(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

/** One theme `GET /themes` lists. */
export interface ThemeEntry {
    name: string;
    source: "builtin" | "user";
    palette: ThemePalette;
}

/** A `~/.spinner/themes/<name>.json` that did not validate; not listed under `themes`. */
export interface InvalidTheme {
    name: string;
    path: string;
    /** Keys absent or not a colour string; empty when the file did not parse. */
    missing: string[];
    reason: string;
}

/** `GET /themes`. */
export interface ThemesResponse {
    themes: ThemeEntry[];
    invalid: InvalidTheme[];
}

/**
 * `~/.spinner/settings.yaml`: the operator's preferences, which the UI and the desktop read.
 * The daemon's own configuration (`pi_bin`, `port`, Slack) stays in `config.yaml`.
 */
export interface Settings {
    /** `system`, `light`, `dark`, or the name of a `~/.spinner/themes/<name>.json`. */
    theme: string;
    /** `provider/model` for an agent tab that names none. */
    default_model?: string;
    agents?: {
        harness?: "tty" | "rpc";
    };
    /**
     * The `review` pipeline step (s014, Plan item 10): the operator's `review-blast` script.
     * Absent means the script on PATH, `REVIEW_MODELS_DEFAULT` and `REVIEW_N_DEFAULT`.
     */
    review?: {
        /** The script to run; else `SPINNER_REVIEW_BLAST`, else `review-blast` on PATH. */
        command?: string;
        /** `--models`, as `provider/model` ids. */
        models?: string[];
        /** `--n`: reviews per PR. */
        n?: number;
    };
    /** The operator agent (MISSION.md s013). Absent means off since s014, the default model. */
    operator?: {
        /** The daemon starts the operator agent at boot. Default false (s014). */
        enabled?: boolean;
        /** `provider/model`; else `default_model`, else the daemon's default. */
        model?: string;
    };
}

export const SETTINGS_DEFAULT: Settings = { theme: THEME_SYSTEM };

/** `GET /settings` and `PUT /settings` (the body is the whole document). */
export interface SettingsResponse {
    settings: Settings;
    /** `~/.spinner/settings.yaml`, whether or not it exists yet. */
    path: string;
}
