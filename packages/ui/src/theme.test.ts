import { BUILTIN_THEMES, type ThemeEntry } from "@spinner/protocol";
import { describe, expect, it } from "vitest";

import { paletteFor, schemeOf, terminalVariable } from "./theme.ts";

describe("the theme helpers", () => {
    it("names a terminal variable with dashes", () => {
        expect(terminalVariable("brightBlack")).toBe("--terminal-bright-black");
        expect(terminalVariable("cursor")).toBe("--terminal-cursor");
    });

    it("reads a palette's scheme from its background", () => {
        expect(schemeOf(BUILTIN_THEMES.dark)).toBe("dark");
        expect(schemeOf(BUILTIN_THEMES.light)).toBe("light");
    });

    it("resolves a theme name: system to null, built-ins, a listed custom, else null", () => {
        const custom: ThemeEntry = {
            name: "solar", source: "user", palette: { ...BUILTIN_THEMES.dark, accent: "#e0a63a" },
        };
        expect(paletteFor("system", [custom])).toBeNull();
        expect(paletteFor("light", [])).toBe(BUILTIN_THEMES.light);
        expect(paletteFor("solar", [custom])?.accent).toBe("#e0a63a");
        expect(paletteFor("missing", [custom])).toBeNull();
    });
});
