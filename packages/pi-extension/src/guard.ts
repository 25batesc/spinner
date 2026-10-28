// The out-of-area edit guard (docs/SESSION_PROTOCOL.md, "Hooks"): an `edit` or `write` whose
// path is outside the globs under `## Owns` in the agent's brief is blocked until a Log line
// in MISSION.md names the file, which is the protocol's "log it first". Paths inside the
// session directory are exempt (the mission, notes, artifacts). A brief without globs
// disables the guard, because there is nothing to check against.
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { section_body } from "./prompt.js";

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
}

export type GuardVerdict = { allow: true } | { allow: false; reason: string };

export function guard_edit(input: GuardInput): GuardVerdict {
    const absolute = isAbsolute(input.path) ? input.path : resolve(input.cwd, input.path);
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
