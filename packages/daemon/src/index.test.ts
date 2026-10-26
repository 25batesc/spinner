import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./index.js";

describe("daemon", () => {
    it("re-exports the protocol version", () => {
        expect(PROTOCOL_VERSION).toBe(1);
    });
});
