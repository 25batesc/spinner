// Which view an agent tab shows: pi's own terminal for a `tty` agent, the thin chat for an
// `rpc` agent. `?chat=1` on the page forces the chat, the old path, for any agent.
import type { AgentHarnessName, AgentSpec } from "@spinner/protocol";

/** The chip's dot: in a turn, hosted and idle, or not hosted at all. */
export type AgentState = "working" | "idle" | "off";

export function agentState(spec: AgentSpec, hosted: boolean): AgentState {
    if (!hosted) {
        return "off";
    }
    return spec.process === "running" ? "working" : "idle";
}

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
