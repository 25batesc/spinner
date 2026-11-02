// The compose box's data: what `POST /sessions/extract` answers, which PRs start ticked, and
// the body `Start` sends. The component (`SessionForms.tsx`) owns the textarea and the timer;
// everything that can be tested without a DOM lives here.

// The shapes of `POST /sessions/extract` and the new `POST /sessions` body, as the s014
// mission states them. They move to `@spinner/protocol` when the engine agent commits the
// contract; the fixture (`fixture/extract.ts`) answers in this shape today.
export interface ExtractedPr {
    url: string;
    repo: string;
    number: number;
    title: string;
    branch: string;
    base: string;
    adoptable: boolean;
    /** Why the PR cannot be adopted: a repo the project does not list, an ambiguous `#N`. */
    reason?: string;
}

export interface ExtractRequest {
    text: string;
    project?: string;
}

export interface ExtractResponse {
    prs: ExtractedPr[];
    /** The text without the PR references. */
    rest: string;
}

/** `POST /sessions` from the compose box: the paste, the project, the ticked PRs. */
export interface StartSessionRequest {
    text: string;
    adopt: string[];
    project?: string;
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
    const known = new Set(beforePrs.map((pr) => pr.url));
    const ticked = new Set<string>();
    for (const pr of prs) {
        if (!pr.adoptable) {
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
    if (pr === undefined || !pr.adoptable) {
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

/** The first non-empty line of the paste, as the daemon takes it for the provisional title. */
export function provisionalTitle(text: string): string {
    const line = text.split("\n").map((item) => item.trim()).find((item) => item !== "");
    return line ?? "";
}

/** The body of `POST /sessions`: the text, the project when picked, the ticked PRs in order. */
export function startBody(
    text: string,
    project: string,
    ticked: ReadonlySet<string>,
    prs: readonly ExtractedPr[],
): StartSessionRequest {
    const adopt = prs.filter((pr) => pr.adoptable && ticked.has(pr.url)).map((pr) => pr.url);
    const body: StartSessionRequest = { text, adopt };
    if (project !== "") {
        body.project = project;
    }
    return body;
}
