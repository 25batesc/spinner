import { describe, expect, it } from "vitest";

import { sizeOf } from "./ContextTab.tsx";

describe("sizeOf", () => {
    it("counts lines without the trailing newline and bytes as UTF-8", () => {
        expect(sizeOf("a\nb\n", true)).toBe("2 lines · 4 B");
        expect(sizeOf("a\nb", true)).toBe("2 lines · 3 B");
        expect(sizeOf("", true)).toBe("0 lines · 0 B");
        expect(sizeOf("é", true)).toBe("1 line · 2 B");
    });

    it("names a file that does not exist yet", () => {
        expect(sizeOf("", false)).toBe("no file yet");
    });
});
