// The out-of-area edit guard (docs/SESSION_PROTOCOL.md, "Hooks"): an `edit` or `write` whose
// path is outside the globs under `## Owns` in the agent's brief is blocked until a Log line
// in MISSION.md names the file, which is the protocol's "log it first". Paths inside the
// session directory are exempt (the mission, notes, artifacts). A brief without globs
// disables the guard, because there is nothing to check against. On the design track the
// lead may write only the design doc and the session's files until the operator approves the
// design, and again while a changed design waits for re-approval (EGM's design-only scope,
// docs/designs/egm-adoption.md D7, T10, 6.13). The `bash` tool is not covered.
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
    DESIGN_STATE_FILE,
    EGM_ARTIFACT_DIR,
    OPERATOR_REFUSED_ACTIONS,
    type ExtensionRole,
} from "@spinner/protocol";
import { section_body } from "./prompt.js";

/**
 * The shell commands the operator role refuses (MISSION.md s013, Contracts): `spinner` with
 * one of `OPERATOR_REFUSED_ACTIONS`, `git push`, the `gh pr` verbs that open, merge or
 * review, `gh pr comment`, and a `gh api` call that writes (a method other than GET, or
 * `--input`, `-f`, `-F`, `--field`, `--raw-field`), which is how a review would be posted
 * (s016: the lead drafts, the operator posts). The message says the operator must do it.
 * Null when the command is allowed.
 */
export function refuse_operator_bash(command: string): string | null {
    const method = /(?:-X|--method)[\s=]+(?!GET\b)\w+/.source;
    const fields = /--input\b|\s-[fF]\s|--(?:raw-)?field\b/.source;
    const GH_API_WRITE = new RegExp(`(^|[\\s;&|])gh\\s+api\\b[^;&|]*(?:${method}|${fields})`);
    const actions = OPERATOR_REFUSED_ACTIONS.join("|");
    const checks: Array<[RegExp, string]> = [
        [new RegExp(`(^|[\\s;&|])spinner\\s+(${actions})\\b`), "spinner $2"],
        [/(^|[\s;&|])git\s+(?:[^\s;&|]+\s+)*push\b/, "git push"],
        [/(^|[\s;&|])gh\s+pr\s+(create|merge|review|close|comment)\b/, "gh pr $2"],
        [GH_API_WRITE, "gh api (a write)"],
    ];
    for (const [pattern, what] of checks) {
        const match = pattern.exec(command);
        if (match !== null) {
            const named = what.replace("$2", match[2] ?? "");
            return (
                `\`${named}\` is not yours to run: the operator must do it, in the UI or ` +
                "with the spinner command. Tell the operator what is ready and why."
            );
        }
    }
    return null;
}

/** Upper bound on globs read from a brief. */
const GLOBS_MAX = 100;

export interface GuardInput {
    /** The path the tool was given. */
    path: string;
    /** The agent's working directory, for a relative path. */
    cwd: string;
    session_dir: string;
    brief: string;
    mission: string;
    /** `<session>/design/.state.json`, read before each check; null when absent or invalid. */
    design?: GuardDesign | null;
    role?: ExtensionRole;
}

/** The part of the tracker's `.state.json` the guard reads. */
export interface GuardDesign {
    track: string;
    approved: boolean;
    /** Absolute; null when the session has no worktree of the designs repo. */
    designs_dir: string | null;
}

/** The refusal of a lead's code write before approval (6.13). */
export const DESIGN_ONLY_REFUSAL =
    "The design is not approved, or it changed since approval. Under EGM's design-only " +
    "scope you may write only the design doc and the session's files.";

/** `.state.json` of the session, or null when it is absent or not the expected JSON. */
export function read_design_state(session_dir: string): GuardDesign | null {
    const file = join(session_dir, EGM_ARTIFACT_DIR, DESIGN_STATE_FILE);
    if (!existsSync(file)) {
        return null;
    }
    let state: unknown;
    try {
        state = JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return null;
    }
    if (typeof state !== "object" || state === null) {
        return null;
    }
    const { track, approved, designs_dir } = state as Record<string, unknown>;
    if (typeof track !== "string" || typeof approved !== "boolean") {
        return null;
    }
    const dir = typeof designs_dir === "string" && designs_dir.length > 0 ? designs_dir : null;
    return { track, approved, designs_dir: dir };
}

