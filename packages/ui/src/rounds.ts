// The round badge (docs/designs/egm-adoption.md, entry 2.46, Technical Plan T14). A session is
// the long-lived home of one feature area; from round 2 the card and the context bar show
// `r<round>`, and the tooltip lists the PRs of every earlier round. The daemon sends the
// round and the rounds in `SessionView`; a daemon from before the EGM design sends neither,
// and the session then reads as round 1.
import type { RoundView, SessionView } from "@spinner/protocol";

/** `r3` from round 2 on; null in round 1, where there is nothing earlier to show. */
export function roundBadge(view: SessionView): string | null {
    const round = view.round ?? 1;
    return round >= 2 ? `r${round}` : null;
}

/**
 * One line per earlier round: `r1: web#41 merged 2026-11-05, api#9 closed`, or `r1: no PR`.
 * The date is the day of `merged_at`, shown only when the record has one.
 */
export function roundTooltip(rounds: readonly RoundView[]): string {
    return rounds.map((round) => {
        if (round.prs.length === 0) {
            return `r${round.round}: no PR`;
        }
        const prs = round.prs.map((pr) => {
            const day = pr.merged_at === null ? "" : ` ${pr.merged_at.slice(0, 10)}`;
            return `${pr.repo}#${pr.number} ${pr.state}${day}`;
        });
        return `r${round.round}: ${prs.join(", ")}`;
    }).join("\n");
}
