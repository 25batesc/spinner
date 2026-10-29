// The main window's size and place from `SPINNER_DESKTOP_WINDOW`, so a test app can sit on a
// corner of another display while the operator's app keeps the main one.
import assert from "node:assert/strict";

/**
 * `SPINNER_DESKTOP_WINDOW=WxH+X+Y` places the main window, so a test app can sit beside a
 * real one; X and Y may be negative (a display left of or above the main one).
 */
export function window_geometry(spec: string | undefined): {
    width: number;
    height: number;
    x?: number;
    y?: number;
} {
    const match = spec === undefined ? null : /^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/.exec(spec);
    if (match === null) {
        assert.ok(spec === undefined, `SPINNER_DESKTOP_WINDOW must be WxH+X+Y, got ${spec}`);
        return { width: 1440, height: 900 };
    }
    return {
        width: Number(match[1]),
        height: Number(match[2]),
        x: Number(match[3]),
        y: Number(match[4]),
    };
}
