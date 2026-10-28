// The Context tab's data (docs/SESSION_PROTOCOL.md, "Context chain"): the `AGENTS.md` chain an
// agent loads, from the user level to its working directory, whether git tracks each file,
// and the commands pi reports through `get_commands` while the agent runs. A write to one of
// the files goes to disk, then `/spinner-reload` goes to the running agent through `prompt`,
// which pi executes at once as an extension command; the agent's next turn sees the edit.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
    AgentCommandView,
    ContextFileRequest,
    ContextFileResponse,
    ContextFileView,
    ContextResponse,
    ContextScope,
    SessionSummary,
} from "@spinner/protocol";
import type { PiCommand } from "./harness.js";
import type { AgentManager } from "./manager.js";

/** The slash command the extension registers; `ctx.reload()` re-reads the context files. */
export const RELOAD_COMMAND = "/spinner-reload";

/** Upper bound on a context file the tab edits. */
const CONTENT_LENGTH_MAX = 512 * 1024;

export interface ContextDeps {
    agents: AgentManager;
    env?: NodeJS.ProcessEnv;
}

/** The chain for `name` in `summary`, most general first. */
export function context_files(
    deps: ContextDeps,
    summary: SessionSummary,
    name: string,
): ContextFileView[] {
    const env = deps.env ?? process.env;
    const user_dir = env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
    const cwd = agent_cwd_or_default(deps.agents, summary, name);
    const files: ContextFileView[] = [
        view_of(join(user_dir, "AGENTS.md"), "user"),
        view_of(join(summary.path, "AGENTS.md"), "session"),
    ];
    if (resolve(cwd) !== resolve(summary.path)) {
        files.push(view_of(context_file_in(cwd), "repo"));
    }
    return files;
}

/** `GET`: the chain plus the running agent's commands. */
export async function agent_context(
    deps: ContextDeps,
    summary: SessionSummary,
    name: string,
): Promise<ContextResponse> {
    const files = context_files(deps, summary, name);
    const handle = deps.agents.get(summary.dir, name);
    let commands: AgentCommandView[] = [];
    if (handle !== null) {
        try {
            commands = (await handle.commands()).map(command_view);
        } catch {
            commands = [];
        }
    }
    return { files, commands };
}

/**
 * `PUT`: writes one file of the chain and reloads the running agent. Throws when the path is
 * not in the chain, so the tab cannot write anywhere else.
 */
export async function write_context_file(
    deps: ContextDeps,
    summary: SessionSummary,
    name: string,
    request: ContextFileRequest,
): Promise<ContextFileResponse> {
    assert.ok(request.content.length <= CONTENT_LENGTH_MAX, "context file too large");
    const chain = context_files(deps, summary, name);
    const target = chain.find((file) => file.path === request.path);
    if (target === undefined) {
        throw new Error(`${request.path} is not in the context chain of ${name}`);
    }
    mkdirSync(dirname(target.path), { recursive: true });
    writeFileSync(target.path, request.content);
    const file = view_of(target.path, target.scope);
    const handle = deps.agents.get(summary.dir, name);
    if (handle === null) {
        return { file, reloaded: false };
    }
    try {
        const disposition = await handle.prompt(RELOAD_COMMAND);
        return { file, reloaded: disposition === "handled" };
    } catch {
        return { file, reloaded: false };
    }
}

/** The running agent's cwd; else the only worktree; else the session directory. */
function agent_cwd_or_default(agents: AgentManager, summary: SessionSummary, name: string): string {
    const running = agents.cwd(summary.dir, name);
    if (running !== null) {
        return running;
    }
    const worktrees = Object.values(summary.session.repos)
        .map((repo) => repo.worktree)
        .filter((worktree): worktree is string => worktree !== undefined);
    if (worktrees.length === 1 && worktrees[0] !== undefined) {
        return join(summary.path, worktrees[0]);
    }
    return summary.path;
}

/** `AGENTS.md` in `dir`, or `CLAUDE.md` when only that exists (pi reads either). */
function context_file_in(dir: string): string {
    const agents = join(dir, "AGENTS.md");
    const claude = join(dir, "CLAUDE.md");
    if (!existsSync(agents) && existsSync(claude)) {
        return claude;
    }
    return agents;
}

function view_of(path: string, scope: ContextScope): ContextFileView {
    const exists = existsSync(path);
    return {
        path,
        scope,
        exists,
        tracked: exists && is_git_tracked(path),
        content: exists ? readFileSync(path, "utf8") : "",
    };
}

/** True when a git repository tracks `path`; false outside any repository. */
export function is_git_tracked(path: string): boolean {
    try {
        execFileSync("git", ["-C", dirname(path), "ls-files", "--error-unmatch", path], {
            stdio: ["ignore", "ignore", "ignore"],
        });
        return true;
    } catch {
        return false;
    }
}

function command_view(command: PiCommand): AgentCommandView {
    const kind = command.source === "prompt" ? "template" : command.source;
    return {
        name: command.name,
        kind,
        path: command.sourceInfo?.path ?? null,
        description: command.description ?? "",
    };
}
