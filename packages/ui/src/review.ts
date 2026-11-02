// The Reviews panel's rules (s015): which sessions are reviews, what a card and the middle
// pane read from a review's `SessionView`, and how the pills and the swarm dots take their
// state. The shape of the review fields is the engine's contract; this module is the one
// place that reads them, so a change to the contract lands here and nowhere else.
import type { CheckState, ReviewDecision, SessionView } from "@spinner/protocol";

export type SwarmState = "queued" | "reading" | "posted" | "failed";

/** One reviewer of the swarm: a tty agent of the session, named `review-<model-slug>`. */
export interface SwarmMember {
    name: string;
    model: string;
    state: SwarmState;
    usd: number;
}

/** The review fields of a `SessionView` of `kind: review`, as the daemon sends them. */
export interface ReviewFields {
    /** The PR's checks, and the names of the failing ones. */
    checks: CheckState;
    failing: string[];
    review_decision: ReviewDecision;
    /** The PR's review threads, open and resolved. */
    threads: number;
    swarm: SwarmMember[];
}

/**
 * A `SessionView` with the review fields. The protocol package adds them with the engine's
 * contract; until then the fields are optional here, so the fixture and the UI type-check
 * against either package.
 */
export type ReviewSessionView = SessionView & {
    kind?: "session" | "review";
    review?: ReviewFields;
};

/** What a card and the middle pane show for one review. */
export interface ReviewFacts {
    dir: string;
    title: string;
    author: string;
    branch: string;
    base: string;
    url: string | null;
    checks: CheckState;
    failing: string[];
    decision: ReviewDecision;
    threads: number;
    swarm: SwarmMember[];
    usd: number | null;
    /** ISO 8601: the PR's last activity, else the session's creation. */
    last_activity: string;
}

export function isReview(view: SessionView | undefined): boolean {
    return (view as ReviewSessionView | undefined)?.kind === "review";
}

/** The sessions of the Sessions panel: every session that is not a review. */
export function ordinarySessions(
    sessions: [string, SessionView][],
): [string, SessionView][] {
    return sessions.filter(([, view]) => !isReview(view));
}

/** The reviews, the one with the latest activity first. */
export function reviewsByActivity(sessions: [string, SessionView][]): ReviewFacts[] {
    const reviews: ReviewFacts[] = [];
    for (const [, view] of sessions) {
        const facts = reviewFacts(view);
        if (facts !== null) {
            reviews.push(facts);
        }
    }
    return reviews.sort((a, b) => b.last_activity.localeCompare(a.last_activity));
}

/** The facts of a review session; null for an ordinary session. */
export function reviewFacts(view: SessionView): ReviewFacts | null {
    if (!isReview(view)) {
        return null;
    }
    const typed = view as ReviewSessionView;
    const session = typed.summary.session;
    const pr = typed.board?.prs[0];
    const fields = typed.review;
    const counted = pr === undefined
        ? 0
        : pr.threads.bots_open + pr.threads.humans_open + pr.threads.resolved;
    return {
        dir: typed.summary.dir,
        title: session.title,
        author: pr?.author ?? "",
        branch: session.branch,
        base: session.base,
        url: pr?.url ?? null,
        checks: fields?.checks ?? pr?.checks ?? "pending",
        failing: fields?.failing ?? [],
        decision: fields?.review_decision ?? pr?.review ?? "none",
        threads: fields?.threads ?? counted,
        swarm: fields?.swarm ?? [],
        usd: typed.cost?.usd ?? null,
        last_activity: pr?.last_activity ?? session.created,
    };
}

export interface Pill {
    text: string;
    /** The pill class: `pill-ok`, `pill-fail`, `pill-warn` or `pill-accent`; "" is neutral. */
    tone: "pill-ok" | "pill-fail" | "pill-warn" | "pill-accent" | "";
    /** The tooltip: the failing checks, or a sentence. */
    title: string;
}

/** The CI pill: green, red with the failing checks in the tooltip, amber while pending. */
export function ciPill(checks: CheckState, failing: string[]): Pill {
    if (checks === "green") {
        return { text: "CI green", tone: "pill-ok", title: "Every check passed" };
    }
    if (checks === "red") {
        const title = failing.length === 0 ? "A check failed" : `Failing: ${failing.join(", ")}`;
        return { text: "CI red", tone: "pill-fail", title };
    }
    return { text: "CI pending", tone: "pill-warn", title: "Checks are running" };
}

/** The review decision pill, in GitHub's words. */
export function decisionPill(decision: ReviewDecision): Pill {
    if (decision === "approved") {
        return { text: "approved", tone: "pill-ok", title: "A reviewer approved" };
    }
    if (decision === "changes_requested") {
        return { text: "changes requested", tone: "pill-fail", title: "A reviewer asked for changes" };
    }
    return { text: "no decision", tone: "", title: "No review decision yet" };
}

/** The chip's dot class for a reviewer's state. */
export function swarmDot(state: SwarmState): string {
    const dots: Record<SwarmState, string> = {
        queued: "dot-idle",
        reading: "dot-working",
        posted: "dot-up",
        failed: "dot-failed",
    };
    return dots[state];
}

/** `2 of 3 posted`: the swarm in one line for the card's tooltip and the pane. */
export function swarmLine(swarm: SwarmMember[]): string {
    if (swarm.length === 0) {
        return "no reviewers yet";
    }
    const posted = swarm.filter((member) => member.state === "posted").length;
    const failed = swarm.filter((member) => member.state === "failed").length;
    const tail = failed === 0 ? "" : `, ${failed} failed`;
    return `${posted} of ${swarm.length} posted${tail}`;
}
