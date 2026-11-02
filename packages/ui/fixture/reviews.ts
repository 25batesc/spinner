// The review routes of the fixture daemon (s015, s016): `POST /reviews` makes one review
// session per PR of the paste, and `POST /sessions/:dir/review` on a session with an open PR
// runs the lead's process: the lead agent starts and writes the briefing, one tty reviewer per
// model moves from `queued` to `reading` to `done` (a verdict file, never a post), and the
// lead writes the draft, which sets `needs_human`. `GET /sessions/:dir/review/briefing` serves
// the briefing; `PUT` and `DELETE /sessions/:dir/review/draft` edit and drop the draft;
// `POST /sessions/:dir/review/post` answers a URL and sets `posted_url`. Every change emits
// `review.updated`. The shape of the review fields is in `src/review.ts`.
import type { ServerResponse } from "node:http";

import {
    LEAD_NAME, REVIEW_DRAFT_NEEDS_HUMAN,
    type Job, type JobAction, type PrFacts, type ReviewDraft, type ReviewFields,
    type SessionView, type SpinnerEvent, type SwarmMember,
} from "@spinner/protocol";

import { BRIEFING_MD, DRAFT, pr, reviewerName, reviewView, session } from "./data.ts";
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

/** The lead's model; the daemon reads `settings.default_model`. */
const LEAD_MODEL = "anthropic/claude-opus-5-5";

/** The posted review's URL for a PR: GitHub's shape, with a fixed review id. */
export function postedUrl(prUrl: string): string {
    return `${prUrl}#pullrequestreview-9001`;
}

export function isReviewSession(view: SessionView | undefined): view is SessionView {
    return view?.kind === "review";
}

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
}

const EMPTY_FIELDS: ReviewFields = {
    checks: "pending", failing: [], review_decision: "none", threads: 0, swarm: [],
    briefing: false, draft: null, posted_url: null,
};

export class ReviewFixture {
    private readonly host: ReviewHost;
    private counter = 0;
    /** The session files the routes serve, keyed `<dir>/<path>`. */
    private readonly files = new Map<string, string>();

    constructor(host: ReviewHost) {
        this.host = host;
    }

    /** The briefing of a session made before the fixture started (the canned r51). */
    seedBriefing(dir: string): void {
        this.files.set(`${dir}/artifacts/briefing.md`, BRIEFING_MD);
    }

