// Resolves the `<session>` argument the stack commands take: a directory name or an id.
import { find_session, type SpinnerHome } from "@spinner/daemon";
import type { SessionSummary } from "@spinner/protocol";
import type { CliIo } from "./command.js";

/** Returns the session, or prints the error and returns null. */
export function session_arg(
    command: string,
    name: string | undefined,
    home: SpinnerHome,
    io: CliIo,
): SessionSummary | null {
    if (name === undefined) {
        io.err(`spinner ${command}: a session is required (its id or directory name)`);
        return null;
    }
    const summary = find_session(home, name);
    if (summary === null) {
        io.err(`spinner ${command}: no session "${name}" under ${home.sessions}`);
    }
    return summary;
}
