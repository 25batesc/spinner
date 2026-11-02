// Made-up costs for the fixture (s013): a deterministic amount per local-zone day over the
// last year, so `GET /costs` answers the same report on every run, and a cost per session
// and agent that the cards and chips show. The keys follow the daemon: `YYYY-MM-DD` for a
// day, the Monday's date for a week, `YYYY-MM` for a month.
import type {
    CostGroup,
    CostPeriod,
    CostsResponse,
    OperatorCost,
    Session,
    SessionCost,
    SessionView,
} from "@spinner/protocol";

const MODELS = ["anthropic/claude-fable-5-1", "anthropic/claude-sonnet-5-5"];

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

export function dayKey(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDay(key: string): Date | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (match === null) {
        return null;
    }
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** The period key of a day for a group. */
function periodOf(date: Date, group: CostGroup): string {
    if (group === "day") {
        return dayKey(date);
    }
    if (group === "month") {
        return dayKey(date).slice(0, 7);
    }
    const monday = new Date(date);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    return dayKey(monday);
}

/** A day's spend: a wave over the month, nothing on the 7th and the 21st, more on the 1st. */
export function dailyUsd(date: Date): number {
    const day = date.getDate();
    if (day === 7 || day === 21) {
        return 0;
    }
    const wave = 1 + Math.sin((day / 31) * Math.PI * 2);
    return Number((0.4 + wave * 2.1 + (day === 1 ? 5 : 0)).toFixed(4));
}

/** Tokens for a day's spend: a steady rate, so the token column tracks the cost column. */
function tokensFor(usd: number): number {
    return Math.round(usd * 41_000);
}

/** The fixture's per-session cost: each agent a slice of the session's id number. */
export function sessionCost(base: Session): SessionCost {
    const seed = Number(base.id.replace(/\D/g, "")) || 1;
    const names = Object.keys(base.agents);
    const agents = Object.fromEntries(
        names.map((name, index) => {
            const usd = Number(((seed % 7) * 0.37 + index * 0.81 + 0.12).toFixed(4));
            return [name, {
                usd, tokens_in: tokensFor(usd) * 3, tokens_out: tokensFor(usd) / 4,
                model: MODELS[index % MODELS.length] ?? null,
            }];
        }),
    );
    const entries = Object.values(agents);
    return {
        usd: entries.reduce((sum, a) => sum + a.usd, 0),
        tokens_in: entries.reduce((sum, a) => sum + a.tokens_in, 0),
        tokens_out: entries.reduce((sum, a) => sum + a.tokens_out, 0),
        agents,
    };
}

export const OPERATOR_COST: OperatorCost = { usd: 0.42, tokens_in: 12_300, tokens_out: 3_100 };

/** The `today`, `week` and `month` totals as the `costs` event carries them. */
export function figuresAt(today: Date): { today: number; week: number; month: number } {
    const sum = (from: Date) => {
        let total = 0;
        for (const at = new Date(from); at <= today; at.setDate(at.getDate() + 1)) {
            total += dailyUsd(at);
        }
        return total;
    };
    const monday = new Date(today);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    return { today: dailyUsd(today), week: sum(monday), month: sum(first) };
}

/**
 * `GET /costs`: the report over `from`..`to` (both inclusive, local days; `to` defaults to
 * today and `from` to 29 days before it), or the status and error the daemon would answer.
 */
export function costsReport(
    query: URLSearchParams,
    sessions: SessionView[],
    today: Date = new Date(),
): { status: number; body: CostsResponse | { error: string } } {
    const groupText = query.get("group") ?? "day";
    if (groupText !== "day" && groupText !== "week" && groupText !== "month") {
        return { status: 400, body: { error: `group must be day, week or month` } };
    }
    const group: CostGroup = groupText;
    const to = query.get("to") === null ? today : parseDay(query.get("to") ?? "");
    const from = query.get("from") === null
        ? (to === null ? null : new Date(to.getFullYear(), to.getMonth(), to.getDate() - 29))
        : parseDay(query.get("from") ?? "");
    if (from === null || to === null) {
        return { status: 400, body: { error: "from and to must be YYYY-MM-DD" } };
    }
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (days < 1) {
        return { status: 400, body: { error: "from must not be after to" } };
    }
    if (days > 366) {
        return { status: 400, body: { error: "a span is at most 366 days" } };
    }
    const periods = new Map<string, CostPeriod>();
    let total = 0;
    for (const at = new Date(from); at <= to; at.setDate(at.getDate() + 1)) {
        const usd = dailyUsd(at);
        if (usd === 0) {
            continue;
        }
        total += usd;
        const key = periodOf(at, group);
        const known = periods.get(key) ?? { period: key, usd: 0, tokens: 0 };
        periods.set(key, {
            period: key, usd: known.usd + usd, tokens: known.tokens + tokensFor(usd),
        });
    }
    // The sessions split the span's total in proportion to their own cost; the operator
    // agent takes a fixed slice.
    const own = sessions.map((view) => ({ view, usd: view.cost?.usd ?? 0 }));
    const ownTotal = own.reduce((sum, item) => sum + item.usd, 0) + OPERATOR_COST.usd;
    const share = (usd: number) => (ownTotal === 0 ? 0 : (usd / ownTotal) * total);
    const by_session = [
        ...own.map(({ view, usd }) => ({
            dir: view.summary.dir, title: view.summary.session.title, usd: share(usd),
            tokens: tokensFor(share(usd)), last_active: new Date(to).toISOString(),
        })),
        {
            dir: "operator", title: "Operator agent", usd: share(OPERATOR_COST.usd),
            tokens: tokensFor(share(OPERATOR_COST.usd)), last_active: new Date(to).toISOString(),
        },
    ].sort((a, b) => b.usd - a.usd);
    const by_agent = own.flatMap(({ view }) =>
        Object.entries(view.cost?.agents ?? {}).map(([agent, cost]) => ({
            dir: view.summary.dir, agent, model: cost.model, usd: share(cost.usd),
            tokens: tokensFor(share(cost.usd)),
        })),
    ).sort((a, b) => b.usd - a.usd);
    const by_model = MODELS.map((model, index) => {
        const usd = total * (index === 0 ? 0.7 : 0.3);
        return { model, usd, tokens: tokensFor(usd) };
    });
    const tokens = [...periods.values()].reduce((sum, p) => sum + p.tokens, 0);
    return {
        status: 200,
        body: {
            from: dayKey(from), to: dayKey(to), group,
            total: { usd: total, tokens_in: Math.round(tokens * 0.8), tokens_out: tokens
                - Math.round(tokens * 0.8) },
            by_period: [...periods.values()],
            by_session, by_model, by_agent,
        },
    };
}