    /**
     * `POST /reviews { text }`: one `reviews` job; every PR with a URL in the paste becomes
     * a review session, no project needed. The job names the first one made, as the daemon
     * does, so the UI selects it. Null when no reference resolves (the daemon's 409).
     */
    create(text: string): Job | null {
        const found = extract(text, []).prs.filter((item) => item.url !== null);
        if (found.length === 0) {
            return null;
        }
        return this.host.start("reviews", null, async (log) => {
            let first: string | null = null;
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
                    kind: "review",
                    created: new Date().toISOString(),
                    branch: item.branch ?? "unknown", base: item.base ?? "main",
                });
                const facts: PrFacts = pr(item.number, repo, {
                    url: item.url ?? "", author: "peer", title,
                    threads: { bots_open: 0, humans_open: 0, resolved: 0 },
                    last_activity: new Date().toISOString(),
                });
                this.host.update(reviewView(dir, base, facts, { ...EMPTY_FIELDS }));
                log(`review ${dir} ready; lead and swarm starting`);
                first ??= dir;
                // As the daemon: the job starts the lead and the swarm and ends; the agents
                // run on after it. The fixture's process starts once the job has answered.
                setTimeout(() => void this.process(dir, () => undefined), STEP_MS);
            }
            return first;
        });
    }

    /**
     * `POST /sessions/:dir/review` on any session with an open PR: the lead's process (s016).
     * The lead starts and writes the briefing while the reviewers read; each reviewer is a
     * tty agent of the session, `queued`, then `reading`, then `done` with a verdict file;
     * the lead's draft comes last and sets `needs_human`. Null without a session or an open
     * PR, as the daemon's 404 and 409.
     */
    swarm(dir: string): Job | null {
        const current = this.host.sessions.get(dir);
        const prs = current?.board?.prs ?? [];
        if (current === undefined || !prs.some((p) => p.state === "open" || p.state === "draft")) {
            return null;
        }
        return this.host.start("review", dir, async (log) => {
            await this.process(dir, log);
            return null;
        });
    }

    /** The lead's process on one session, start to draft; `log` takes the job's lines. */
    private async process(dir: string, log: (line: string) => void): Promise<void> {
        const current = this.host.sessions.get(dir);
        if (current === undefined) {
            return;
        }
        const repo = current.board?.prs[0]?.repo ?? "repo";
        const members: SwarmMember[] = SWARM_MODELS.map((model) => ({
            name: reviewerName(model), model, state: "queued", usd: 0, pr: repo,
        }));
        this.put(dir, { swarm: members, briefing: false, draft: null, posted_url: null },
            log, "lead started; swarm queued", { lead: "running" });
        await sleep(STEP_MS);
        this.files.set(`${dir}/artifacts/briefing.md`, BRIEFING_MD);
        this.put(dir, { briefing: true }, log, "lead wrote artifacts/briefing.md");
        for (const [index, member] of members.entries()) {
            await sleep(STEP_MS);
            members[index] = { ...member, state: "reading", usd: 0.05 };
            this.put(dir, { swarm: members }, log, `${member.name} reading the diff`);
        }
        for (const [index, member] of members.entries()) {
            await sleep(STEP_MS * 2);
            members[index] = { ...member, state: "done", usd: 0.3 + index * 0.1 };
            const slug = member.name.slice("review-".length);
            this.put(dir, { swarm: members }, log,
                `${member.name} VERDICT saved to artifacts/reviews/${slug}.md`);
        }
        await sleep(STEP_MS);
        this.put(dir, { draft: DRAFT }, log, "lead wrote artifacts/review-draft.json",
            { lead: "idle", needs_human: REVIEW_DRAFT_NEEDS_HUMAN });
    }

    /**
     * The lead's routes: the session file read, the draft's edit and drop, the post. False
     * for any other path, so the fixture's other routes see it.
     */
    handle(
        method: string, path: string, body: Record<string, unknown>, response: ServerResponse,
    ): boolean {
        const route = /^\/sessions\/([^/]+)\/review\/(briefing|draft|post)$/.exec(path);
        const dir = route?.[1] ?? "";
        const current = this.host.sessions.get(dir);
        if (route === null || current === undefined) {
            return false;
        }
        const fields = this.fieldsOf(current);
        if (route[2] === "briefing" && method === "GET") {
            const text = this.files.get(`${dir}/artifacts/briefing.md`);
            if (text === undefined) {
                sendJson(response, { error: "no briefing yet" }, 404);
                return true;
            }
            response.writeHead(200, { "content-type": "text/markdown" });
            response.end(text);
            return true;
        }
        if (route[2] === "draft" && method === "PUT") {
            const draft = body as unknown as ReviewDraft;
            if (fields.draft === null || typeof draft.body !== "string") {
                sendJson(response, { error: "no draft to edit" }, 409);
                return true;
            }
            this.put(dir, { draft }, () => undefined, "");
            sendJson(response, { draft });
            return true;
        }
        if (route[2] === "draft" && method === "DELETE") {
            this.put(dir, { draft: null }, () => undefined, "", { needs_human: null });
            sendJson(response, { ok: true });
            return true;
        }
        if (route[2] === "post" && method === "POST") {
            if (fields.draft === null) {
                sendJson(response, { error: "no draft to post" }, 409);
                return true;
            }
            // One review at the head: the line comments become threads, the event a decision.
            const url = postedUrl(current.board?.prs[0]?.url ?? "");
            const event = fields.draft.event;
            this.put(dir, {
                draft: null, posted_url: url,
                threads: fields.threads + fields.draft.comments.length,
                review_decision: event === "APPROVE" ? "approved" : fields.review_decision,
            }, () => undefined, "", { needs_human: null });
            sendJson(response, { url, event });
            return true;
        }
        return false;
    }

    private fieldsOf(view: SessionView): ReviewFields {
        return { ...EMPTY_FIELDS, ...view.review };
    }

    /** Applies a change of the review fields, the agents and `needs_human`; emits. */
    private put(
        dir: string,
        change: Partial<ReviewFields>,
        log: (line: string) => void,
        line: string,
        extra: { lead?: "running" | "idle"; needs_human?: string | null } = {},
    ): void {
        const current = this.host.sessions.get(dir);
        if (current === undefined) {
            return;
        }
        const base = current.summary.session;
        const agents = { ...base.agents };
        const review: ReviewFields = { ...this.fieldsOf(current), ...change };
        for (const member of review.swarm) {
            agents[member.name] = {
                harness: "tty", model: member.model,
                process: member.state === "reading" ? "running" : "idle",
            };
        }
        if (extra.lead !== undefined) {
            agents[LEAD_NAME] = { harness: "tty", model: LEAD_MODEL, process: extra.lead };
        }
        const running = review.swarm
            .filter((member) => member.state !== "queued")
            .map((member) => member.name);
        if (agents[LEAD_NAME] !== undefined) {
            running.unshift(LEAD_NAME);
        }
        const needs_human = extra.needs_human === undefined ? base.needs_human : extra.needs_human;
        // The board carries `needs_human` too; the daemon derives it, the fixture copies it.
        const board = current.board === null ? null : { ...current.board, needs_human };
        const next: SessionView = {
            ...current,
            summary: { ...current.summary, session: { ...base, agents, needs_human } },
            board,
            agents_running: running,
            review,
        };
        this.host.update(next);
        if (line !== "") {
            log(line);
        }
        this.host.emit({
            type: "review.updated", ts: new Date().toISOString(), session: dir,
            data: review,
        });
    }
}
