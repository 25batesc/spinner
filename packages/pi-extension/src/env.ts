// What the daemon tells the extension through the environment (`EXTENSION_ENV` in the
// protocol): the session directory, the agent's name, the daemon's URL and the role. Without
// the session directory the extension is not running under Spinner and registers nothing.
import {
    EXTENSION_ENV,
    EXTENSION_ROLES,
    SUBAGENT_CHILD_ENV,
    type ExtensionRole,
} from "@spinner/protocol";

export interface SpinnerEnv {
    session_dir: string;
    /** Directory name of the session, `:dir` in the routes. */
    dir: string;
    agent: string;
    daemon_url: string;
    role: ExtensionRole;
    /** `full` when the operator's settings let the lead act on GitHub; else `guarded`. */
    github: "guarded" | "full";
    /** The EGM checkout root of a lead in an EGM session, else null. */
    egm_root: string | null;
    /** The EGM artifact directory of a lead in an EGM session, else null. */
    egm_artifacts: string | null;
}

export function read_env(env: NodeJS.ProcessEnv): SpinnerEnv | null {
    // A pi-subagents child inherits the lead's environment. It must not register the Spinner
    // tools or the prompt section: the prompt would carry MISSION.md into a Goldfish.
    if (env[SUBAGENT_CHILD_ENV] === "1") {
        return null;
    }
    const session_dir = env[EXTENSION_ENV.session_dir];
    const agent = env[EXTENSION_ENV.agent];
    if (session_dir === undefined || session_dir === "" || agent === undefined || agent === "") {
        return null;
    }
    const daemon_url = (env[EXTENSION_ENV.daemon_url] ?? "").replace(/\/+$/, "");
    const named = env[EXTENSION_ENV.role];
    const role: ExtensionRole = EXTENSION_ROLES.includes(named as ExtensionRole)
        ? (named as ExtensionRole)
        : "worker";
    const parts = session_dir.replace(/\/+$/, "").split("/");
    const dir = parts[parts.length - 1] ?? "";
    const egm_root = non_empty(env[EXTENSION_ENV.egm_root]);
    const egm_artifacts = non_empty(env[EXTENSION_ENV.egm_artifacts]);
    const github = env[EXTENSION_ENV.github] === "full" ? "full" : "guarded";
    return { session_dir, dir, agent, daemon_url, role, github, egm_root, egm_artifacts };
}

function non_empty(value: string | undefined): string | null {
    return value === undefined || value === "" ? null : value;
}
