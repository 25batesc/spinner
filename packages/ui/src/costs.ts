// How the UI prints money and tokens (s013): pi's numbers per message, summed by the daemon.
// The pure helpers here serve the session cards, the context bar, the agent chips and the
// Usage section; the shapes they read are in `@spinner/protocol`.

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
