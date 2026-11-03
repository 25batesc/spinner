// The outcome counters (docs/designs/egm-adoption.md, entries 6.19 to 6.22): the fixer rounds
// and the operator's steers to the lead, counted per session across rounds, so `spinner
// outcomes` can compare the design track with the direct track. The `fix` route counts a
// round when its job starts; the steer route in `server.ts` counts a steer only when
// `counts_as_operator_steer` holds, because the lead's and the operator agent's
// `agent_steer` tools post to the same route without a `source`.
import assert from "node:assert/strict";
import type {
    AgentMessageRequest,
    OutcomeCounts,
    Session,
    SessionSummary,
} from "@spinner/protocol";
import { LEAD_NAME } from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";
import { read_session, write_session } from "../store/session-store.js";

export type OutcomeCounter = keyof OutcomeCounts;

/** Pure: the session with `counter` one higher; `outcomes` starts at zeros when absent. */
export function with_outcome(session: Session, counter: OutcomeCounter): Session {
    const before: OutcomeCounts = session.outcomes ?? { fix_rounds: 0, operator_steers: 0 };
    assert.ok(Number.isInteger(before[counter]), `outcomes.${counter} must be an integer`);
    assert.ok(before[counter] >= 0, `outcomes.${counter} must not be negative`);
    return { ...session, outcomes: { ...before, [counter]: before[counter] + 1 } };
}

/**
 * Re-reads the session, writes it back with `counter` one higher, and returns the written
 * summary. Re-reading keeps the counter from overwriting a field another writer changed
 * since the caller's read. A caller that writes the session later must continue from the
 * returned summary, or its write drops the count.
 */
export function count_outcome(
    home: SpinnerHome,
    dir: string,
    counter: OutcomeCounter,
): SessionSummary {
    const read = read_session(home, dir);
    if (!read.ok) {
        throw new Error(`cannot count ${counter} for ${dir}: ${read.error}`);
    }
    const counted = { ...read.summary, session: with_outcome(read.summary.session, counter) };
    write_session(counted);
    return counted;
}

/**
 * True only for a steer to the lead that the Spinner UI's message box sent (6.20, review
 * v2 M-5). A prompt, a steer to a worker, and a steer without `source` are not counted.
 */
export function counts_as_operator_steer(
    command: "prompt" | "steer",
    name: string,
    request: AgentMessageRequest,
): boolean {
    if (command !== "steer") {
        return false;
    }
    if (name !== LEAD_NAME) {
        return false;
    }
    return request.source === "operator";
}
