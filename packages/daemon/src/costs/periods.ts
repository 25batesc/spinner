// Grouping cost rows by day, week and month in the daemon's local zone (MISSION.md s013,
// Contracts). Plain `Date` getters give the local calendar; weeks start on Monday. The route
// (`GET /costs`) and the `costs` event both use `report` and `period_totals`; a `LocalClock`
// lets a test pin "now".
import assert from "node:assert/strict";
import type {
    CostByAgent,
    CostByModel,
    CostBySession,
    CostGroup,
    CostPeriod,
    CostRow,
    CostTotals,
    CostsResponse,
} from "@spinner/protocol";
import { COSTS_DAYS_DEFAULT, COSTS_DAYS_MAX } from "@spinner/protocol";

export interface LocalClock {
    now: () => Date;
}

/** Pure: the sums over rows. */
export function totals_of(rows: CostRow[]): CostTotals {
    let usd = 0;
    let tokens_in = 0;
    let tokens_out = 0;
    for (const row of rows) {
        usd += row.usd;
        tokens_in += row.tokens_in;
        tokens_out += row.tokens_out;
    }
    return { usd, tokens_in, tokens_out };
}

/** `YYYY-MM-DD` of a date in the local zone. */
export function local_day(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

/** The local day a `YYYY-MM-DD` names, at its midnight; null when the text is not a date. */
export function parse_day(text: string): Date | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (match === null) {
        return null;
    }
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return local_day(date) === text ? date : null;
}

/** The period key of a row's time: the day, the Monday of its week, or the month. */
export function period_key(ts: string, group: CostGroup): string {
    const date = new Date(ts);
    if (group === "day") {
        return local_day(date);
    }
    if (group === "month") {
        return local_day(date).slice(0, 7);
    }
    return local_day(monday_of(date));
}

/** The local Monday at midnight of the week the date is in. */
export function monday_of(date: Date): Date {
    const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const weekday = (midnight.getDay() + 6) % 7;
    midnight.setDate(midnight.getDate() - weekday);
    return midnight;
}

/** Days from `from` to `to`, both local midnights, inclusive. */
export function days_between(from: Date, to: Date): number {
    const ms = to.getTime() - from.getTime();
    return Math.round(ms / 86_400_000) + 1;
}

export interface SpanInput {
    from?: string;
    to?: string;
    group?: string;
}

export interface Span {
    from: Date;
    /** The start of the day after `to`, so a row is in the span when `from <= ts < end`. */
    end: Date;
    from_key: string;
    to_key: string;
    group: CostGroup;
}

/** The query to a span, or the reason it is a 400. */
export function parse_span(input: SpanInput, clock: LocalClock): Span | string {
    const group = input.group ?? "day";
    if (group !== "day" && group !== "week" && group !== "month") {
        return "`group` must be one of day, week, month";
    }
    const to = input.to === undefined ? start_of_day(clock.now()) : parse_day(input.to);
    if (to === null) {
        return "`to` must be a date as YYYY-MM-DD";
    }
    let from: Date | null;
    if (input.from === undefined) {
        from = new Date(to);
        from.setDate(from.getDate() - (COSTS_DAYS_DEFAULT - 1));
    } else {
        from = parse_day(input.from);
    }
    if (from === null) {
        return "`from` must be a date as YYYY-MM-DD";
    }
    if (from.getTime() > to.getTime()) {
        return "`from` must not be after `to`";
    }
    if (days_between(from, to) > COSTS_DAYS_MAX) {
        return `the span must be at most ${COSTS_DAYS_MAX} days`;
    }
    const end = new Date(to);
    end.setDate(end.getDate() + 1);
    return { from, end, from_key: local_day(from), to_key: local_day(to), group };
}

