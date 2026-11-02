// How the UI prints money and tokens (s013): pi's numbers per message, summed by the daemon.
// The pure helpers here serve the session cards, the context bar, the agent chips and the
// Usage section; the shapes they read are in `@spinner/protocol`. The period helpers mirror
// the daemon's keys (local-zone days, weeks from Monday, calendar months).
import type { CostGroup, CostPeriod } from "@spinner/protocol";

/** `$1.23`; under one cent `<$0.01`; zero as `$0.00`. */
export function formatUsd(usd: number): string {
    if (usd <= 0) {
        return "$0.00";
    }
    if (usd < 0.005) {
        return "<$0.01";
    }
    return `$${usd.toFixed(2)}`;
}

/** Compact tokens: `850`, `17.5k`, `123k`, `2.3M`; one decimal under 100 of a unit. */
export function formatTokens(tokens: number): string {
    const value = Math.max(0, tokens);
    if (value < 1000) {
        return String(Math.round(value));
    }
    const units: [number, string][] = [
        [1e9, "B"],
        [1e6, "M"],
        [1e3, "k"],
    ];
    const [size, unit] = units.find(([at]) => value >= at) ?? [1e3, "k"];
    const scaled = value / size;
    const text = scaled < 100 ? scaled.toFixed(1).replace(/\.0$/, "") : String(Math.round(scaled));
    return `${text}${unit}`;
}

/** A local-zone calendar day as `YYYY-MM-DD`, the key the daemon uses for a day period. */
export function dayKey(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
}

/** The day `days` before (or after, when negative) `date`, at the same local time. */
export function daysAgo(date: Date, days: number): Date {
    const moved = new Date(date);
    moved.setDate(moved.getDate() - days);
    return moved;
}

/** The Monday of the week of `date`, as the daemon keys a week. */
export function mondayOf(date: Date): Date {
    const monday = new Date(date);
    // getDay: Sunday is 0; the week starts on Monday, so a Sunday goes back 6 days.
    const back = (monday.getDay() + 6) % 7;
    monday.setDate(monday.getDate() - back);
    return monday;
}

/** `YYYY-MM`, the daemon's key for a month. */
export function monthKey(date: Date): string {
    return dayKey(date).slice(0, 7);
}

/** The spans the chart offers: 30 days, 12 weeks, 12 months, each ending today. */
export const CHART_SPANS: Record<CostGroup, number> = { day: 30, week: 12, month: 12 };

/** The `from` day of the chart's span for a group, `count` periods back from `today`. */
export function spanFrom(group: CostGroup, today: Date): Date {
    const count = CHART_SPANS[group];
    if (group === "day") {
        return daysAgo(today, count - 1);
    }
    if (group === "week") {
        return daysAgo(mondayOf(today), (count - 1) * 7);
    }
    const first = new Date(today.getFullYear(), today.getMonth() - (count - 1), 1);
    return first;
}

/**
 * Every period key of the span, oldest first, so the chart has one bar per period whether
 * or not the daemon listed it (it lists only periods with a row).
 */
export function periodKeys(group: CostGroup, from: Date, to: Date): string[] {
    const keys: string[] = [];
    let at = group === "week" ? mondayOf(from) : from;
    if (group === "month") {
        at = new Date(from.getFullYear(), from.getMonth(), 1);
    }
    // Bounded: the daemon caps a span at 366 days, so 400 steps covers any group.
    for (let step = 0; step < 400 && at <= to; step += 1) {
        keys.push(group === "month" ? monthKey(at) : dayKey(at));
        if (group === "day") {
            at = daysAgo(at, -1);
        } else if (group === "week") {
            at = daysAgo(at, -7);
        } else {
            at = new Date(at.getFullYear(), at.getMonth() + 1, 1);
        }
    }
    return keys;
}

/** The chart's bars: one per period key, zero where the daemon listed nothing. */
export function fillPeriods(
    keys: string[],
    listed: CostPeriod[],
): CostPeriod[] {
    const byKey = new Map(listed.map((entry) => [entry.period, entry]));
    return keys.map((period) => byKey.get(period) ?? { period, usd: 0, tokens: 0 });
}

/** The three figures of the Usage section, summed from day periods up to `today`. */
export function figuresOf(
    days: CostPeriod[],
    today: Date,
): { today: number; week: number; month: number } {
    const todayKey = dayKey(today);
    const weekKey = dayKey(mondayOf(today));
    const monthStart = `${monthKey(today)}-01`;
    const sum = (from: string) =>
        days.filter((d) => d.period >= from && d.period <= todayKey)
            .reduce((total, d) => total + d.usd, 0);
    return { today: sum(todayKey), week: sum(weekKey), month: sum(monthStart) };
}

/** The bar's label: `Nov 2` for a day, `w/c Nov 2` for a week, `Nov` for a month. */
export function periodLabel(group: CostGroup, period: string): string {
    const [year, month, day] = period.split("-").map(Number);
    const date = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
    const monthName = date.toLocaleString("en-US", { month: "short" });
    if (group === "month") {
        return monthName;
    }
    const text = `${monthName} ${date.getDate()}`;
    return group === "week" ? `w/c ${text}` : text;
}
