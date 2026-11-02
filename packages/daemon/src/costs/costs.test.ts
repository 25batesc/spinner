// Goal: the ledger folds only assistant messages with usage.cost.total out of a transcript
// (three messages, two models), reads a file again only when its size or mtime changed, sums
// a session per agent with each agent's latest model, groups rows by day, week (from Monday)
// and month in the local zone across a month boundary, and GET /costs through a daemon answers
// the report with titles and refuses a bad span. Method: fixture transcripts written under a
// scratch home, pure calls, and a daemon on port 0 with a short refold timer.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CostRow, CostsResponse, SessionView, SpinnerEvent } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { start_daemon } from "../server.js";
import { create_session } from "../store/session-store.js";
import { CostLedger, fold_transcript, session_cost_of } from "./ledger.js";
import {
    local_day,
    monday_of,
    parse_span,
    period_key,
    period_totals,
    report,
} from "./periods.js";

function entry(ts: string, message: Record<string, unknown>): string {
    return JSON.stringify({ type: "message", id: "x", parentId: null, timestamp: ts, message });
}

function assistant(
    ts: string,
    model: string,
    usd: number,
    tokens: [number, number, number, number],
): string {
    const [input, output, cache_read, cache_write] = tokens;
    return entry(ts, {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model,
        usage: {
            input,
            output,
            cacheRead: cache_read,
            cacheWrite: cache_write,
            totalTokens: input + output + cache_read + cache_write,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usd },
        },
        stopReason: "stop",
        timestamp: Date.parse(ts),
    });
}

/** Three assistant messages on two models, a user message, a tool result, a bad line. */
const TRANSCRIPT = [
    JSON.stringify({ type: "session", id: "engine", timestamp: "2026-10-30T10:00:00.000Z" }),
    entry("2026-10-30T10:00:01.000Z", { role: "user", content: "hi", timestamp: 1 }),
    assistant("2026-10-30T10:00:05.000Z", "claude-fable-5-1", 0.25, [4, 249, 0, 19238]),
    entry("2026-10-30T10:00:06.000Z", {
        role: "toolResult",
        toolCallId: "t",
        toolName: "bash",
        content: [],
        isError: false,
        timestamp: 2,
    }),
    assistant("2026-10-31T23:30:00.000Z", "claude-fable-5-1", 0.5, [100, 50, 2000, 0]),
    "{ not json",
    assistant("2026-11-01T00:30:00.000Z", "gpt-6-luna", 0.125, [10, 20, 0, 0]),
    "",
].join("\n");

const REF = { path: "/x/agents/engine/pi/a.jsonl", session: "s017-x", agent: "engine" };

describe("fold_transcript", () => {
    it("keeps the three assistant messages with their cost, tokens and provider/model", () => {
        const rows = fold_transcript(TRANSCRIPT, REF);
        expect(rows).toHaveLength(3);
        expect(rows[0]).toEqual({
            ts: "2026-10-30T10:00:05.000Z",
            session: "s017-x",
            agent: "engine",
            model: "anthropic/claude-fable-5-1",
            usd: 0.25,
            tokens_in: 4,
            tokens_out: 249,
            cache_read: 0,
            cache_write: 19238,
        });
        expect(rows[2]?.model).toBe("anthropic/gpt-6-luna");
        expect(rows.map((row) => row.usd)).toEqual([0.25, 0.5, 0.125]);
    });

    it("sums a session per agent and names each agent's latest model", () => {
        const rows = [
            ...fold_transcript(TRANSCRIPT, REF),
            ...fold_transcript(
                assistant("2026-11-02T09:00:00.000Z", "claude-fable-5-1", 1, [1, 2, 0, 0]),
                { ...REF, agent: "ui" },
            ),
        ];
        const cost = session_cost_of(rows);
        expect(cost.usd).toBeCloseTo(1.875, 6);
        expect(cost.tokens_in).toBe(115);
        expect(cost.tokens_out).toBe(321);
        expect(cost.agents["engine"]).toEqual({
            usd: 0.875,
            tokens_in: 114,
            tokens_out: 319,
            model: "anthropic/gpt-6-luna",
        });
        expect(cost.agents["ui"]?.model).toBe("anthropic/claude-fable-5-1");
    });
});

