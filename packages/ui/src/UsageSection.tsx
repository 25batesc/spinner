// The Usage section of the settings view (s013): today, this week and this month, a bar
// chart by day (or week, or month) and the tables by session and by model. The report is
// `GET /costs`; the figures come from it at load and follow the `costs` bus event after.
// The chart is plain SVG, one `rect` per period.
import { useState } from "react";

import type { CostGroup, CostPeriod, CostsResponse } from "@spinner/protocol";

import {
    dayKey,
    figuresOf,
    fillPeriods,
    formatTokens,
    formatUsd,
    periodKeys,
    periodLabel,
    spanFrom,
} from "./costs.ts";
import { fetchCosts, useLoaded } from "./remote.ts";
import type { CostFigures } from "./state.ts";

export interface UsageSectionProps {
    /** The last `costs` event, or null before the first; the figures follow it. */
    live: CostFigures | null;
}

const GROUPS: CostGroup[] = ["day", "week", "month"];
const CHART_WIDTH = 300;
const CHART_HEIGHT = 80;
const BAR_GAP = 2;

/** One rect per period, scaled to the costliest; the hover value is the rect's `title`. */
export function UsageChart({ group, bars }: { group: CostGroup; bars: CostPeriod[] }) {
    const most = Math.max(0, ...bars.map((bar) => bar.usd));
    const slot = CHART_WIDTH / Math.max(1, bars.length);
    const width = Math.max(1, slot - BAR_GAP);
    const first = bars[0];
    const last = bars.at(-1);
    return (
        <figure className="usage-chart">
            <svg
                viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                width="100%"
                height={CHART_HEIGHT}
                preserveAspectRatio="none"
                role="img"
                aria-label={`Cost by ${group}`}
            >
                {bars.map((bar, index) => {
                    const height = most === 0 ? 0 : (bar.usd / most) * (CHART_HEIGHT - 2);
                    return (
                        <rect
                            key={bar.period}
                            className="usage-bar"
                            x={index * slot}
                            y={CHART_HEIGHT - height}
                            width={width}
                            height={height}
                            data-period={bar.period}
                        >
                            <title>
                                {`${periodLabel(group, bar.period)} · ${formatUsd(bar.usd)}`
                                    + ` · ${formatTokens(bar.tokens)} tokens`}
                            </title>
                        </rect>
                    );
                })}
            </svg>
            <figcaption className="muted usage-axis">
                <span>{first === undefined ? "" : periodLabel(group, first.period)}</span>
                <span>{last === undefined ? "" : periodLabel(group, last.period)}</span>
            </figcaption>
        </figure>
    );
}

/** `title`, cost, tokens and last active, by cost; the operator agent is one row of it. */
function SessionsTable({ report }: { report: CostsResponse }) {
    return (
        <table className="usage-table" aria-label="Cost by session">
            <thead>
                <tr>
                    <th>session</th>
                    <th>cost</th>
                    <th>tokens</th>
                    <th>last active</th>
                </tr>
            </thead>
            <tbody>
                {report.by_session.map((row) => (
                    <tr key={row.dir} title={row.dir}>
                        <td className="usage-title">{row.title}</td>
                        <td>{formatUsd(row.usd)}</td>
                        <td className="muted">{formatTokens(row.tokens)}</td>
                        <td className="muted" title={row.last_active}>
                            {periodLabel("day", row.last_active.slice(0, 10))}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function ModelsTable({ report }: { report: CostsResponse }) {
    return (
        <table className="usage-table" aria-label="Cost by model">
            <thead>
                <tr>
                    <th>model</th>
                    <th>cost</th>
                    <th>tokens</th>
                </tr>
            </thead>
            <tbody>
                {report.by_model.map((row) => (
                    <tr key={row.model}>
                        <td className="usage-title">{row.model}</td>
                        <td>{formatUsd(row.usd)}</td>
                        <td className="muted">{formatTokens(row.tokens)}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

/**
 * The report covers the chart's span, or the calendar month when that reaches further back,
 * so the month figure is whole; the figures are summed from day periods until the first
 * `costs` event, which carries the daemon's own figures. The chart span follows the switch.
 */
export function UsageSection({ live }: UsageSectionProps) {
    const [group, setGroup] = useState<CostGroup>("day");
    const today = new Date();
    const to = dayKey(today);
    const revision = live?.revision ?? 0;
    const chartFrom = spanFrom(group, today);
    const daysFrom = spanFrom("day", today);
    const monthFirst = new Date(today.getFullYear(), today.getMonth(), 1);
    const figuresFrom = dayKey(monthFirst < daysFrom ? monthFirst : daysFrom);
    const days = useLoaded(`costs-days#${revision}`, (signal) =>
        fetchCosts(figuresFrom, to, "day", signal),
    );
    const chart = useLoaded(`costs-${group}#${revision}`, (signal) =>
        fetchCosts(dayKey(chartFrom), to, group, signal),
    );
    const figures =
        live !== null
            ? { today: live.today.usd, week: live.week.usd, month: live.month.usd }
            : days.value === undefined
              ? null
              : figuresOf(days.value.by_period, today);
    const bars =
        chart.value === undefined
            ? []
            : fillPeriods(periodKeys(group, chartFrom, today), chart.value.by_period);
    const error = chart.error ?? days.error;
    return (
        <section className="usage-section" aria-label="Usage">
            <h3 className="usage-heading">Usage</h3>
            <dl className="usage-figures">
                {(["today", "week", "month"] as const).map((span) => (
                    <div key={span} className="usage-figure" data-span={span}>
                        <dt>{span === "today" ? "today" : `this ${span}`}</dt>
                        <dd>{figures === null ? "…" : formatUsd(figures[span])}</dd>
                    </div>
                ))}
            </dl>
            <div className="usage-switch" role="tablist" aria-label="Chart period">
                {GROUPS.map((item) => (
                    <button
                        key={item}
                        type="button"
                        role="tab"
                        aria-selected={item === group}
                        className={item === group ? "tab usage-tab tab-selected" : "tab usage-tab"}
                        onClick={() => setGroup(item)}
                    >
                        {item}
                    </button>
                ))}
            </div>
            <UsageChart group={group} bars={bars} />
            {chart.value !== undefined && <SessionsTable report={chart.value} />}
            {chart.value !== undefined && <ModelsTable report={chart.value} />}
            {error !== null && <p className="needs-human">{error}</p>}
        </section>
    );
}
