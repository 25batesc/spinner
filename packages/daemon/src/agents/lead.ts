// The `new` job of a session started from a paste (MISSION.md s014, Contracts "new session"):
// after `actions.new_session` made the directory, this attaches the project, adopts the PRs
// the operator ticked (worktrees on their head branches), starts the agent `lead` with the
// lead brief, and sends it the paste as its first message with the adopted and the mentioned
// PRs. Every step is one job log line, so the UI's job panel tells the story. A session
// created with a `title` alone still takes the old path (`actions.attach_new_session`).
import assert from "node:assert/strict";
import type { NewSessionRequest, SessionSummary, StackSpec } from "@spinner/protocol";
import * as actions from "../actions.js";
import type { ActionContext } from "../actions.js";
import type { SpinnerHome } from "../home.js";
import { adopt_into_session } from "../pipeline/adopt.js";
import { extract_prs } from "../pipeline/extract.js";
import { attach_project, type Log } from "../stack/runner.js";
import { load_spec } from "../stack/spec.js";
import { read_session } from "../store/session-store.js";
import type { AgentManager } from "./manager.js";

export const LEAD_NAME = "lead";

/** The title `new_session` falls back to; the first adopted PR's title replaces it. */
const TITLE_FALLBACK = "New session";

export interface LeadStartDeps {
    home: SpinnerHome;
    ctx: ActionContext;
    agents: AgentManager;
}

/** The job half of `new` with `text`: attach, adopt, start the lead, send the first message. */
export async function start_lead_session(
    deps: LeadStartDeps,
    summary: SessionSummary,
    request: NewSessionRequest,
    log: Log,
): Promise<SessionSummary> {
    assert.ok(request.text !== undefined, "a lead session starts from text");
    log(`created ${summary.path}`);
    const adopt = request.adopt ?? [];
    let current = summary;
    if (request.project !== undefined) {
        const loaded = load_spec(actions.resolve_project(deps.ctx, request.project));
        if (adopt.length > 0) {
            const repos = await actions.extract_repos(loaded.spec);
            const names = Object.fromEntries(repos.map((repo) => [repo.key, repo.name]));
            current = await adopt_into_session(deps.home, current, {
                urls: adopt,
                loaded,
                names,
                gh: deps.ctx.gh,
                log,
            });
        } else {
            current = await attach_project(current, loaded, log);
        }
        log(`project ${loaded.spec.name} attached`);
    }
    current = upgrade_title(deps, current);
    const repo = single_repo(current);
    log(`starting ${LEAD_NAME}${repo === undefined ? "" : ` in the ${repo} worktree`}`);
    const handle = await deps.agents.add(current, {
        name: LEAD_NAME,
        ...(repo === undefined ? {} : { repo }),
    });
    log(`${LEAD_NAME} started (pid ${handle.pid}); sending the first message`);
    const message = await first_message(deps, current, request.text, adopt);
    try {
        const disposition = await handle.prompt(message);
        log(`first message delivered: ${disposition}`);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        deps.agents.queue_for_next_prompt(current.dir, LEAD_NAME, message);
        log(`first message not delivered (${reason}); it goes with the next prompt`);
    }
    const check = read_session(deps.home, current.dir);
    assert.ok(check.ok, "a started session must read back");
    return check.summary;
}

/** The fallback title gives way to the first adopted PR's title, when one was adopted. */
function upgrade_title(deps: LeadStartDeps, summary: SessionSummary): SessionSummary {
    if (summary.session.title !== TITLE_FALLBACK) {
        return summary;
    }
    const titled = Object.values(summary.session.repos).find(
        (repo) => repo.pr !== null && repo.pr !== undefined && (repo.pr.title ?? "").length > 0,
    );
    const title = titled?.pr?.title;
    if (title === undefined) {
        return summary;
    }
    return actions.set_title(deps.ctx, summary, title);
}

/** The lead runs in the one repo's worktree when the project has one repo; else the session. */
function single_repo(summary: SessionSummary): string | undefined {
    const with_worktree = Object.entries(summary.session.repos).filter(
        ([, repo]) => repo.worktree !== undefined,
    );
    if (with_worktree.length !== 1) {
        return undefined;
    }
    return with_worktree[0]?.[0];
}

/**
 * The paste, then the PRs: `Adopted:` lines for the ones with a worktree, `Mentioned:` for
 * the references the paste named but the session did not adopt. The mentioned ones come from
 * a second extract against the session's repos; a GitHub failure there only drops the line.
 */
async function first_message(
    deps: LeadStartDeps,
    summary: SessionSummary,
    text: string,
    adopted: readonly string[],
): Promise<string> {
    const lines = [text.trim()];
    const adopted_lines: string[] = [];
    for (const [key, repo] of Object.entries(summary.session.repos)) {
        const pr = repo.pr;
        if (pr === null || pr === undefined || !adopted.includes(pr.url)) {
            continue;
        }
        adopted_lines.push(`Adopted: ${pr.url} (${key}, worktree ${repo.worktree ?? "none"})`);
    }
    if (adopted_lines.length > 0) {
        lines.push("", ...adopted_lines);
    }
    const mentioned = await mentioned_lines(deps, summary, text, adopted);
    if (mentioned.length > 0) {
        lines.push("", ...mentioned);
    }
    return lines.join("\n");
}

async function mentioned_lines(
    deps: LeadStartDeps,
    summary: SessionSummary,
    text: string,
    adopted: readonly string[],
): Promise<string[]> {
    try {
        const spec = summary.session.project === undefined ? null : spec_of(deps, summary);
        const repos = spec === null ? [] : await actions.extract_repos(spec);
        const extracted = await extract_prs(text, repos, { gh: deps.ctx.gh, timeout_ms: 5_000 });
        return extracted.prs
            .filter((pr) => pr.url === null || !adopted.includes(pr.url))
            .map((pr) => {
                const where = pr.url ?? pr.ref;
                const title = pr.title === null ? "" : ` "${pr.title}"`;
                const reason = pr.reason === undefined ? "" : ` (${pr.reason})`;
                return `Mentioned: ${where}${title}${reason}`;
            });
    } catch {
        return [];
    }
}

function spec_of(deps: LeadStartDeps, summary: SessionSummary): StackSpec {
    const project = summary.session.project;
    assert.ok(project !== undefined);
    return load_spec(actions.resolve_project(deps.ctx, project)).spec;
}
