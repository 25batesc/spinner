// The M2 routes of the fixture daemon: mission, threads, the post and approve previews, the
// pipeline jobs and the agent context files. It keeps its state in memory and emits the same
// events the daemon does, so the UI tests see the real flow without GitHub or Slack.
import type { ServerResponse } from "node:http";

import type {
    ContextFileView,
    Job,
    JobAction,
    MissionItemRequest,
    SessionView,
    SpinnerEvent,
    ThreadView,
} from "@spinner/protocol";

import { applyItem, missionView } from "./mission-view.ts";

/** The part of the fixture daemon these routes use. */
export interface Host {
    sessions: Map<string, SessionView>;
    emit(event: SpinnerEvent): void;
    update(next: SessionView): void;
    start(
        action: JobAction,
        dir: string | null,
        work: (log: (line: string) => void) => Promise<string | null>,
    ): Job;
}

export const MISSION = [
    "# s17 · Refund flow", "", "## Goal", "Let a customer request a refund.", "",
    "## Done when", "- [x] refund button works (frontend, 10:20)", "- [ ] refunds reach Stripe",
    "", "## Plan", "- [x] 1. the refund route (backend, 10:12)", "- [ ] 2. the form (frontend)",
    "- [ ] 3. the Stripe call (backend)", "",
    "## Roster", "| Agent | Owns | Doing | Blocked? | Updated |",
    "|-------|------|-------|----------|---------|",
    "| backend | api | #3 the Stripe call | no | 10:00 |",
    "| frontend | web | form | waiting on api | 10:05 |", "",
    "## Contracts & decisions", "- 10:00 backend: POST /refunds", "",
    "## Open questions", "- backend: partial refunds in the first round?", "",
    "## Log", "- 10:00 operator: session created", "- 10:12 backend: route done",
    "- 10:20 frontend: button wired", "",
].join("\n");

const HEADINGS: Record<string, string> = {
    goal: "Goal", done_when: "Done when", plan: "Plan", roster: "Roster",
    contracts: "Contracts & decisions", open_questions: "Open questions", log: "Log",
};

function thread(label: string, partial: Partial<ThreadView>): ThreadView {
    return {
        id: `PRRT_${label}`, label, state: "open", outdated: false, author: "reviewer-bot",
        author_kind: "bot", path: "src/refund.ts", line: 12, body: `Comment ${label}`,
        replies: [], replied: false, flagged: null, ...partial,
    };
}

/**
 * A context file's text: markdown with the forms the UI renders (a heading, a table, a task
 * list, a fence) and one thing it must drop (a script), so the driver sees the sanitizer work.
 */
export function contextContent(scope: ContextFileView["scope"]): string {
    return [
        `# Rules for ${scope} scope`, "", "| Rule | Why |", "|---|---|",
        "| stage by path | the other agent commits too |", "", "- [x] read the brief",
        "- [ ] tick your items", "", "```ts", "const scope = \"" + scope + "\";", "```", "",
        "<script>window.contextScriptRan = true</script>", "",
    ].join("\n");
}

function sendJson(response: ServerResponse, body: unknown, status = 200): true {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
    return true;
}

export class PipelineFixture {
    missions = new Map<string, string>();
    threads: ThreadView[] = [
        thread("T1", { body: "Handle a zero amount." }),
        thread("T2", { author: "casey", author_kind: "human", line: 40, body: "Why not a queue?" }),
        thread("T3", { state: "resolved", replied: true, body: "Typo in the name." }),
    ];
    context = new Map<string, ContextFileView>();
    /** The notes `POST /sessions/:dir/inbox` wrote, for the tests. */
    inbox: { file: string; to: string; subject: string; text: string }[] = [];
    posted: string | null = null;
    approved = false;

    private readonly host: Host;

    constructor(host: Host) {
        this.host = host;
    }

    mission(dir: string): string {
        return this.missions.get(dir) ?? MISSION;
    }

    private threadsView(dir: string) {
        const open = this.threads.filter((t) => t.state === "open");
        return {
            session: dir,
            rendered: new Date().toISOString(),
            prs: [
                {
                    repo: "web", number: 412, url: "https://github.com/example/web/pull/412",
                    head: "a1b2c3d4e5", checks: "green", review: "none",
                    open_bot: open.filter((t) => t.author_kind === "bot").length,
                    open_human: open.filter((t) => t.author_kind === "human").length,
                    resolved: this.threads.length - open.length,
                    flagged: this.threads.filter((t) => t.flagged !== null).length,
                    threads: [...open, ...this.threads.filter((t) => t.state === "resolved")],
                    file: "threads/web-412.md",
                },
            ],
        };
    }

    private event(dir: string, event: object): void {
        this.host.emit({ ts: new Date().toISOString(), session: dir, ...event } as SpinnerEvent);
    }