function start_of_day(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Rows whose time falls in the span. */
export function rows_in(rows: CostRow[], from: Date, end: Date): CostRow[] {
    const start_ms = from.getTime();
    const end_ms = end.getTime();
    return rows.filter((row) => {
        const ms = Date.parse(row.ts);
        return ms >= start_ms && ms < end_ms;
    });
}

/** Session directory to its title, for `by_session`; the operator needs none. */
export type TitleLookup = (dir: string) => string;

export const OPERATOR_DIR_KEY = "operator";
const OPERATOR_TITLE = "Operator agent";

/** Pure: the `/costs` report over the rows in the span. */
export function report(rows: CostRow[], span: Span, title_of: TitleLookup): CostsResponse {
    const inside = rows_in(rows, span.from, span.end);
    return {
        from: span.from_key,
        to: span.to_key,
        group: span.group,
        total: totals_of(inside),
        by_period: by_period(inside, span.group),
        by_session: by_session(inside, title_of),
        by_model: by_model(inside),
        by_agent: by_agent(inside),
    };
}

function by_period(rows: CostRow[], group: CostGroup): CostPeriod[] {
    const sums = new Map<string, CostPeriod>();
    for (const row of rows) {
        const key = period_key(row.ts, group);
        const current = sums.get(key) ?? { period: key, usd: 0, tokens: 0 };
        current.usd += row.usd;
        current.tokens += row.tokens_in + row.tokens_out;
        sums.set(key, current);
    }
    return [...sums.values()].sort((a, b) => (a.period < b.period ? -1 : 1));
}

function by_session(rows: CostRow[], title_of: TitleLookup): CostBySession[] {
    const sums = new Map<string, CostBySession>();
    for (const row of rows) {
        const dir = row.session ?? OPERATOR_DIR_KEY;
        const current = sums.get(dir) ?? {
            dir,
            title: row.session === null ? OPERATOR_TITLE : title_of(dir),
            usd: 0,
            tokens: 0,
            last_active: row.ts,
        };
        current.usd += row.usd;
        current.tokens += row.tokens_in + row.tokens_out;
        if (row.ts > current.last_active) {
            current.last_active = row.ts;
        }
        sums.set(dir, current);
    }
    return [...sums.values()].sort((a, b) => b.usd - a.usd);
}

function by_model(rows: CostRow[]): CostByModel[] {
    const sums = new Map<string, CostByModel>();
    for (const row of rows) {
        const current = sums.get(row.model) ?? { model: row.model, usd: 0, tokens: 0 };
        current.usd += row.usd;
        current.tokens += row.tokens_in + row.tokens_out;
        sums.set(row.model, current);
    }
    return [...sums.values()].sort((a, b) => b.usd - a.usd);
}

function by_agent(rows: CostRow[]): CostByAgent[] {
    const sums = new Map<string, CostByAgent & { latest: string }>();
    for (const row of rows) {
        const dir = row.session ?? OPERATOR_DIR_KEY;
        const key = `${dir}/${row.agent}`;
        const current = sums.get(key) ?? {
            dir,
            agent: row.agent,
            model: null,
            usd: 0,
            tokens: 0,
            latest: "",
        };
        current.usd += row.usd;
        current.tokens += row.tokens_in + row.tokens_out;
        if (row.ts >= current.latest) {
            current.latest = row.ts;
            current.model = row.model;
        }
        sums.set(key, current);
    }
    return [...sums.values()]
        .sort((a, b) => b.usd - a.usd)
        .map((entry) => ({
            dir: entry.dir,
            agent: entry.agent,
            model: entry.model,
            usd: entry.usd,
            tokens: entry.tokens,
        }));
}

/** The figures of the `costs` event: today, the week from Monday, and the month, to now. */
export function period_totals(
    rows: CostRow[],
    clock: LocalClock,
): { today: CostTotals; week: CostTotals; month: CostTotals } {
    const now = clock.now();
    const end = new Date(now.getTime() + 1);
    const today = start_of_day(now);
    const week = monday_of(now);
    const month = new Date(now.getFullYear(), now.getMonth(), 1);
    assert.ok(week.getTime() <= today.getTime());
    return {
        today: totals_of(rows_in(rows, today, end)),
        week: totals_of(rows_in(rows, week, end)),
        month: totals_of(rows_in(rows, month, end)),
    };
}
