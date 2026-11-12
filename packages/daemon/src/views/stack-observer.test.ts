// The stack observer survives a failing probe. Method: a docker probe that throws for one
// session and answers for another; a round must finish, report the failure, and still
// observe the healthy session. A throw here once ended the daemon (2026-11-10).
import { describe, expect, it } from "vitest";
import type { SessionSummary, StackSpec } from "@spinner/protocol";
import { SESSION_VERSION } from "@spinner/protocol";
import { start_stack_observer } from "./stack-observer.js";

function summary(id: string): SessionSummary {
    return {
        dir: `${id}-a`,
        path: `/nowhere/${id}-a`,
        session: {
            version: SESSION_VERSION,
            id,
            slug: "a",
            title: "a",
            created: "2026-11-12T00:00:00Z",
            stage: "building",
            needs_human: null,
            branch: "feat/a",
            base: "main",
            repos: {},
            stack: { state: "up", project: `spinner-${id}` },
            agents: {},
        },
    };
}

// One container service, so the observer asks docker for the project's containers.
const SPEC = {
    name: "acme",
    repos: {},
    services: { api: { command: "run", port: 3000 } },
} as unknown as StackSpec;

describe("start_stack_observer", () => {
    it("keeps going when one session's docker probe throws, and reports it", async () => {
        const errors: string[] = [];
        const changed: string[] = [];
        const observer = start_stack_observer(
            {
                sessions: () => [
                    { summary: summary("s1"), spec: SPEC },
                    { summary: summary("s2"), spec: SPEC },
                ],
                on_change: (dir) => changed.push(dir),
                on_error: (dir, error) => errors.push(`${dir}: ${String(error)}`),
                docker: async (project) => {
                    if (project === "spinner-s1") {
                        throw new Error("docker ps failed (143)");
                    }
                    return [];
                },
                answers: async () => true,
            },
            60_000,
        );
        try {
            await observer.round();
            await observer.round();
            expect(errors.some((line) => line.startsWith("s1-a: Error: docker ps failed"))).toBe(
                true,
            );
            expect(changed).toContain("s2-a");
            expect(observer.get("s1-a")).toBeNull();
            expect(observer.get("s2-a")).not.toBeNull();
        } finally {
            observer.stop();
        }
    });
});
