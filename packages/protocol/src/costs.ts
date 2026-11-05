// Costs (s013): what a session spent and what the month spent, folded from the pi transcripts.
// pi writes `usage.cost.total` and the token counts into every assistant message; the daemon
// adds them up (`packages/daemon/src/costs/ledger.ts`) and nothing else prices anything. The
// shapes here are the ledger row, the cost on a session and on the operator agent, the
// `/costs` report and the `costs` bus event.

/** One assistant message of one transcript, as the ledger keeps it. */
export interface CostRow {
    /** ISO 8601 time of the message (the transcript entry's `timestamp`). */
    ts: string;
    /** Session directory name, or null for the operator agent (`<home>/operator/pi`). */
    session: string | null;
    /** Agent name (`agents/<name>/pi`), or `operator`. */
    agent: string;
    /** `provider/model`, as pi names it. */
    model: string;
    usd: number;
    tokens_in: number;
    tokens_out: number;
    cache_read: number;
    cache_write: number;
    /** `"<runId>/<step index>"` for a row of a Goldfish transcript (T6); absent otherwise. */
    child?: string;
}

/** Sums over rows. `tokens_in` and `tokens_out` leave the cache counts out. */
export interface CostTotals {
    usd: number;
    tokens_in: number;
    tokens_out: number;
}

export interface AgentCost extends CostTotals {
    /** The model of the agent's latest assistant message, or null before its first. */
    model: string | null;
    /**
     * How full the agent's context window is (dogfood #45), from its latest assistant
     * message and that model's window. Null before the first message or while the window of
     * the model is unknown (the daemon's model list is not loaded, or pi does not know the
     * model). Optional so a fixture written before round 4 still type-checks; the daemon
     * always sets it on `SessionView.cost.agents`.
     */
    context?: AgentContext | null;
}

/** The context use of one agent: the prompt of its latest message against the window. */
export interface AgentContext {
    /** `input + cacheRead + cacheWrite` of the latest assistant message's usage. */
    tokens: number;
    /** The model's `contextWindow` from `pi --list-models`, in tokens; above 0. */
    window: number;
    /** `tokens / window` as a whole percent, rounded down; can pass 100 after a model change. */
    pct: number;
}

/** `SessionView.cost`: the session's agents summed, and each agent's share. */
export interface SessionCost extends CostTotals {
    /** Each agent's own rows; a Goldfish's rows are under `children`, not under the lead. */
    agents: Record<string, AgentCost>;
    /** Each Goldfish step's sum, keyed `"<runId>/<step index>"`. Absent without one. */
    children?: Record<string, AgentCost>;
}

/** `OperatorView.cost`: the operator agent's transcripts summed. */
export type OperatorCost = CostTotals;

export type CostGroup = "day" | "week" | "month";

/**
 * `GET /costs?from=YYYY-MM-DD&to=YYYY-MM-DD&group=day|week|month`. Dates are days in the
 * daemon's local zone, both inclusive; `to` defaults to today and `from` to 29 days before
 * `to`; a span over `COSTS_DAYS_MAX` days is a 400. `tokens` is `tokens_in + tokens_out`.
 */
export interface CostsResponse {
    from: string;
    to: string;
    group: CostGroup;
    total: CostTotals;
    /** One entry per period with a row, oldest first; `period` is a `CostPeriodKey`. */
    by_period: CostPeriod[];
    /** Sessions by cost, highest first. The operator agent is `dir: "operator"`. */
    by_session: CostBySession[];
    by_model: CostByModel[];
    by_agent: CostByAgent[];
}

/**
 * `YYYY-MM-DD` for a day, the Monday's `YYYY-MM-DD` for a week, `YYYY-MM` for a month, all
 * in the daemon's local zone.
 */
export type CostPeriodKey = string;

export interface CostPeriod {
    period: CostPeriodKey;
    usd: number;
    tokens: number;
}

export interface CostBySession {
    dir: string;
    title: string;
    usd: number;
    tokens: number;
    /** ISO 8601 time of the latest assistant message in the span. */
    last_active: string;
}

export interface CostByModel {
    model: string;
    usd: number;
    tokens: number;
}

export interface CostByAgent {
    /** Session directory, or `operator`. */
    dir: string;
    agent: string;
    model: string | null;
    usd: number;
    tokens: number;
}

export const COSTS_DAYS_MAX = 366;
export const COSTS_DAYS_DEFAULT = 30;

/** How often the ledger refolds on its own, besides on `agent.settled`. */
export const COSTS_REFOLD_INTERVAL_MS = 60_000;
