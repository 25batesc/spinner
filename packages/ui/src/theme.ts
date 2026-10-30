// The theme on the page. `styles.css` paints everything from the `--bg`, `--surface`, …
// variables and the `--terminal-*` block, with the built-in `dark` (or `light` under a light
// OS scheme) as the stylesheet's defaults. `applyPalette` sets the same variables on the root
// element for a chosen palette and `clearPalette` removes them, which is `system`. The
// terminal reads its xterm theme from the variables through `terminalTheme`, and refreshes
// on the `THEME_EVENT` the two functions dispatch, so every terminal follows a change.
import type { ITheme } from "@xterm/xterm";

import {
    BUILTIN_THEMES,
    PALETTE_COLOR_KEYS,
    THEME_BUILTIN_NAMES,
    THEME_SYSTEM,
    type TerminalColorKey,
    type ThemeBuiltinName,
    type ThemeEntry,
    type ThemePalette,
} from "@spinner/protocol";

/** The terminal block, as xterm names the colours; the variables use dashes. */
export const TERMINAL_KEYS = [
    "foreground", "background", "cursor", "black", "red", "green", "yellow", "blue",
    "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow",
    "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

export type TerminalKey = (typeof TERMINAL_KEYS)[number];

/** Dispatched on the window after a palette is applied or cleared. */
export const THEME_EVENT = "spinner-theme";

/** `brightBlack` → `--terminal-bright-black`. */
export function terminalVariable(key: TerminalKey): string {
    return `--terminal-${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
}

/** `brightBlack` → `bright_black`, the key in the palette's JSON. */
function snake(key: TerminalKey): TerminalColorKey {
    return key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`) as TerminalColorKey;
}

/**
 * The palette a `settings.theme` names: a built-in, a custom theme from `GET /themes`, or
 * null for `system` and for a name the list does not have (the stylesheet's defaults then).
 */
export function paletteFor(theme: string, themes: ThemeEntry[]): ThemePalette | null {
    if (theme === THEME_SYSTEM) {
        return null;
    }
    const listed = themes.find((entry) => entry.name === theme);
    if (listed !== undefined) {
        return listed.palette;
    }
    return isBuiltin(theme) ? BUILTIN_THEMES[theme] : null;
}

function isBuiltin(name: string): name is ThemeBuiltinName {
    return (THEME_BUILTIN_NAMES as readonly string[]).includes(name);
}

/**
 * A palette's perceived scheme, for native controls (`color-scheme`): dark when the
 * background's luma is under half.
 */
export function schemeOf(palette: ThemePalette): "light" | "dark" {
    const hex = palette.bg.replace("#", "");
    const wide = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
    const [r, g, b] = [0, 2, 4].map((at) => parseInt(wide.slice(at, at + 2), 16) / 255);
    const luma = 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
    return luma < 0.5 ? "dark" : "light";
}

export function applyPalette(
    palette: ThemePalette,
    root: HTMLElement = document.documentElement,
    name?: string,
): void {
    for (const key of PALETTE_COLOR_KEYS) {
        root.style.setProperty(`--${key}`, palette[key]);
    }
    for (const key of TERMINAL_KEYS) {
        root.style.setProperty(terminalVariable(key), palette.terminal[snake(key)]);
    }
    root.dataset["scheme"] = schemeOf(palette);
    // The stylesheet keys its animations on the theme's name (`rainbow`).
    if (name === undefined) {
        delete root.dataset["theme"];
    } else {
        root.dataset["theme"] = name;
    }
    window.dispatchEvent(new Event(THEME_EVENT));
}

/** Back to the stylesheet's defaults: `system`. */
export function clearPalette(root: HTMLElement = document.documentElement): void {
    for (const key of PALETTE_COLOR_KEYS) {
        root.style.removeProperty(`--${key}`);
    }
    for (const key of TERMINAL_KEYS) {
        root.style.removeProperty(terminalVariable(key));
    }
    delete root.dataset["scheme"];
    delete root.dataset["theme"];
    window.dispatchEvent(new Event(THEME_EVENT));
}

/** The xterm theme from the variables as they compute now. */
export function terminalTheme(root: HTMLElement = document.documentElement): ITheme {
    const style = getComputedStyle(root);
    const theme: Record<string, string> = {};
    for (const key of TERMINAL_KEYS) {
        const value = style.getPropertyValue(terminalVariable(key)).trim();
        if (value !== "") {
            theme[key] = value;
        }
    }
    // xterm parses hex and rgb() only, no `color-mix`: the selection is the blue at 35 %.
    const blue = theme["blue"];
    if (blue !== undefined && /^#[0-9a-f]{6}$/i.test(blue)) {
        theme["selectionBackground"] = `${blue}59`;
    }
    return theme as ITheme;
}
