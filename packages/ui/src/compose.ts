// The compose box's data: what `POST /sessions/extract` answers, which PRs start ticked, and
// the body `Start` sends. The component (`SessionForms.tsx`) owns the textarea and the timer;
// everything that can be tested without a DOM lives here.

import type { ExtractedPr, NewSessionRequest } from "@spinner/protocol";

export type { ExtractedPr } from "@spinner/protocol";

/** What a tick is keyed on: the URL, or the reference as written when it did not resolve. */
export function prKey(pr: ExtractedPr): string {
    return pr.url ?? pr.ref;
}

/** How long the typing must pause before the box asks the daemon for the PRs. */
export const EXTRACT_PAUSE_MS = 500;

/**
 * The ticks after an extraction. A PR the operator unticked stays unticked while it is still
 * in the text; a PR that is new to the list starts ticked when it is adoptable. A PR that is
 * not adoptable can never be ticked.
 */
export function nextTicks(
    before: ReadonlySet<string>,
    beforePrs: readonly ExtractedPr[],
    prs: readonly ExtractedPr[],
): Set<string> {
    const known = new Set(beforePrs.map(prKey));
    const ticked = new Set<string>();
    for (const pr of prs) {
        if (!pr.adoptable || pr.url === null) {
            continue;
        }
        if (!known.has(pr.url) || before.has(pr.url)) {
            ticked.add(pr.url);
        }
    }
    return ticked;
}

/** Flips one PR's tick; a PR that is not adoptable stays unticked. */
export function toggleTick(
    ticked: ReadonlySet<string>,
    prs: readonly ExtractedPr[],
    url: string,
): Set<string> {
    const next = new Set(ticked);
    const pr = prs.find((item) => item.url === url);
    if (pr === undefined || !pr.adoptable || pr.url === null) {
        next.delete(url);
        return next;
    }
    if (next.has(url)) {
        next.delete(url);
    } else {
        next.add(url);
    }
    return next;
}

/** The body of `POST /sessions`: the text, the project when picked, the ticked PRs in order. */
export function startBody(
    text: string,
    project: string,
    ticked: ReadonlySet<string>,
    prs: readonly ExtractedPr[],
): NewSessionRequest {
    const adopt: string[] = [];
    for (const pr of prs) {
        if (pr.adoptable && pr.url !== null && ticked.has(pr.url)) {
            adopt.push(pr.url);
        }
    }
    const body: NewSessionRequest = { text, adopt };
    if (project !== "") {
        body.project = project;
    }
    return body;
}
