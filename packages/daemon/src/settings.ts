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

const SETTINGS_KEYS = ["theme", "default_model", "agents", "operator", "review"];
const AGENTS_KEYS = ["harness"];
const OPERATOR_KEYS = ["enabled", "model"];
const REVIEW_KEYS = ["models", "n", "skill"];

/** Upper bound on `review.n`; more reviews than this is a mistake, not a preference. */
const REVIEW_N_MAX = 20;

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
    const operator = record["operator"];
    if (operator !== undefined) {
        if (typeof operator !== "object" || operator === null || Array.isArray(operator)) {
            return "`operator` must be a mapping";
        }
        const block = operator as Record<string, unknown>;
        for (const key of Object.keys(block)) {
            if (!OPERATOR_KEYS.includes(key)) {
                return `unknown key "operator.${key}" (known: ${OPERATOR_KEYS.join(", ")})`;
            }
        }
        settings.operator = {};
        const enabled = block["enabled"];
        if (enabled !== undefined) {
            if (typeof enabled !== "boolean") {
                return "`operator.enabled` must be a boolean";
            }
            settings.operator.enabled = enabled;
        }
        const model = block["model"];
        if (model !== undefined) {
            if (typeof model !== "string" || model.length === 0) {
                return "`operator.model` must be a non-empty string when given";
            }
            settings.operator.model = model;
        }
    }
    const review = record["review"];
    if (review !== undefined) {
        const checked = validate_review(review);
        if (typeof checked === "string") {
            return checked;
        }
        settings.review = checked;
    }
    return settings;
}

/** `settings.review` (s015): the swarm's models, how many run, and the skill directory. */
function validate_review(review: unknown): NonNullable<Settings["review"]> | string {
    if (typeof review !== "object" || review === null || Array.isArray(review)) {
        return "`review` must be a mapping";
    }
    const block = review as Record<string, unknown>;
    for (const key of Object.keys(block)) {
        if (!REVIEW_KEYS.includes(key)) {
            return `unknown key "review.${key}" (known: ${REVIEW_KEYS.join(", ")})`;
        }
    }
    const out: NonNullable<Settings["review"]> = {};
    const skill = block["skill"];
    if (skill !== undefined) {
        if (typeof skill !== "string" || skill.length === 0) {
            return "`review.skill` must be a non-empty string when given";
        }
        out.skill = skill;
    }
    const models = block["models"];
    if (models !== undefined) {
        const ok =
            Array.isArray(models) &&
            models.length > 0 &&
            models.every((model) => typeof model === "string" && model.length > 0);
        if (!ok) {
            return "`review.models` must be a non-empty list of provider/model ids";
        }
        out.models = models as string[];
    }
    const n = block["n"];
    if (n !== undefined) {
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > REVIEW_N_MAX) {
            return `\`review.n\` must be an integer from 1 to ${REVIEW_N_MAX}`;
        }
        out.n = n;
    }
    return out;
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