    /**
     * `PUT /sessions/:dir/mission/section`: `replace` and `append` as before, `item` on
     * `plan` and `done_when` as the daemon (s014). `mission.changed` carries the view.
     */
    private putSection(
        dir: string, body: Record<string, unknown>,
    ): { sections: string[] } | { error: string } {
        const section = String(body["section"]);
        const heading = HEADINGS[section] ?? section;
        const author = String(body["author"]);
        const mode = String(body["mode"]);
        let next: string;
        if (mode === "item") {
            if (section !== "plan" && section !== "done_when") {
                return { error: `item mode is for plan and done_when, not ${section}` };
            }
            const request = body["item"] as MissionItemRequest | undefined;
            if (request === undefined) {
                return { error: "item mode needs item" };
            }
            const result = applyItem(this.mission(dir), section, author, request);
            if ("error" in result) {
                return result;
            }
            next = result.text;
        } else {
            const lines = this.mission(dir).split("\n");
            const start = lines.indexOf(`## ${heading}`);
            const after = lines.findIndex((line, i) => i > start && line.startsWith("## "));
            const end = after === -1 ? lines.length : after;
            const text = String(body["text"]);
            if (mode === "append") {
                const stamp = section === "log" || section === "contracts"
                    ? `- ${new Date().toTimeString().slice(0, 5)} ${author}: ` : "- ";
                lines.splice(end - 1, 0, `${stamp}${text}`);
            } else {
                lines.splice(start + 1, end - start - 1, ...text.split("\n"), "");
            }
            next = lines.join("\n");
        }
        this.missions.set(dir, next);
        const view = missionView(next);
        this.event(dir, { type: "mission.changed", author, sections: [section], view });
        return { sections: [section] };
    }

    private afterThread(dir: string, opened: string[], resolved: string[]): void {
        this.event(dir, {
            type: "threads.updated", repo: "web", number: 412, opened, resolved,
            flagged: this.threads.filter((t) => t.flagged !== null).map((t) => t.label),
            file: "threads/web-412.md",
        });
    }

    private threadRoute(
        dir: string, id: string, verb: string, body: Record<string, unknown>,
        response: ServerResponse,
    ): boolean {
        const found = this.threads.find((t) => t.id === id);
        if (found === undefined) {
            return sendJson(response, { error: "no such thread" }, 404);
        }
        if (verb === "reply") {
            const comment = {
                id: `c${found.replies.length}`, author: "operator", created: "now",
                body: String(body["text"]),
            };
            found.replies.push(comment);
            found.replied = true;
        } else if (verb === "resolve") {
            if (!found.replied) {
                return sendJson(response, { error: "reply before you resolve" }, 409);
            }
            found.state = "resolved";
        } else {
            found.flagged = String(body["reason"]);
        }
        this.afterThread(dir, [], verb === "resolve" ? [found.label] : []);
        return sendJson(response, { repo: "web", number: 412, thread: found });
    }

    private job(action: JobAction, dir: string, lines: string[], after?: () => void): Job {
        return this.host.start(action, dir, async (log) => {
            for (const line of lines) {
                log(line);
                await new Promise((resolve) => setTimeout(resolve, 150));
            }
            after?.();
            return null;
        });
    }

    private stage(dir: string, stage: "bot-review" | "approving" | "queued" | "merged"): void {
        const current = this.host.sessions.get(dir);
        if (current === undefined) {
            return;
        }
        const session = { ...current.summary.session, stage };
        const summary = { ...current.summary, session };
        this.host.update({ ...current, summary });
        this.event(dir, { type: "pipeline.updated", stage });
    }

