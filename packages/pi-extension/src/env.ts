// What the daemon tells the extension through the environment (`EXTENSION_ENV` in the
// protocol): the session directory, the agent's name, the daemon's URL and the role. Without
// the session directory the extension is not running under Spinner and registers nothing.
import { EXTENSION_ENV, EXTENSION_ROLES, type ExtensionRole } from "@spinner/protocol";

export interface SpinnerEnv {
    session_dir: string;
    /** Directory name of the session, `:dir` in the routes. */
    dir: string;
    agent: string;
    daemon_url: string;
    role: ExtensionRole;
    /** True under `SPINNER_HARNESS=tty`: pi runs in the daemon's pty and the tty channel opens. */
    tty: boolean;
}

export function read_env(env: NodeJS.ProcessEnv): SpinnerEnv | null {
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
    const tty = env[EXTENSION_ENV.harness] === "tty";
    return { session_dir, dir, agent, daemon_url, role, tty };
}
