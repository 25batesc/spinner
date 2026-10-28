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

describe("parseEvent for jobs", () => {
    it("accepts a job event with a null session and rejects it for other types", () => {
        const log = { type: "job.log", ts: "t", session: null, job: "j", line: "x" };
        const job = JSON.stringify(log);
        expect(parseEvent(job)?.type).toBe("job.log");
        const closed = JSON.stringify({ type: "session.closed", ts: "t", session: null });
        expect(parseEvent(closed)).toBeNull();
    });
});
