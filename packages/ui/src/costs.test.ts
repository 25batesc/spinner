// The cost printers as the cards, the bar and the Usage section show them: two decimals of a
// dollar, a floor under one cent, compact tokens.
import { describe, expect, it } from "vitest";

import {
    dayKey,
    figuresOf,
    fillPeriods,
    formatTokens,
    formatUsd,
    mondayOf,
    monthKey,
    periodKeys,
    periodLabel,
    spanFrom,
} from "./costs.ts";

describe("formatUsd", () => {
    it("prints two decimals", () => {
        expect(formatUsd(1.234)).toBe("$1.23");
        expect(formatUsd(12)).toBe("$12.00");
        expect(formatUsd(0.005)).toBe("$0.01");
    });

    it("floors a fraction of a cent and keeps zero as zero", () => {
        expect(formatUsd(0.0049)).toBe("<$0.01");
        expect(formatUsd(0)).toBe("$0.00");
        expect(formatUsd(-1)).toBe("$0.00");
    });
});

describe("formatTokens", () => {
    it("prints whole tokens under a thousand and compact units above", () => {
        expect(formatTokens(0)).toBe("0");
        expect(formatTokens(850.4)).toBe("850");
        expect(formatTokens(1000)).toBe("1k");
        expect(formatTokens(99_960)).toBe("100k");
        expect(formatTokens(17_500)).toBe("17.5k");
        expect(formatTokens(17_540)).toBe("17.5k");
        expect(formatTokens(123_456)).toBe("123k");
        expect(formatTokens(2_300_000)).toBe("2.3M");
        expect(formatTokens(4.2e9)).toBe("4.2B");
    });
});

describe("the chart's periods", () => {
    // A Sunday, so the week's Monday is six days back and the month has a short tail.
    const today = new Date(2026, 10, 1, 15, 30);

    it("keys days, Mondays and months as the daemon does", () => {
        expect(dayKey(today)).toBe("2026-11-01");
        expect(dayKey(mondayOf(today))).toBe("2026-10-26");
        expect(dayKey(mondayOf(new Date(2026, 9, 26)))).toBe("2026-10-26");
        expect(monthKey(today)).toBe("2026-11");
    });

    it("spans 30 days, 12 weeks or 12 months back from today", () => {
        expect(dayKey(spanFrom("day", today))).toBe("2026-10-03");
        expect(dayKey(spanFrom("week", today))).toBe("2026-08-10");
        expect(dayKey(spanFrom("month", today))).toBe("2025-12-01");
    });

    it("lists one key per period of the span, oldest first", () => {
        const days = periodKeys("day", spanFrom("day", today), today);
        expect(days).toHaveLength(30);
        expect(days[0]).toBe("2026-10-03");
        expect(days.at(-1)).toBe("2026-11-01");
        const weeks = periodKeys("week", spanFrom("week", today), today);
        expect(weeks).toHaveLength(12);
        expect(weeks.at(-1)).toBe("2026-10-26");
        const months = periodKeys("month", spanFrom("month", today), today);
        expect(months).toEqual([
            "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06",
            "2026-07", "2026-08", "2026-09", "2026-10", "2026-11",
        ]);
    });

    it("fills the periods the daemon left out with zero bars", () => {
        const bars = fillPeriods(["2026-10-30", "2026-10-31", "2026-11-01"], [
            { period: "2026-10-31", usd: 2.5, tokens: 1000 },
        ]);
        expect(bars.map((b) => b.usd)).toEqual([0, 2.5, 0]);
    });

    it("sums today, the week from Monday and the calendar month", () => {
        const days = [
            { period: "2026-10-25", usd: 100, tokens: 0 },
            { period: "2026-10-26", usd: 10, tokens: 0 },
            { period: "2026-10-31", usd: 1, tokens: 0 },
            { period: "2026-11-01", usd: 0.5, tokens: 0 },
            { period: "2026-11-02", usd: 1000, tokens: 0 },
        ];
        expect(figuresOf(days, today)).toEqual({ today: 0.5, week: 11.5, month: 0.5 });
    });

    it("labels a bar by its group", () => {
        expect(periodLabel("day", "2026-11-01")).toBe("Nov 1");
        expect(periodLabel("week", "2026-10-26")).toBe("w/c Oct 26");
        expect(periodLabel("month", "2026-11")).toBe("Nov");
    });
});