describe("CostLedger cache", () => {
    let root: string | null = null;

    afterEach(() => {
        if (root !== null) {
            rmSync(root, { recursive: true, force: true });
            root = null;
        }
    });

    it("folds live, archived and operator transcripts; rereads only a changed file", () => {
        root = mkdtempSync(join(tmpdir(), "spinner-costs-"));
        const home = resolve_home({ SPINNER_HOME: root });
        const live = join(home.sessions, "s017-x", "agents", "engine", "pi");
        const archived = join(home.archive, "s002-old", "agents", "ui", "pi");
        const operator = join(root, "operator", "pi");
        for (const dir of [live, archived, operator]) {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(join(live, "a.jsonl"), TRANSCRIPT);
        writeFileSync(
            join(archived, "b.jsonl"),
            assistant("2026-09-01T12:00:00.000Z", "claude-fable-5-1", 2, [1, 1, 0, 0]),
        );
        writeFileSync(
            join(operator, "c.jsonl"),
            assistant("2026-10-31T12:00:00.000Z", "claude-fable-5-1", 0.3, [5, 5, 0, 0]),
        );
        const ledger = new CostLedger(home);
        expect([...ledger.refold()].sort()).toEqual([null, "s002-old", "s017-x"].sort());
        expect(ledger.files()).toHaveLength(3);
        expect(ledger.session_cost("s017-x").usd).toBeCloseTo(0.875, 6);
        expect(ledger.session_cost("s002-old").usd).toBe(2);
        expect(ledger.operator_cost()).toEqual({ usd: 0.3, tokens_in: 5, tokens_out: 5 });
        expect(ledger.session_cost("s999-none")).toEqual({
            usd: 0,
            tokens_in: 0,
            tokens_out: 0,
            agents: {},
        });

        // Nothing changed: no session is reported.
        expect(ledger.refold().size).toBe(0);

        // The same size with a new mtime is a reread; a grown file too.
        utimesSync(join(live, "a.jsonl"), new Date(), new Date(Date.now() + 5_000));
        expect([...ledger.refold()]).toEqual(["s017-x"]);
        writeFileSync(
            join(live, "a.jsonl"),
            `${TRANSCRIPT}\n` +
                `${assistant("2026-11-02T10:00:00.000Z", "gpt-6-luna", 1, [1, 1, 0, 0])}\n`,
        );
        expect([...ledger.refold()]).toEqual(["s017-x"]);
        expect(ledger.session_cost("s017-x").usd).toBeCloseTo(1.875, 6);

        // A removed transcript drops its rows and names the session.
        rmSync(join(archived, "b.jsonl"));
        expect([...ledger.refold()]).toEqual(["s002-old"]);
        expect(ledger.session_cost("s002-old").usd).toBe(0);
        expect(ledger.files()).toHaveLength(2);
    });
});

describe("periods in the local zone", () => {
    const rows: CostRow[] = fold_transcript(TRANSCRIPT, REF);

    it("keys a row by its local day, Monday and month", () => {
        const ts = "2026-10-31T23:30:00.000Z";
        const local = new Date(ts);
        expect(period_key(ts, "day")).toBe(local_day(local));
        expect(period_key(ts, "month")).toBe(local_day(local).slice(0, 7));
        const monday = monday_of(local);
        expect(monday.getDay()).toBe(1);
        expect(period_key(ts, "week")).toBe(local_day(monday));
        expect(monday.getTime()).toBeLessThanOrEqual(local.getTime());
        expect(local.getTime() - monday.getTime()).toBeLessThan(7 * 86_400_000);
    });

    it("groups the fixture across the October/November boundary by month and by day", () => {
        const span = parse_span(
            { from: "2026-10-01", to: "2026-11-30", group: "month" },
            { now: () => new Date("2026-11-15T12:00:00") },
        );
        expect(typeof span).not.toBe("string");
        if (typeof span === "string") {
            return;
        }
        const monthly = report(rows, span, (dir) => `Title of ${dir}`);
        const months = Object.fromEntries(monthly.by_period.map((p) => [p.period, p.usd]));
        // The third message is 00:30 UTC on 1 Nov: October west of UTC, November at or east.
        const third_month = period_key("2026-11-01T00:30:00.000Z", "month");
        const second_month = period_key("2026-10-31T23:30:00.000Z", "month");
        const expected_months = [...new Set([second_month, third_month, "2026-10"])].sort();
        expect(Object.keys(months).sort()).toEqual(expected_months);
        expect(monthly.total).toEqual({ usd: 0.875, tokens_in: 114, tokens_out: 319 });
        expect(monthly.by_session).toEqual([
            {
                dir: "s017-x",
                title: "Title of s017-x",
                usd: 0.875,
                tokens: 433,
                last_active: "2026-11-01T00:30:00.000Z",
            },
        ]);
        expect(monthly.by_model.map((m) => m.model)).toEqual([
            "anthropic/claude-fable-5-1",
            "anthropic/gpt-6-luna",
        ]);
        expect(monthly.by_agent[0]).toEqual({
            dir: "s017-x",
            agent: "engine",
            model: "anthropic/gpt-6-luna",
            usd: 0.875,
            tokens: 433,
        });

        const daily = parse_span(
            { from: "2026-10-30", to: "2026-11-02", group: "day" },
            { now: () => new Date("2026-11-15T12:00:00") },
        );
        if (typeof daily === "string") {
            throw new Error(daily);
        }
        const by_day = report(rows, daily, () => "t").by_period;
        expect(by_day.length).toBeGreaterThanOrEqual(2);
        expect(by_day.reduce((sum, p) => sum + p.usd, 0)).toBeCloseTo(0.875, 6);
        expect(by_day.map((p) => p.period)).toEqual([...by_day.map((p) => p.period)].sort());
    });

    it("parses the span with defaults and bounds", () => {
        const clock = { now: () => new Date("2026-11-15T12:00:00") };
        const defaults = parse_span({}, clock);
        if (typeof defaults === "string") {
            throw new Error(defaults);
        }
        expect(defaults.to_key).toBe("2026-11-15");
        expect(defaults.from_key).toBe("2026-10-17");
        expect(defaults.group).toBe("day");
        expect(parse_span({ from: "2026-11-16", to: "2026-11-15" }, clock)).toMatch(/not be after/);
        expect(parse_span({ from: "2025-01-01", to: "2026-11-15" }, clock)).toMatch(/366 days/);
        expect(parse_span({ from: "2026-13-01" }, clock)).toMatch(/YYYY-MM-DD/);
        expect(parse_span({ group: "year" }, clock)).toMatch(/group/);
    });

    it("period_totals gives today, the week from Monday and the month up to now", () => {
        const now = new Date("2026-11-04T15:00:00"); // a Wednesday in local time
        const sample: CostRow[] = [
            { ...rows[0]!, ts: new Date("2026-11-04T09:00:00").toISOString(), usd: 1 },
            { ...rows[0]!, ts: new Date("2026-11-02T09:00:00").toISOString(), usd: 2 },
            { ...rows[0]!, ts: new Date("2026-11-01T09:00:00").toISOString(), usd: 4 },
            { ...rows[0]!, ts: new Date("2026-10-31T09:00:00").toISOString(), usd: 8 },
            { ...rows[0]!, ts: new Date("2026-11-04T16:00:00").toISOString(), usd: 16 },
        ];
        const figures = period_totals(sample, { now: () => now });
        expect(figures.today.usd).toBe(1);
        expect(figures.week.usd).toBe(3);
        expect(figures.month.usd).toBe(7);
    });
});

describe("GET /costs through the daemon", () => {
    it("reports with session titles, publishes costs, refuses a bad span", async () => {
        const root = mkdtempSync(join(tmpdir(), "spinner-costs-route-"));
        const home: SpinnerHome = resolve_home({ SPINNER_HOME: join(root, "home") });
        mkdirSync(home.root, { recursive: true });
        const summary = create_session(home, { title: "Refund flow" });
        const pi = join(summary.path, "agents", "engine", "pi");
        mkdirSync(pi, { recursive: true });
        // A minute ago: on today's local day, and before "now" for the event's `today` figure.
        const today = new Date(Date.now() - 60_000);
        writeFileSync(
            join(pi, "engine.jsonl"),
            `${assistant(today.toISOString(), "claude-fable-5-1", 0.75, [10, 20, 0, 0])}\n`,
        );
        const daemon = await start_daemon({
            home,
            port: 0,
            log: () => undefined,
            poll_seconds: 0,
            notify: async () => undefined,
            ui_dir: null,
            observe_interval_ms: 60_000,
            usage_interval_ms: 60_000,
            costs_refold_ms: 60_000,
            operator: false,
            pi: "/bin/false",
            cwd: root,
        });
        const events: SpinnerEvent[] = [];
        daemon.bus.subscribe((event) => events.push(event));
        try {
            const base = `http://127.0.0.1:${daemon.port}`;
            const response = await fetch(`${base}/costs`);
            expect(response.status).toBe(200);
            const body = (await response.json()) as CostsResponse;
            expect(body.group).toBe("day");
            expect(body.total.usd).toBe(0.75);
            expect(body.by_session).toEqual([
                {
                    dir: summary.dir,
                    title: "Refund flow",
                    usd: 0.75,
                    tokens: 30,
                    last_active: today.toISOString(),
                },
            ]);
            expect(body.by_period).toEqual([{ period: local_day(today), usd: 0.75, tokens: 30 }]);

            const view = await fetch(`${base}/sessions/${summary.dir}`);
            const session = ((await view.json()) as { session: SessionView }).session;
            expect(session.cost).toEqual({
                usd: 0.75,
                tokens_in: 10,
                tokens_out: 20,
                agents: {
                    engine: {
                        usd: 0.75,
                        tokens_in: 10,
                        tokens_out: 20,
                        model: "anthropic/claude-fable-5-1",
                    },
                },
            });

            // A new turn lands and the agent settles: the ledger refolds and publishes costs.
            writeFileSync(
                join(pi, "engine.jsonl"),
                `${assistant(today.toISOString(), "claude-fable-5-1", 0.75, [10, 20, 0, 0])}\n` +
                    `${assistant(new Date().toISOString(), "gpt-6-luna", 0.25, [1, 1, 0, 0])}\n`,
            );
            daemon.bus.publish({
                type: "agent.settled",
                ts: new Date().toISOString(),
                session: summary.dir,
                agent: "engine",
            });
            const published = events.filter((event) => event.type === "costs");
            expect(published).toHaveLength(1);
            expect(published[0]).toMatchObject({
                type: "costs",
                session: null,
                today: { usd: 1 },
                changed: { [summary.dir]: { usd: 1 } },
            });
            const updated = events.filter(
                (event) => event.type === "session.updated" && event.session === summary.dir,
            );
            expect(updated.length).toBeGreaterThanOrEqual(1);

            const bad = await fetch(`${base}/costs?from=2026-11-02&to=2026-11-01`);
            expect(bad.status).toBe(400);
            const wide = await fetch(`${base}/costs?from=2020-01-01`);
            expect(wide.status).toBe(400);
        } finally {
            await daemon.close();
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);
});