    /** Handles one M2 route; false when the path is not one of them. */
    async handle(
        method: string, path: string, body: Record<string, unknown>,
        response: ServerResponse,
    ): Promise<boolean> {
        const match = /^\/sessions\/([^/]+)\/(.+)$/.exec(path);
        const dir = match?.[1] ?? "";
        const rest = match?.[2] ?? "";
        if (match === null || !this.host.sessions.has(dir)) {
            return false;
        }
        const accepted = (job: Job) => sendJson(response, { job }, 202);
        if (method === "GET" && rest === "mission") {
            response.writeHead(200, { "content-type": "text/markdown" });
            response.end(this.mission(dir));
            return true;
        }
        if (method === "GET" && rest === "mission/view") {
            return sendJson(response, { view: missionView(this.mission(dir)) });
        }
        if (method === "PUT" && rest === "mission/section") {
            const result = this.putSection(dir, body);
            if ("error" in result) {
                return sendJson(response, { error: result.error }, 400);
            }
            return sendJson(response, { ok: true, sections: result.sections });
        }
        if (method === "POST" && rest === "inbox") {
            // As the daemon: the file is written, `inbox.message` tells the UI.
            const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
            const to = String(body["to"]);
            const file = `${stamp}-${String(body["from"])}-${to}.md`;
            const subject = String(body["subject"]);
            this.inbox.push({ file, to, subject, text: String(body["text"]) });
            this.event(dir, {
                type: "inbox.message", file, from: String(body["from"]), to,
                subject: String(body["subject"]),
            });
            return sendJson(response, { file });
        }
        if (method === "GET" && rest === "threads") {
            return sendJson(response, { threads: this.threadsView(dir) });
        }
        if (method === "POST" && rest === "threads/refresh") {
            return sendJson(response, { threads: this.threadsView(dir) });
        }
        const thread = /^threads\/([^/]+)\/(reply|resolve|flag)$/.exec(rest);
        if (method === "POST" && thread !== null) {
            const id = decodeURIComponent(thread[1] ?? "");
            return this.threadRoute(dir, id, thread[2] ?? "", body, response);
        }
        if (method === "GET" && rest === "post") {
            return sendJson(response, { post: this.postView() });
        }
        if (method === "GET" && rest === "approve") {
            return sendJson(response, { approve: this.approveView() });
        }
        if (method === "GET" && rest.endsWith("/context")) {
            return this.contextGet(dir, rest, response);
        }
        if (method === "PUT" && rest.endsWith("/context")) {
            return this.contextPut(rest, body, response);
        }
        if (method === "POST") {
            return this.pipelineJob(dir, rest, body, response, accepted);
        }
        return false;
    }

    private postView() {
        return {
            channel: "C0FIXTURE", reviewer: "@casey", transport: "fixture", posted: this.posted,
            text: "Refund flow is ready for review: <https://github.com/example/web/pull/412|web#412>",
            prs: [], blocked: null,
        };
    }

    private approveView() {
        return {
            prs: [
                {
                    repo: "web", number: 412, url: "https://github.com/example/web/pull/412",
                    title: "Refund flow", state: "open", head: "a1b2c3d4e5",
                    diff: { files: 4, additions: 120, deletions: 8 },
                    open_threads: this.threads.filter((t) => t.state === "open").length,
                    approved: this.approved, blocked: this.approved ? "already approved" : null,
                },
            ],
        };
    }

    private pipelineJob(
        dir: string, rest: string, body: Record<string, unknown>, response: ServerResponse,
        accepted: (job: Job) => true,
    ): boolean {
        const pipeline = /^(pr|review|fix|post|approve|land|reset)$/.exec(rest);
        if (pipeline === null) {
            return false;
        }
        const action = pipeline[1] as
            "pr" | "review" | "fix" | "post" | "approve" | "land" | "reset";
        if ((action === "post" || action === "approve") && body["confirm"] !== true) {
            return sendJson(response, { error: `${action} needs confirm: true` }, 400);
        }
        if (action === "review") {
            // The swarm answered before this (`server.ts`); here only the 409 without a PR.
            return sendJson(response, { error: "no open PR to review" }, 409);
        }
        const lines: Record<Exclude<typeof action, "review">, string[]> = {
            pr: ["pushing web", "opened web#412"],
            fix: ["rendering threads", "fixer steered"],
            post: ["posting through the fixture"],
            approve: ["submitting the approving review"],
            land: ["enqueued web#412"],
            reset: ["next round started"],
        };
        const after = () => {
            if (action === "pr") this.stage(dir, "bot-review");
            if (action === "post") this.posted = "https://slack.example/archives/C0FIXTURE/p1";
            if (action === "approve") {
                this.approved = true;
                this.stage(dir, "approving");
            }
            if (action === "land") this.stage(dir, "merged");
        };
        return accepted(this.job(action, dir, lines[action], after));
    }

    private contextGet(dir: string, rest: string, response: ServerResponse): boolean {
        const agent = rest.split("/")[1] ?? "";
        const root = `/home/fixture/.spinner/sessions/${dir}`;
        const defaults: [string, ContextFileView["scope"], boolean][] = [
            ["/home/fixture/.pi/agent/AGENTS.md", "user", true],
            [`${root}/AGENTS.md`, "session", false],
            [`${root}/agents/${agent}/AGENTS.md`, "directory", false],
        ];
        const files = defaults.map(([path, scope, tracked]): ContextFileView =>
            this.context.get(path) ?? {
                path, scope, exists: true, tracked, content: contextContent(scope),
            },
        );
        const commands = [
            {
                name: "skill:principles", kind: "skill", path: null,
                description: "Design principles",
            },
        ];
        return sendJson(response, { files, commands });
    }

    private contextPut(
        rest: string, body: Record<string, unknown>, response: ServerResponse,
    ): boolean {
        const path = String(body["path"]);
        const old = this.context.get(path);
        const file: ContextFileView = {
            path, scope: old?.scope ?? "session", exists: true,
            tracked: old?.tracked ?? false, content: String(body["content"]),
        };
        this.context.set(path, file);
        void rest;
        return sendJson(response, { file, reloaded: false });
    }
}
