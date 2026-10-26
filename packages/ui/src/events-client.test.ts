import { describe, expect, it } from "vitest";

import { parseEvent } from "./events-client.ts";

describe("parseEvent", () => {
    it("accepts an event with a known type", () => {
        const raw = JSON.stringify({ type: "session.closed", ts: "t", session: "s1-a" });
        expect(parseEvent(raw)?.type).toBe("session.closed");
    });

    it("rejects bad JSON, unknown types and a missing session", () => {
        expect(parseEvent("{")).toBeNull();
        expect(parseEvent(JSON.stringify({ type: "nope", ts: "t", session: "s" }))).toBeNull();
        expect(parseEvent(JSON.stringify({ type: "session.closed", ts: "t" }))).toBeNull();
        expect(parseEvent("null")).toBeNull();
    });
});
