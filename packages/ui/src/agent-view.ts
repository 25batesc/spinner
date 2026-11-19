// What the agent rows and the chat say about an agent: its name, and how full its context is.
import {
    ASSISTANT_NAME,
    LEAD_NAME,
    type AgentContext,
    type AgentSpec,
    type SessionView,
} from "@spinner/protocol";

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

/**
 * The name the app shows for an agent: the session's lead is `ASSISTANT_NAME` (Remy), the
 * one the operator talks to; every other agent keeps the name its brief gave it.
 */
export function agentLabel(name: string): string {
    return name === LEAD_NAME ? ASSISTANT_NAME : name;
}
