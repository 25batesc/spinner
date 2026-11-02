// The review routes of the fixture daemon (s015): `POST /reviews` makes one review session
// per PR of the paste, and `POST /sessions/:dir/review` on a review session starts the
// swarm, one tty reviewer per model, each moving from `queued` to `reading` to `posted` with
// a `review.updated` per change. The shape of the review fields is in `src/review.ts`.
import type { Job, JobAction, PrFacts, SessionView, SpinnerEvent } from "@spinner/protocol";

import type { ReviewSessionView, SwarmMember } from "../src/review.ts";
import { pr, reviewerName, reviewView, session } from "./data.ts";
import { extract } from "./extract.ts";

/** The part of the fixture daemon these routes use. */
export interface ReviewHost {
    sessions: Map<string, SessionView>;
    emit(event: SpinnerEvent): void;
    update(next: SessionView): void;
    start(
        action: JobAction,
        dir: string | null,
        work: (log: (line: string) => void) => Promise<string | null>,
    ): Job;
}

const STEP_MS = 300;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The models the fixture's swarm runs; the daemon reads `settings.review.models`. */
export const SWARM_MODELS = ["anthropic/claude-opus-5-5", "openai/gpt-6-luna"];

export function isReviewSession(view: SessionView | undefined): view is ReviewSessionView {
    return (view as ReviewSessionView | undefined)?.kind === "review";
}

export class ReviewFixture {
    private readonly host: ReviewHost;
    private counter = 0;

    constructor(host: ReviewHost) {
        this.host = host;
    }

    /**
     * `POST /reviews { text }`: one job; every PR with a URL in the paste becomes a review
     * session, no project needed. The job names the last one made, so the UI selects it.
     */
    create(text: string): Job {
        const found = extract(text, []).prs.filter((item) => item.url !== null);
        return this.host.start("adopt", null, async (log) => {
            let last: string | null = null;
            for (const item of found) {
                this.counter += 1;
                const repo = item.repo?.split("/")[1] ?? "repo";
                const id = `r${item.number}`;
                const dir = `${id}-${repo}-${item.number}-${this.counter}`;
                log(`fetching ${item.repo} at the head of #${item.number}`);
                await sleep(STEP_MS);
                const title = item.title ?? `${repo}#${item.number}`;
                const base = session({
                    id, slug: `${repo}-${item.number}`, title, stage: "peer-review",
                    created: new Date().toISOString(),
                    branch: item.branch ?? "unknown", base: item.base ?? "main",
                });
                const facts: PrFacts = pr(item.number, repo, {
                    url: item.url ?? "", author: "peer", title,
                    threads: { bots_open: 0, humans_open: 0, resolved: 0 },
                    last_activity: new Date().toISOString(),
                });
                this.host.update(reviewView(dir, base, facts, {
                    checks: "pending", failing: [], review_decision: "none", threads: 0,
                    swarm: [],
                }));
                log(`review ${dir} ready`);
                last = dir;
            }
            if (found.length === 0) {
                log("no PR in the text");
            }
            return last;
        });
    }

    /**
     * `POST /sessions/:dir/review` on a review session: the swarm. Each reviewer is a tty
     * agent of the session; the first two start at once and the rest wait as `queued` (the
     * running-agents cap). A reviewer reads, then posts; the thread count follows.
     */
    swarm(dir: string): Job | null {
        const current = this.host.sessions.get(dir);
        if (!isReviewSession(current)) {
            return null;
        }
        return this.host.start("review", dir, async (log) => {
            const members: SwarmMember[] = SWARM_MODELS.map((model) => ({
                name: reviewerName(model), model, state: "queued", usd: 0,
            }));
            this.put(dir, members, log, "swarm queued");
            for (const [index, member] of members.entries()) {
                await sleep(STEP_MS);
                members[index] = { ...member, state: "reading", usd: 0.05 };
                this.put(dir, members, log, `${member.name} reading the diff`);
            }
            for (const [index, member] of members.entries()) {
                await sleep(STEP_MS * 2);
                members[index] = { ...member, state: "posted", usd: 0.3 + index * 0.1 };
                this.put(dir, members, log, `${member.name} POSTED`, 2);
            }
            return null;
        });
    }

    private put(
        dir: string, swarm: SwarmMember[], log: (line: string) => void, line: string,
        threadsAdded = 0,
    ): void {
        const current = this.host.sessions.get(dir);
        if (!isReviewSession(current)) {
            return;
        }
        const base = current.summary.session;
        const agents = { ...base.agents };
        for (const member of swarm) {
            agents[member.name] = {
                harness: "tty", model: member.model,
                process: member.state === "reading" ? "running" : "idle",
            };
        }
        const running = swarm
            .filter((member) => member.state !== "queued")
            .map((member) => member.name);
        const review = {
            ...current.review ?? {
                checks: "pending" as const, failing: [], review_decision: "none" as const,
                threads: 0,
            },
            swarm: [...swarm],
        };
        review.threads += threadsAdded;
        const next: ReviewSessionView = {
            ...current,
            summary: { ...current.summary, session: { ...base, agents } },
            agents_running: running,
            review,
        };
        this.host.update(next);
        log(line);
        this.host.emit({
            type: "review.updated", ts: new Date().toISOString(), session: dir, data: next,
        } as unknown as SpinnerEvent);
    }
}
