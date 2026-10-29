// Which view an agent tab shows: pi's own terminal for a `tty` agent, the thin chat for an
// `rpc` agent. `?chat=1` on the page forces the chat, the old path, for any agent.
import type { AgentHarnessName } from "@spinner/protocol";

/** The legacy name `pi`, in files written before s009, reads as `rpc` (Contracts, 16:20). */
export function showsTerminal(harness: AgentHarnessName, search: string): boolean {
    if (new URLSearchParams(search).get("chat") === "1") {
        return false;
    }
    return harness === "tty";
}
