// The round badge and its tooltip (entry 2.46): round 1 has no badge, round 3 with two
// records lists both rounds with their PRs and merge days, and a round read from MISSION.md
// (no URL, no merge time) still lists its PRs.
import type { RoundView, SessionView } from "@spinner/protocol";
import { expect, it } from "vitest";

import { roundBadge, roundTooltip } from "./rounds.ts";

function viewAt(round: number | undefined): SessionView {
    return { round } as unknown as SessionView;
}

const ROUND_1: RoundView = {
    round: 1, branch: "feat/csv-export", source: "record",
    started: "2026-11-04T09:30:00Z", ended: "2026-11-05T17:10:00Z",
    prs: [
        {
            repo: "web", number: 41, url: "https://github.com/acme/web/pull/41",
            state: "merged", merged_at: "2026-11-05T16:02:00Z",
        },
        {
            repo: "api", number: 9, url: "https://github.com/acme/api/pull/9",
            state: "closed", merged_at: null,
        },
    ],
};

const ROUND_2: RoundView = {
    round: 2, branch: "feat/csv-export-r2", source: "record",
    started: "2026-11-05T17:10:00Z", ended: "2026-11-07T10:00:00Z", prs: [],
};

it("shows no badge in round 1 or from a daemon without the round", () => {
    expect(roundBadge(viewAt(1))).toBeNull();
    expect(roundBadge(viewAt(undefined))).toBeNull();
});

it("shows r2 and r3 from round 2 on", () => {
    expect(roundBadge(viewAt(2))).toBe("r2");
    expect(roundBadge(viewAt(3))).toBe("r3");
});

it("lists each earlier round of a round-3 session with its PRs, or no PR", () => {
    expect(roundTooltip([ROUND_1, ROUND_2])).toBe(
        "r1: web#41 merged 2026-11-05, api#9 closed\nr2: no PR",
    );
});

it("lists a round parsed from MISSION.md without a URL or a merge day", () => {
    const parsed: RoundView = {
        round: 1, branch: "feat/old", source: "mission", started: null, ended: null,
        prs: [{ repo: "web", number: 12, url: null, state: "merged", merged_at: null }],
    };
    expect(roundTooltip([parsed])).toBe("r1: web#12 merged");
});

it("is empty without earlier rounds", () => {
    expect(roundTooltip([])).toBe("");
});
