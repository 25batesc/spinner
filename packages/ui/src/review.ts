// The Reviews panel's rules (s015): which sessions are reviews, what a card and the middle
// pane read from a review's `SessionView`, and how the pills and the swarm dots take their
// state. The shape of the review fields is the engine's contract; this module is the one
// place that reads them (`SessionView.kind`, `SessionView.review`, the contracts of 12:49
// and 14:07). s016 adds the lead's fields (`briefing`, `draft`, `posted_url`), the lead's
// chip, and the swarm state `done` in place of `posted`: the reviewers write verdicts and
// never post.
import {
    LEAD_NAME,
    type AgentSpec, type CheckState, type ReviewDecision, type ReviewDraft, type SessionView,
    type SwarmMember, type SwarmState,
} from "@spinner/protocol";

/** The lead's chip: the agent `lead`, its state from the agent record and the running list. */
export interface LeadChip {
    name: string;
    model: string;
    state: "running" | "idle" | "stopped";
    usd: number;
}

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
    /** The lead's chip; null while the session has no `lead` agent. */
    lead: LeadChip | null;
    briefing: boolean;
    draft: ReviewDraft | null;
    posted_url: string | null;
    usd: number | null;
    /** ISO 8601: the PR's last activity, else the session's creation. */
    last_activity: string;
}

export function isReview(view: SessionView | undefined): boolean {
    return view?.kind === "review";
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
    const session = view.summary.session;
    const pr = view.board?.prs[0];
    const fields = view.review;
    const counted = pr === undefined
        ? 0
        : pr.threads.bots_open + pr.threads.humans_open + pr.threads.resolved;
    return {
        dir: view.summary.dir,
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
        lead: leadChip(view),
        briefing: fields?.briefing ?? false,
        draft: fields?.draft ?? null,
        posted_url: fields?.posted_url ?? null,
        usd: view.cost?.usd ?? null,
        last_activity: pr?.last_activity ?? session.created,
    };
}

/** The lead's chip from the session's `lead` agent: running, idle, or stopped. */
export function leadChip(view: SessionView): LeadChip | null {
    const agent: AgentSpec | undefined = view.summary.session.agents[LEAD_NAME];
    if (agent === undefined) {
        return null;
    }
    const running = view.agents_running.includes(LEAD_NAME);
    const state = running ? (agent.process === "running" ? "running" : "idle") : "stopped";
    return {
        name: LEAD_NAME,
        model: agent.model,
        state,
        usd: view.cost?.agents[LEAD_NAME]?.usd ?? 0,
    };
}

/** The lead chip's dot: working while it runs, idle between turns, off once stopped. */
export function leadDot(state: LeadChip["state"]): string {
    const dots: Record<LeadChip["state"], string> = {
        running: "dot-working", idle: "dot-idle", stopped: "dot-off",
    };
    return dots[state];
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
        const title = "A reviewer asked for changes";
        return { text: "changes requested", tone: "pill-fail", title };
    }
    return { text: "no decision", tone: "", title: "No review decision yet" };
}

/** The chip's dot class for a reviewer's state. */
export function swarmDot(state: SwarmState): string {
    const dots: Record<SwarmState, string> = {
        queued: "dot-idle",
        reading: "dot-working",
        done: "dot-up",
        failed: "dot-failed",
    };
    return dots[state];
}

/** `2 of 3 done`: the swarm in one line for the card's tooltip and the pane. */
export function swarmLine(swarm: SwarmMember[]): string {
    if (swarm.length === 0) {
        return "no reviewers yet";
    }
    const done = swarm.filter((member) => member.state === "done").length;
    const failed = swarm.filter((member) => member.state === "failed").length;
    const tail = failed === 0 ? "" : `, ${failed} failed`;
    return `${done} of ${swarm.length} done${tail}`;
}
