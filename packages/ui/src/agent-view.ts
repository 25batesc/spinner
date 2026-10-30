// Which view an agent tab shows: pi's own terminal for a `tty` agent, the thin chat for an
// `rpc` agent. `?chat=1` on the page forces the chat, the old path, for any agent.
import type { AgentHarnessName } from "@spinner/protocol";

/**
 * The legacy name `pi`, in files written before s009, reads as `tty`: the daemon resumes such
 * an agent with its default harness, which is `tty`, so the tab shows the terminal and its
 * "not running: resume" state rather than the chat of a process that no longer exists.
 */
export function showsTerminal(harness: AgentHarnessName, search: string): boolean {
    if (new URLSearchParams(search).get("chat") === "1") {
        return false;
    }
    return harness !== "rpc";
}
