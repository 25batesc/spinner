// The design workspace's routes and files in the fixture daemon (docs/designs/egm-adoption.md,
// entries 5.12 and 5.14). `GET …/design/files` lists `design.files` and the archived review
// runs; `…/design/files/:name`, `…/design/reviews/:run/:name` and `…/design/doc` answer
// markdown; `GET …/rounds/:round/log` answers an earlier round's Log. Each refuses as entry
// 5.3 says: 400 for a bad name or run id, 404 when absent. `withWorkspace` gives the seeded
// sessions what the workspace reads: a draft with 6 sections, the reports, one archived run,
// one drift report, and the round-3 session's two approvals.
import type { ServerResponse } from "node:http";

import {
    DESIGN_FILE_NAME_PATTERN,
    ROUNDS_MAX,
    type DesignApproval,
    type DesignFilesResponse,
    type DesignView,
    type GoldfishView,
    type SessionView,
} from "@spinner/protocol";

import { DESIGN_DOC, designView } from "./data.ts";

/** The part of the fixture daemon these routes use. */
export interface WorkspaceHost {
    sessions: Map<string, SessionView>;
}

const FILES_ROUTE = /^\/sessions\/([^/]+)\/design\/files$/;
const FILE_ROUTE = /^\/sessions\/([^/]+)\/design\/files\/([^/]+)$/;
const REVIEW_ROUTE = /^\/sessions\/([^/]+)\/design\/reviews\/([^/]+)\/([^/]+)$/;
const DOC_ROUTE = /^\/sessions\/([^/]+)\/design\/doc$/;
const ROUND_LOG_ROUTE = /^\/sessions\/([^/]+)\/rounds\/([^/]+)\/log$/;
const RUN_ID = /^r\d{1,2}$/;

/** The resolving session reads review run `r2`; `r1` is its archived run. */
export const ARCHIVED_RUNS: Record<string, string[]> = { "s206-csv-resolving": ["r1"] };
/** The direct-track session's drift report, in its Files tab. */
export const DRIFT_REPORT = "CSV_EXPORT_DRIFT_REPORT.md";

const DRAFT = [
    "# CSV export",
    "",
    "*   **Status:** Draft",
    "",
    "## Overview",
    "",
    "The list page gains an export button that streams the shown rows as CSV.",
    "",
    "## Goals",
    "",
    "*   An export of up to 50,000 rows finishes in under 10 seconds.",
    "",
    "## Non-Goals",
    "",
    "*   Scheduled exports.",
    "",
    "## Decisions",
    "",
    "*   **D1:** Stream from the list query; no background job.",
    "",
    "```md",
    "## This line is code, not a section",
    "```",
    "",
    "## Technical Plan",
    "",
    "`GET /exports/:list.csv` streams rows with the list's filters.",
    "",
    "## Verification Plan",
    "",
    "*   A 50,000-row export in the e2e suite.",
    "",
].join("\n");

/** The doc in the worktree: the draft, reviewed. */
const DOC = DRAFT.replace("**Status:** Draft", "**Status:** Reviewed");

function report(title: string, line: string): string {
    return `# ${title}\n\n${line}\n`;
}

/** The files of `<session>/design/` by name; every design session reads the same text. */
const FILES: Record<string, string> = {
    "concepts_brief.md": "# Concepts brief: CSV export\n\n## Concept\n\n" +
        "Operators export the rows they see.\n\n## Carried forward\n\n*   Streamed CSV.\n",
    "design_draft.md": DRAFT,
    "zoom_out_report.md": report("Zoom out report", "The goals match the problem."),
    "comprehension_report.md": report("Comprehension report", "A reader can build D1."),
    "critic_report.md": report("Critic report", "**B1:** the row cap has no source."),
    "consolidated_review_report.md": report(
        "Consolidated review report",
        "Blockers: 1. **B1:** name the source of the 50,000-row cap.",
    ),
    "goldfish_review_report.md": report(
        "Goldfish review report",
        "**Status: open**\n\n1. B1, the row cap: open.",
    ),
    [DRIFT_REPORT]: report("Drift report: CSV export", "No drift between the doc and the code."),
};

/** The reports of archived runs, by run id. */
const ARCHIVED: Record<string, Record<string, string>> = {
    r1: {
        "zoom_out_report.md": report("Zoom out report (run r1)", "The scope is too wide."),
        "consolidated_review_report.md": report(
            "Consolidated review report (run r1)",
            "Blockers: 3. The first run asked for a narrower scope.",
        ),
    },
};

/** The Logs of the round-3 session's earlier rounds. */
const ROUND_LOGS: Record<string, Record<number, string>> = {
    "s210-csv-round-3": {
        1: "- 09:30 lead: round 1 started on feat/csv-export\n" +
            "- 16:02 operator: web#41 merged",
        2: "- 17:10 lead: round 2 started on feat/csv-export-r2\n" +
            "- 11:20 operator: web#57 merged; api#9 closed",
    },
};

