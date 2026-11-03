// The open EGM gate of a session (docs/designs/egm-adoption.md, Technical Plan T8, entry
// 3.7). The lead's `ask_question` tool writes `design.gate`; an answer from the UI, a skill
// run, a prompt or steer to the lead, or the lead's next `agent_start` clears it. One slot
// per session: a new gate replaces the old one. Each write re-reads `session.yaml` right
// before it writes, as the pipeline writers do.
import type { DesignGateRequest } from "@spinner/protocol";
import {
    DESIGN_GATE_OPTION_MAX,
    DESIGN_GATE_OPTIONS_MAX,
    DESIGN_GATE_QUESTION_MAX,
} from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";
import { read_session, write_session } from "../store/session-store.js";

/** A gate has at least this many options; one option is not a choice. */
const DESIGN_GATE_OPTIONS_MIN = 2;

/** The first fault of a gate request, or null when it is valid. */
export function gate_fault(request: DesignGateRequest): string | null {
    if (request.question.trim().length === 0) {
        return "question must not be empty";
    }
    if (request.question.length > DESIGN_GATE_QUESTION_MAX) {
        return `question must be at most ${DESIGN_GATE_QUESTION_MAX} characters`;
    }
    if (request.options.length < DESIGN_GATE_OPTIONS_MIN) {
        return `options must hold ${DESIGN_GATE_OPTIONS_MIN} to ${DESIGN_GATE_OPTIONS_MAX} items`;
    }
    if (request.options.length > DESIGN_GATE_OPTIONS_MAX) {
        return `options must hold ${DESIGN_GATE_OPTIONS_MIN} to ${DESIGN_GATE_OPTIONS_MAX} items`;
    }
    for (const [index, option] of request.options.entries()) {
        if (option.trim().length === 0) {
            return `options[${index}] must not be empty`;
        }
        if (option.length > DESIGN_GATE_OPTION_MAX) {
            return `options[${index}] must be at most ${DESIGN_GATE_OPTION_MAX} characters`;
        }
    }
    return null;
}

/** Validates the request (throws the first fault) and writes `design.gate`. */
export function set_gate(
    home: SpinnerHome,
    dir: string,
    request: DesignGateRequest,
    now: Date,
): void {
    const fault = gate_fault(request);
    if (fault !== null) {
        throw new Error(fault);
    }
    const read = read_session(home, dir);
    if (!read.ok) {
        throw new Error(read.error);
    }
    const design = read.summary.session.design;
    if (design === undefined) {
        throw new Error("no design block");
    }
    design.gate = {
        question: request.question,
        options: [...request.options],
        asked: now.toISOString(),
    };
    write_session(read.summary);
}

/** Removes `design.gate`; returns whether one existed. A missing session has no gate. */
export function clear_gate(home: SpinnerHome, dir: string): boolean {
    const read = read_session(home, dir);
    if (!read.ok) {
        return false;
    }
    const design = read.summary.session.design;
    if (design?.gate === undefined) {
        return false;
    }
    delete design.gate;
    write_session(read.summary);
    return true;
}
