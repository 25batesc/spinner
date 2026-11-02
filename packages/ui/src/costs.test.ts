// The cost printers as the cards, the bar and the Usage section show them: two decimals of a
// dollar, a floor under one cent, compact tokens.
import { describe, expect, it } from "vitest";

import { formatTokens, formatUsd } from "./costs.ts";

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
