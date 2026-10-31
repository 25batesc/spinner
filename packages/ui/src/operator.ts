// The operator agent: one per home, no session, hosted by the daemon under `/operator`
// (MISSION.md s013, Contracts). The UI reads its view at load, follows `operator.updated`,
// starts and stops it, and attaches its terminal at `OPERATOR_TTY_PATH`.
import type { OperatorResponse, OperatorView } from "@spinner/protocol";

/** `GET /operator`; `start`, `stop`, `prompt`, `steer` and `tty` hang under it. */
export const OPERATOR_PATH = "/operator";

/** The daemon hosts the agent's process; `exited` is the one state without a pty. */
export function operatorRunning(view: OperatorView | null): boolean {
    return view !== null && view.process !== "exited";
}

/**
 * The line under the operator tab: the last notice's newest line, `<session dir>: <fact>`,
 * with the count still queued. A notice's first line may say how many events were dropped,
 * so the last line is the one that names a session.
 */
export function waitingLine(view: OperatorView | null): string {
    if (view === null || view.last_notice === null) {
        return "waiting on: no notice yet";
    }
    const lines = view.last_notice.text.split("\n").filter((line) => line.trim() !== "");
    const last = lines.at(-1) ?? view.last_notice.text;
    const pending = view.notices_pending > 0 ? ` · ${view.notices_pending} pending` : "";
    return `waiting on: ${last}${pending}`;
}

/** The context-bar notice; null while the operator agent runs or the daemon has no operator. */
export function operatorNotice(view: OperatorView | null): string | null {
    if (view === null || operatorRunning(view)) {
        return null;
    }
    return "operator agent not running";
}

/** `GET /operator`; null from an older daemon without the route. */
export async function fetchOperator(signal: AbortSignal): Promise<OperatorView | null> {
    const response = await fetch(OPERATOR_PATH, { signal });
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw new Error(`GET ${OPERATOR_PATH} failed with status ${response.status}`);
    }
    return ((await response.json()) as OperatorResponse).operator;
}

/**
 * `POST /operator/start` or `/operator/stop`; the daemon answers with the new view and sends
 * `operator.updated`, which is what moves the tab. 409 when the agent is already in that state.
 */
export async function postOperator(action: "start" | "stop"): Promise<OperatorView> {
    const path = `${OPERATOR_PATH}/${action}`;
    const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
    });
    if (!response.ok) {
        throw new Error(`POST ${path} failed (${response.status}): ${await response.text()}`);
    }
    return ((await response.json()) as OperatorResponse).operator;
}
