// The plans library, as the UI shows it (docs/designs/talk-change-ship.md, 4.6): the status
// line of a row, the sessions a plan can be implemented in, and the request `Implement`
// sends. Pure functions; `PlansPane.tsx` and `PlanPage.tsx` draw them.
import type { PlanImplementRequest, PlanView, SessionView } from "@spinner/protocol";

/** `draft`, `drafted · 7 steps`, `implementing 3/7`, `done · 7 steps`. */
export function planStatusText(plan: PlanView): string {
    const steps = `${plan.entries} step${plan.entries === 1 ? "" : "s"}`;
    switch (plan.status) {
        case "draft":
            return "draft";
        case "implementing":
            return `implementing ${plan.done}/${plan.entries}`;
        default:
            return `${plan.status} · ${steps}`;
    }
}

/** The tone of a status, for the row's dot. */
export function planTone(plan: PlanView): "ok" | "warn" | "idle" | "done" {
    switch (plan.status) {
        case "implementing":
            return "warn";
        case "done":
            return "done";
        case "draft":
            return "idle";
        default:
            return "ok";
    }
}

/** A plan can be implemented once its document has steps. */
export function canImplement(plan: PlanView): boolean {
    return plan.entries > 0;
}

/** The value of the target select for a new session. */
export const NEW_SESSION_TARGET = "";

export interface ImplementTarget {
    dir: string;
    label: string;
}

/**
 * The sessions a plan can be implemented in: the live code sessions, newest first. Review
 * and planning sessions are left out; the daemon refuses them too.
 */
export function implementTargets(sessions: readonly [string, SessionView][]): ImplementTarget[] {
    return sessions
        .filter(([, view]) => (view.kind ?? "session") === "session")
        .map(([dir, view]) => ({
            dir,
            label: `${view.summary.session.id} · ${view.summary.session.title}`,
        }));
}

/** The body of `POST /plans/:id/implement` for the picked target. */
export function implementBody(target: string): PlanImplementRequest {
    return target === NEW_SESSION_TARGET ? {} : { session: target };
}

/** The live sessions that implement the plan, for the row's links. */
export function liveImplementations(plan: PlanView): string[] {
    return plan.sessions.filter((entry) => entry.live).map((entry) => entry.session);
}