export type GuardVerdict = { allow: true } | { allow: false; reason: string };

export function guard_edit(input: GuardInput): GuardVerdict {
    const absolute = isAbsolute(input.path) ? input.path : resolve(input.cwd, input.path);
    const design = input.design ?? null;
    if (input.role === "lead" && design?.track === "design" && !design.approved) {
        return design_only(input.session_dir, design.designs_dir, absolute);
    }
    if (is_inside(input.session_dir, absolute)) {
        return { allow: true };
    }
    const globs = owned_globs(input.brief);
    if (globs.length === 0) {
        return { allow: true };
    }
    const candidates = [relative(input.cwd, absolute), relative(input.session_dir, absolute)]
        .map((path) => path.split(sep).join("/"))
        .filter((path) => path.length > 0 && !path.startsWith(".."));
    for (const candidate of candidates) {
        for (const glob of globs) {
            if (glob_to_regex(glob).test(candidate)) {
                return { allow: true };
            }
        }
    }
    const log = section_body(input.mission, "Log");
    const shown = candidates[0] ?? input.path;
    if (log.includes(shown) || log.includes(basename(absolute))) {
        return { allow: true };
    }
    return {
        allow: false,
        reason:
            `${shown} is outside your owned paths (${globs.join(", ")}). ` +
            "Log it first with mission_log (name the file and why) as its own step, then retry.",
    };
}

/**
 * The design-only scope. The repos' worktrees live under `<session>/worktrees/`, so the
 * session-directory exemption would let every code write through: this rule runs first and
 * counts the worktrees as code, except the designs directory.
 */
function design_only(
    session_dir: string,
    designs_dir: string | null,
    absolute: string,
): GuardVerdict {
    if (designs_dir !== null && is_inside(designs_dir, absolute)) {
        return { allow: true };
    }
    const worktrees = join(session_dir, SESSION_WORKTREES_DIR);
    if (is_inside(session_dir, absolute) && !is_inside(worktrees, absolute)) {
        return { allow: true };
    }
    return { allow: false, reason: DESIGN_ONLY_REFUSAL };
}

/** Where the daemon puts a session's worktrees (`<session>/worktrees/<repo>`). */
const SESSION_WORKTREES_DIR = "worktrees";

/** The backticked paths under `## Owns`. A trailing `/` means the directory and below. */
export function owned_globs(brief: string): string[] {
    const body = section_body(brief, "Owns");
    const globs: string[] = [];
    for (const match of body.matchAll(/`([^`\s]+)`/g)) {
        const token = match[1] ?? "";
        if (!/[/*.]/.test(token) || token.startsWith("http")) {
            continue;
        }
        globs.push(token.endsWith("/") ? `${token}**` : token);
        if (globs.length >= GLOBS_MAX) {
            break;
        }
    }
    return globs;
}

/** `**`, `*`, `?` and `{a,b}`; everything else literal. Anchored to the whole path. */
export function glob_to_regex(glob: string): RegExp {
    let pattern = "";
    for (let index = 0; index < glob.length; index += 1) {
        const char = glob[index] ?? "";
        if (char === "*") {
            if (glob[index + 1] === "*") {
                index += 1;
                if (glob[index + 1] === "/") {
                    index += 1;
                    pattern += "(?:.*/)?";
                } else {
                    pattern += ".*";
                }
            } else {
                pattern += "[^/]*";
            }
        } else if (char === "?") {
            pattern += "[^/]";
        } else if (char === "{") {
            const close = glob.indexOf("}", index);
            if (close === -1) {
                pattern += "\\{";
            } else {
                const options = glob
                    .slice(index + 1, close)
                    .split(",")
                    .map(escape);
                pattern += `(?:${options.join("|")})`;
                index = close;
            }
        } else {
            pattern += escape(char);
        }
    }
    return new RegExp(`^${pattern}$`);
}

function escape(text: string): string {
    return text.replace(/[.+^$()|[\]\\]/g, "\\$&");
}

function is_inside(parent: string, child: string): boolean {
    const rel = relative(resolve(parent), resolve(child));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
