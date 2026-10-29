// Goal: the geometry variable places the window, negative offsets included (a display above
// the main one has negative Y), and a malformed value is an error rather than a window over
// the operator's. Method: parse a few values.
import { describe, expect, it } from "vitest";
import { window_geometry } from "./window-geometry.js";

describe("window_geometry", () => {
    it("defaults without the variable", () => {
        expect(window_geometry(undefined)).toEqual({ width: 1440, height: 900 });
    });

    it("parses a size and a place, negative offsets included", () => {
        expect(window_geometry("1000x700+3250+-280")).toEqual({
            width: 1000,
            height: 700,
            x: 3250,
            y: -280,
        });
        expect(window_geometry("800x600+0+0")).toEqual({ width: 800, height: 600, x: 0, y: 0 });
    });

    it("rejects a malformed value", () => {
        expect(() => window_geometry("1000x700")).toThrow(/WxH\+X\+Y/);
        expect(() => window_geometry("big")).toThrow(/WxH\+X\+Y/);
    });
});
