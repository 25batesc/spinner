// The Goldfish of the fixture daemon (docs/designs/egm-adoption.md, entry 4.18, Technical Plan
// T5). The design-review session carries six chips in mixed states over two runs: a
// brainstorm run (done, stopped) and a review run (running, running, failed, queued). One
// step has a transcript, which `GET …/egm/goldfish/:run/:step/events` serves; every other step
// answers 404, as the daemon does for a step without a transcript file. The brainstorm session
// carries `goldfish_live: 12`, so the cap line shows without a chip.
import type { ServerResponse } from "node:http";

import type {
    GoldfishView, PiAssistantMessage, PiEvent, SessionView,
} from "@spinner/protocol";

/** The session whose chips the `goldfish` driver flow reads. */
export const GOLDFISH_DIR = "s205-csv-design-review";
/** The session at the global cap, with no chips of its own. */
export const GOLDFISH_CAP_DIR = "s202-csv-brainstorm";

export const GOLDFISH_ROUTE = /^\/sessions\/([^/]+)\/egm\/goldfish\/([^/]+)\/(\d+)\/events$/;

const BRAINSTORM_RUN = "a1b2c3d4";
const REVIEW_RUN = "e5f6a7b8";
const MODEL = "anthropic/claude-opus-5-5";

function step(
    run: string, index: number, persona: string, partial: Partial<GoldfishView>,
): GoldfishView {
    return {
        run, step: index, agent: `egm-${persona.replaceAll("_", "-")}`, persona,
        state: "done", model: MODEL, tokens: 0, usd: 0, started: null, last_activity: null,
        design_step: run === BRAINSTORM_RUN ? "brainstorm" : "review", transcript: false,
        ...partial,
    };
}

/**
 * Six chips: the sums match the view's `cost_by_stage` (brainstorm $0.42, review $1.20), and
 * the two running steps are the stepper's Review superscript.
 */
export function fixtureGoldfish(): GoldfishView[] {
    const early = "2026-10-20T10:05:00Z";
    const late = "2026-10-20T10:40:00Z";
    return [
        step(BRAINSTORM_RUN, 0, "zoom_out", {
            tokens: 18_200, usd: 0.3, started: early, last_activity: early,
        }),
        step(BRAINSTORM_RUN, 1, "comprehension", {
            state: "stopped", tokens: 6_400, usd: 0.12, started: early, last_activity: early,
        }),
        step(REVIEW_RUN, 0, "critic", {
            state: "running", tokens: 24_600, usd: 0.45, started: late, last_activity: late,
            transcript: true,
        }),
        step(REVIEW_RUN, 1, "design", {
            state: "running", tokens: 9_300, usd: 0.38, started: late, last_activity: late,
        }),
        step(REVIEW_RUN, 2, "security", {
            state: "failed", tokens: 15_000, usd: 0.37, started: late, last_activity: late,
        }),
        step(REVIEW_RUN, 3, "readiness", { state: "queued", model: null }),
    ];
}

/** Seeds the Goldfish facts of the two sessions above; every other view stays as it is. */
export function withGoldfish(view: SessionView): SessionView {
    const dir = view.summary.dir;
    if (view.design === undefined) {
        return view;
    }
    if (dir === GOLDFISH_DIR) {
        const design = { ...view.design, goldfish: fixtureGoldfish(), goldfish_live: 2 };
        return { ...view, design };
    }
    if (dir === GOLDFISH_CAP_DIR) {
        return { ...view, design: { ...view.design, goldfish_live: 12 } };
    }
    return view;
}

const USAGE = {
    input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1500,
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
};

/** The critic's transcript as `message_end` records, the shape the history route answers. */
function criticEvents(): PiEvent[] {
    const user = {
        role: "user" as const, timestamp: 0,
        content: "Review the design doc at docs/designs/csv-export.md as the critic persona.",
    };
    const answer: PiAssistantMessage = {
        role: "assistant",
        content: [
            { type: "text", text: "Reading the doc and the review standard first." },
            { type: "toolCall", id: "g1", name: "read", arguments: { path: "csv-export.md" } },
        ],
        api: "fixture", provider: "fixture", model: MODEL, usage: USAGE,
        stopReason: "toolUse", timestamp: 0,
    };
    const result = {
        role: "toolResult" as const, toolCallId: "g1", toolName: "read",
        content: [{ type: "text" as const, text: "# CSV export" }], isError: false, timestamp: 0,
    };
    const finding: PiAssistantMessage = {
        ...answer, stopReason: "stop",
        content: [{ type: "text", text: "Finding 1: the export has no row limit." }],
    };
    return [
        { type: "message_end", message: user },
        { type: "message_end", message: answer },
        { type: "message_end", message: result },
        { type: "message_end", message: finding },
    ];
}

/**
 * Answers `GET …/egm/goldfish/:run/:step/events`; false when `path` is not that route. A step
 * without a transcript, or one the session does not have, is a 404.
 */
export function handleGoldfish(
    method: string, path: string, goldfish: readonly GoldfishView[] | undefined,
    response: ServerResponse,
): boolean {
    const match = GOLDFISH_ROUTE.exec(path);
    if (method !== "GET" || match === null) {
        return false;
    }
    const [, , run, index] = match;
    const view = goldfish?.find((item) => item.run === run && item.step === Number(index));
    const status = view?.transcript === true ? 200 : 404;
    const body = status === 200 ? { events: criticEvents() } : { error: "no such Goldfish step" };
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
    return true;
}
