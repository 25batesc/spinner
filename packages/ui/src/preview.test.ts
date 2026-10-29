// `previewRect` turns the box's DOM rectangle into the integer, window-relative rectangle the
// desktop bridge receives. The checks: rounding, the clamp of a collapsed box to zero, and the
// `left`/`top` to `x`/`y` naming.
import { describe, expect, it } from "vitest";

import { previewRect } from "./Preview.tsx";

describe("previewRect", () => {
    it("rounds a fractional DOM rectangle to integer CSS pixels", () => {
        const rect = previewRect({ left: 980.4, top: 41.6, width: 519.5, height: 843.49 });
        expect(rect).toEqual({ x: 980, y: 42, width: 520, height: 843 });
    });

    it("clamps a collapsed box to a zero size instead of a negative one", () => {
        const rect = previewRect({ left: 0, top: 0, width: -0.4, height: 0 });
        expect(rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    });
});
