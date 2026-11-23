// The label and the token count of a subagent of the lead. A subagent is a pi-subagents
// child that the daemon observes through its `status.json` (a Goldfish of an EGM skill, or
// any other); `SessionView.subagents` holds one `GoldfishView` per step.
import type { GoldfishView } from "@spinner/protocol";

/** The row's name: the EGM persona (`zoom_out`), else the agent (`scout`). */
export function chipLabel(view: GoldfishView): string {
    return view.persona ?? view.agent;
}

/** `850` → `0.9k`, `12_400` → `12k`: thousands, one decimal under 10k, none from 10k. */
export function tokensLabel(tokens: number): string {
    const thousands = Math.max(0, tokens) / 1000;
    const tenths = Math.round(thousands * 10) / 10;
    if (tenths < 10) {
        return `${tenths.toFixed(1)}k`;
    }
    return `${Math.round(thousands)}k`;
}
