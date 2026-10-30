// The operator's settings (`<home>/settings.yaml`) and themes (`<home>/themes/<name>.json`),
// behind `GET|PUT /settings` and `GET /themes` (MISSION.md s011, Contracts "settings and
// themes"). Settings are the operator's preferences, which the UI edits; `config.yaml`
// (`config.ts`) stays the daemon's own configuration. A `PUT` replaces the whole document
// after validation, so the file never holds a key the UI did not write. Themes are read on
// every `GET`, so a file the operator drops in shows on the next request; one with missing
// keys is reported with the keys and not listed.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type {
    InvalidTheme,
    Settings,
    SettingsResponse,
    ThemeEntry,
    ThemesResponse,
} from "@spinner/protocol";
import {
    BUILTIN_THEMES,
    SETTINGS_DEFAULT,
    THEME_BUILTIN_NAMES,
    THEME_NAME_PATTERN,
    THEME_SYSTEM,
    validate_palette,
} from "@spinner/protocol";
import type { SpinnerHome } from "./home.js";

/** Upper bound on theme files one `GET /themes` reads. */
const THEMES_MAX = 200;

/** Upper bound on one theme file; a palette is a few hundred bytes. */
const THEME_FILE_BYTES_MAX = 256 * 1024;

const SETTINGS_KEYS = ["theme", "default_model", "agents"];
const AGENTS_KEYS = ["harness"];

export function settings_path(home: SpinnerHome): string {
    return join(home.root, "settings.yaml");
}

export function themes_dir(home: SpinnerHome): string {
    return join(home.root, "themes");
}

/**
 * The settings on disk, or the defaults when the file is absent. A file that does not parse
 * or does not validate is reported as an error, so the UI shows the problem rather than
 * silently falling back.
 */
export function read_settings(home: SpinnerHome): SettingsResponse {
    const path = settings_path(home);
    if (!existsSync(path)) {
        return { settings: { ...SETTINGS_DEFAULT }, path };
    }
    const raw: unknown = parse(readFileSync(path, "utf8"));
    const checked = validate_settings(raw ?? {}, home);
    if (typeof checked === "string") {
        throw new Error(`${path}: ${checked}`);
    }
    return { settings: checked, path };
}

/** Validates and writes the whole document. Returns the reason as a string when invalid. */
export function write_settings(home: SpinnerHome, input: unknown): SettingsResponse | string {
    const checked = validate_settings(input, home);
    if (typeof checked === "string") {
        return checked;
    }
    const path = settings_path(home);
    mkdirSync(home.root, { recursive: true });
    writeFileSync(path, stringify(checked));
    return { settings: checked, path };
}

/**
 * Pure apart from the theme lookup: the document to `Settings`, or the first problem as a
 * string. Unknown keys are refused, so a typo does not sit in the file doing nothing.
 */
export function validate_settings(input: unknown, home: SpinnerHome): Settings | string {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return "settings must be a mapping";
    }
    const record = input as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        if (!SETTINGS_KEYS.includes(key)) {
            return `unknown key "${key}" (known: ${SETTINGS_KEYS.join(", ")})`;
        }
    }
    const theme = record["theme"] ?? THEME_SYSTEM;
    if (typeof theme !== "string" || theme.length === 0) {
        return "`theme` must be a non-empty string";
    }
    if (!theme_exists(home, theme)) {
        return `unknown theme "${theme}"; GET /themes lists the valid ones`;
    }
    const settings: Settings = { theme };
    const default_model = record["default_model"];
    if (default_model !== undefined) {
        if (typeof default_model !== "string" || default_model.length === 0) {
            return "`default_model` must be a non-empty string when given";
        }
        settings.default_model = default_model;
    }
    const agents = record["agents"];
    if (agents !== undefined) {
        if (typeof agents !== "object" || agents === null || Array.isArray(agents)) {
            return "`agents` must be a mapping";
        }
        const block = agents as Record<string, unknown>;
        for (const key of Object.keys(block)) {
            if (!AGENTS_KEYS.includes(key)) {
                return `unknown key "agents.${key}" (known: ${AGENTS_KEYS.join(", ")})`;
            }
        }
        const harness = block["harness"];
        settings.agents = {};
        if (harness !== undefined) {
            if (harness !== "tty" && harness !== "rpc") {
                return "`agents.harness` must be one of tty, rpc";
            }
            settings.agents.harness = harness;
        }
    }
    return settings;
}

/** `system`, a built-in, or a user file that validates. */
function theme_exists(home: SpinnerHome, name: string): boolean {
    if (name === THEME_SYSTEM || (THEME_BUILTIN_NAMES as readonly string[]).includes(name)) {
        return true;
    }
    return list_themes(home).themes.some((entry) => entry.name === name);
}

/** The built-ins, then every `<home>/themes/*.json` by name; the invalid ones named. */
export function list_themes(home: SpinnerHome): ThemesResponse {
    const themes: ThemeEntry[] = THEME_BUILTIN_NAMES.map((name) => ({
        name,
        source: "builtin",
        palette: BUILTIN_THEMES[name],
    }));
    const invalid: InvalidTheme[] = [];
    const dir = themes_dir(home);
    if (!existsSync(dir)) {
        return { themes, invalid };
    }
    const files = readdirSync(dir)
        .filter((entry) => entry.endsWith(".json"))
        .sort();
    assert.ok(files.length <= THEMES_MAX, `more than ${THEMES_MAX} theme files in ${dir}`);
    for (const file of files) {
        const name = file.slice(0, -".json".length);
        const path = join(dir, file);
        const problem = user_theme(name, path);
        if ("palette" in problem) {
            themes.push({ name, source: "user", palette: problem.palette });
        } else {
            invalid.push(problem);
        }
    }
    return { themes, invalid };
}

function user_theme(
    name: string,
    path: string,
): { palette: ThemeEntry["palette"] } | InvalidTheme {
    if ((THEME_BUILTIN_NAMES as readonly string[]).includes(name)) {
        return { name, path, missing: [], reason: "shadows a built-in theme" };
    }
    if (!THEME_NAME_PATTERN.test(name)) {
        return { name, path, missing: [], reason: "name must match [a-z0-9][a-z0-9_-]{0,63}" };
    }
    const text = readFileSync(path, "utf8");
    if (text.length > THEME_FILE_BYTES_MAX) {
        return { name, path, missing: [], reason: `larger than ${THEME_FILE_BYTES_MAX} bytes` };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { name, path, missing: [], reason: `not JSON: ${reason}` };
    }
    const check = validate_palette(parsed);
    if (!check.ok) {
        return { name, path, missing: check.missing, reason: check.reason };
    }
    return { palette: check.palette };
}