/** The review Goldfish the resolving session shows in its Review tab. */
function reviewGoldfish(): GoldfishView[] {
    const fish = (step: number, persona: string, usd: number): GoldfishView => ({
        run: "fixture-review", step, agent: `egm-${persona}`, persona, state: "done",
        model: "anthropic/claude-sonnet-5-5", tokens: 18_400, usd,
        started: "2026-10-20T10:05:00Z", last_activity: "2026-10-20T10:09:00Z",
        design_step: "review", transcript: true,
    });
    return [fish(0, "zoom_out", 0.31), fish(1, "comprehension", 0.27), fish(2, "critic", 0.4)];
}

/** The round-3 session's approvals: round 1, then round 2, which stands. */
const APPROVALS: DesignApproval[] = [
    {
        path: DESIGN_DOC, repo: "web", sha256: "4d1e9a07c3b2f5e86a10",
        at: "2026-10-14T15:00:00Z", blockers: 1, round: 1,
    },
    {
        path: DESIGN_DOC, repo: "web", sha256: "9f2c4be1d0a7c55e2b31",
        at: "2026-10-18T10:30:00Z", blockers: 0, round: 2,
    },
];

/** The seeded sessions with the facts the workspace reads (entries 5.12 and 5.14). */
export function withWorkspace(view: SessionView): SessionView {
    const dir = view.summary.dir;
    const design = view.design;
    if (dir === "s206-csv-resolving" && design !== undefined) {
        const run = { id: "r2", preset: "uninterrupted" as const, started: "2026-10-20T10:04:00Z" };
        const goldfish = design.goldfish.some((fish) => fish.design_step === "review")
            ? design.goldfish
            : [...design.goldfish, ...reviewGoldfish()];
        return { ...view, design: { ...design, review_run: run, goldfish } };
    }
    if (dir === "s209-csv-direct" && design !== undefined) {
        const drift = { name: DRIFT_REPORT, bytes: 812, mtime: "2026-10-19T11:00:00Z" };
        return { ...view, design: { ...design, files: [...design.files, drift] } };
    }
    if (dir === "s210-csv-round-3" && design === undefined) {
        const approved: DesignView = designView("approved", {
            repo: "web", approvals: APPROVALS, approved: APPROVALS[1] ?? null,
        });
        return { ...view, design: approved };
    }
    return view;
}

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
}

function sendMarkdown(response: ServerResponse, text: string | undefined, what: string): void {
    if (text === undefined) {
        sendJson(response, { error: `no ${what}` }, 404);
        return;
    }
    response.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
    response.end(text);
}

/** Entry 5.3: a name the routes accept; a dotfile is refused too. */
function validName(name: string): boolean {
    return DESIGN_FILE_NAME_PATTERN.test(name) && !name.startsWith(".");
}

export class WorkspaceFixture {
    readonly host: WorkspaceHost;

    constructor(host: WorkspaceHost) {
        this.host = host;
    }

    /** Handles a workspace route; false when `path` is not one, so the caller goes on. */
    handle(method: string, path: string, response: ServerResponse): boolean {
        if (method !== "GET") {
            return false;
        }
        const log = ROUND_LOG_ROUTE.exec(path);
        if (log !== null) {
            this.roundLog(response, log[1] ?? "", log[2] ?? "");
            return true;
        }
        const match = FILES_ROUTE.exec(path) ?? FILE_ROUTE.exec(path) ??
            REVIEW_ROUTE.exec(path) ?? DOC_ROUTE.exec(path);
        if (match === null) {
            return false;
        }
        const design = this.host.sessions.get(match[1] ?? "")?.design;
        if (design === undefined) {
            sendJson(response, { error: `no design session ${match[1]}` }, 404);
            return true;
        }
        const dir = match[1] ?? "";
        if (FILES_ROUTE.test(path)) {
            const body: DesignFilesResponse = {
                files: design.files, review_runs: ARCHIVED_RUNS[dir] ?? [],
            };
            sendJson(response, body);
        } else if (DOC_ROUTE.test(path)) {
            sendMarkdown(response, design.doc === null ? undefined : DOC, "design doc yet");
        } else if (REVIEW_ROUTE.test(path)) {
            this.review(response, dir, decodeURIComponent(match[2] ?? ""),
                decodeURIComponent(match[3] ?? ""));
        } else {
            this.file(response, design, decodeURIComponent(match[2] ?? ""));
        }
        return true;
    }

    file(response: ServerResponse, design: DesignView, name: string): void {
        if (!validName(name)) {
            sendJson(response, { error: `bad file name ${name}` }, 400);
            return;
        }
        const listed = design.files.some((file) => file.name === name);
        sendMarkdown(response, listed ? FILES[name] : undefined, `file ${name}`);
    }

    review(response: ServerResponse, dir: string, run: string, name: string): void {
        if (!RUN_ID.test(run) || !validName(name)) {
            sendJson(response, { error: `bad run ${run} or file name ${name}` }, 400);
            return;
        }
        const known = (ARCHIVED_RUNS[dir] ?? []).includes(run);
        sendMarkdown(response, known ? ARCHIVED[run]?.[name] : undefined, `${run}/${name}`);
    }

    roundLog(response: ServerResponse, dir: string, round: string): void {
        const number = Number(round);
        if (!Number.isInteger(number) || number < 1 || number > ROUNDS_MAX) {
            sendJson(response, { error: `round must be an integer from 1 to ${ROUNDS_MAX}` }, 400);
            return;
        }
        sendMarkdown(response, ROUND_LOGS[dir]?.[number], `log of round ${number}`);
    }
}
