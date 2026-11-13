// Which view an agent tab shows: pi's own terminal for a `tty` agent, the thin chat for an
// `rpc` agent. `?chat=1` on the page forces the chat, the old path, for any agent.
import type { AgentContext, AgentHarnessName, AgentSpec, SessionView } from "@spinner/protocol";

import { formatTokens } from "./costs.ts";

/** The chip's dot: in a turn, hosted and idle, or not hosted at all. */
export type AgentState = "working" | "idle" | "off";

export function agentState(spec: AgentSpec, hosted: boolean): AgentState {
    if (!hosted) {
        return "off";
    }
    return spec.process === "running" ? "working" : "idle";
}

/**
 * The bands of an agent's context use (dogfood row 45). Under 40 % the chip stays quiet: a
 * figure on every chip would be noise. From 50 % pi starts to lose detail in long turns, so
 * the figure turns amber; from 75 % an automatic compaction is near, so it turns red.
 */
export const CONTEXT_SHOWN_PCT = 40;
export const CONTEXT_WARN_PCT = 50;
export const CONTEXT_FAIL_PCT = 75;

/** The pill tone of a shown figure: the `pill-warn` and `pill-fail` classes, or plain. */
export type ContextTone = "plain" | "warn" | "fail";

/** The figure's tone, or null when the chip shows no figure (unknown, or under 40 %). */
export function contextTone(context: AgentContext | null | undefined): ContextTone | null {
    if (context === null || context === undefined) {
        return null;
    }
    if (context.pct < CONTEXT_SHOWN_PCT) {
        return null;
    }
    if (context.pct < CONTEXT_WARN_PCT) {
        return "plain";
    }
    return context.pct < CONTEXT_FAIL_PCT ? "warn" : "fail";
}

/** `52 %`: the figure on the chip. */
export function contextLabel(context: AgentContext): string {
    return `${context.pct} %`;
}

/** `52 % of 1M context (523k tokens)`: the figure's tooltip. */
export function contextTitle(context: AgentContext): string {
    const window = formatTokens(context.window);
    return `${contextLabel(context)} of ${window} context (${formatTokens(context.tokens)} tokens)`;
}

/**
 * The session's fullest agent, for the session card and the context bar: the highest `pct`
 * among the agents with a known figure, the first in the record on a tie; null without one.
 */
export function fullestContext(
    view: SessionView,
): { name: string; context: AgentContext } | null {
    let fullest: { name: string; context: AgentContext } | null = null;
    for (const [name, cost] of Object.entries(view.cost?.agents ?? {})) {
        const context = cost.context;
        if (context === null || context === undefined) {
            continue;
        }
        if (fullest === null || context.pct > fullest.context.pct) {
            fullest = { name, context };
        }
    }
    return fullest;
}

/** The surface an agent's tab opens on (docs/designs/talk-change-ship.md, 5.1). */
export type AgentSurface = "chat" | "terminal";

export const SURFACE_KEY = "spinner.agent-surface.v1";

/** The subset of `Storage` the surface record needs, so tests pass a plain object. */
export interface SurfaceStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

/** The operator's last pick; `chat` before one, and when the storage cannot be read. */
export function loadSurface(storage: SurfaceStorage | null): AgentSurface {
    try {
        return storage?.getItem(SURFACE_KEY) === "terminal" ? "terminal" : "chat";
    } catch {
        return "chat";
    }
}

export function saveSurface(storage: SurfaceStorage | null, surface: AgentSurface): void {
    try {
        storage?.setItem(SURFACE_KEY, surface);
    } catch {
        // A full or blocked storage: the pick holds for this page only.
    }
}

/**
 * The tabs of an agent and the one that shows: `chat` first, `terminal` for an agent with
 * one, `context`. A pick of `terminal` on an agent without one shows the chat.
 */
export function agentTabs(
    has_terminal: boolean,
    picked: string,
): { labels: string[]; shown: string } {
    const labels = has_terminal ? ["chat", "terminal", "context"] : ["chat", "context"];
    return { labels, shown: labels.includes(picked) ? picked : "chat" };
}

/**
 * Whether the agent has a terminal tab. The legacy name `pi`, in files written before s009,
 * reads as `tty`: the daemon resumes such an agent with its default harness, which is `tty`.
 * `?chat=1` on the page hides every terminal tab.
 */
export function showsTerminal(harness: AgentHarnessName, search: string): boolean {
    if (new URLSearchParams(search).get("chat") === "1") {
        return false;
    }
    return harness !== "rpc";
}
