// Goal: a compaction is visible and loses nothing. While pi compacts it takes no prompt; the
// daemon holds a message sent then and delivers it when the compaction ends, the transcript
// page says `compacting`, and the chat gets the start and the end as numbered events with
// the token figures alone. A compaction pi refuses at once (nothing to compact) is a 400
// from the route's handle, not a `started` that never ends. Method: a real daemon on port 0
// with the fake rpc pi, whose compaction takes 300 ms and refuses prompts meanwhile, and the
// harness alone for the refusal.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTranscriptResponse, PiEvent, SpinnerEvent } from "@spinner/protocol";
import { EventBus } from "../event-bus.js";
import { resolve_home, type SpinnerHome } from "../home.js";
import { start_daemon, type Daemon } from "../server.js";
import { create_session } from "../store/session-store.js";
import { PiRpcHarness } from "./harness.js";
import { AgentManager } from "./manager.js";
import { PiRefusal } from "./pi-rpc.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(here, "..", "..", "test", "fixtures", "fake-pi.ts");

let root: string;
let home: SpinnerHome;

beforeEach(() => {
    chmodSync(FAKE_PI, 0o755);
    root = mkdtempSync(join(tmpdir(), "spinner-compaction-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home") });
    mkdirSync(home.root, { recursive: true });
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

async function until(check: () => boolean): Promise<void> {
    for (let poll = 0; poll < 500; poll += 1) {
        if (check()) {
            return;
        }
        await new Promise((resolve_) => setTimeout(resolve_, 10));
    }
    throw new Error("condition not met in time");
}

describe("a compaction through the daemon", () => {
    let daemon: Daemon;
    let events: SpinnerEvent[];
    let route: string;

    beforeEach(async () => {
        daemon = await start_daemon({
            home,
            port: 0,
            log: () => undefined,
            poll_seconds: 0,
            notify: async () => undefined,
            ui_dir: null,
            observe_interval_ms: 60_000,
            pi: FAKE_PI,
            extension: null,
            cwd: root,
        });
        events = [];
        daemon.bus.subscribe((event) => events.push(event));
        const summary = create_session(home, { title: "Compaction" });
        mkdirSync(join(summary.path, "agents", "lead"), { recursive: true });
        writeFileSync(join(summary.path, "agents", "lead", "BRIEF.md"), "# lead\n");
        route = `/sessions/${summary.dir}/agents/lead`;
        const added = await call("POST", `/sessions/${summary.dir}/agents`, { name: "lead" });
        expect(added.status).toBe(201);
        await until(() => events.some((event) => event.type === "agent.settled"));
        events.length = 0;
    });

    afterEach(async () => {
        await daemon.close();
    });

    function call(method: string, path: string, body?: unknown): Promise<Response> {
        return fetch(`http://127.0.0.1:${daemon.port}${path}`, {
            method,
            headers: { "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    }

    /** The numbered events: what a chat gets. */
    function chat_events(): PiEvent[] {
        return events.flatMap((event) =>
            event.type === "agent.event" && event.seq !== undefined ? [event.event] : [],
        );
    }

    async function page(): Promise<AgentTranscriptResponse> {
        return (await (await call("GET", `${route}/transcript`)).json()) as AgentTranscriptResponse;
    }

    it("holds a message sent during the compaction and delivers it at its end", async () => {
        // The route answers when pi had a moment to refuse, or the compaction is over; the
        // fake's takes 300 ms, so the request is left open while the test looks.
        const compacted = call("POST", `${route}/compact`);
        await until(() => chat_events().some((event) => event.type === "compaction_start"));
        expect((await page()).compacting).toBe(true);

        // pi would refuse this prompt; the daemon keeps it and says so.
        const sent = await call("POST", `${route}/prompt`, {
            text: "after the compaction",
            source: "operator",
        });
        expect(sent.status).toBe(200);
        expect(await sent.json()).toEqual({ ok: true, disposition: "held" });

        await until(() => chat_events().some((event) => event.type === "compaction_end"));
        expect((await compacted).status).toBe(200);
        // The chat gets the two figures, not the summary text.
        const end = chat_events().find((event) => event.type === "compaction_end");
        expect(end).toMatchObject({
            aborted: false,
            result: { tokensBefore: 9000, estimatedTokensAfter: 1200 },
        });
        expect(JSON.stringify(end)).not.toContain("summary");

        // The held message is delivered as a turn, once, and nothing says it failed.
        await until(() => events.some((event) => event.type === "agent.settled"));
        const said = chat_events().flatMap((event) =>
            event.type === "message_end" ? [JSON.stringify(event.message.content)] : [],
        );
        expect(said.filter((text) => text.includes("echo: after the compaction"))).toHaveLength(1);
        expect(chat_events().some((event) => event.type === "ui_notify")).toBe(false);
        const after = await page();
        expect(after.compacting).toBe(false);
        // The page keeps the end, so a chat that opens later still shows what happened.
        expect(after.events.some((event) => event.type === "compaction_end")).toBe(true);
    }, 30_000);
});

describe("a compaction pi refuses", () => {
    it("rejects at once with pi's reason, and still takes a prompt", async () => {
        const summary = create_session(home, { title: "Refused" });
        mkdirSync(join(summary.path, "agents", "lead"), { recursive: true });
        writeFileSync(join(summary.path, "agents", "lead", "BRIEF.md"), "# lead\n");
        const bus = new EventBus();
        let settled = 0;
        bus.subscribe((event) => {
            settled += event.type === "agent.settled" ? 1 : 0;
        });
        const harness = new PiRpcHarness({ pi: () => FAKE_PI, extension: null });
        const manager = new AgentManager(home, harness, bus);
        // No turn ran yet: the fake, as pi, has nothing to compact.
        const handle = await manager.add(summary, { name: "lead" });
        const refusal = await handle.compact().then(
            () => null,
            (error: unknown) => error,
        );
        expect(refusal).toBeInstanceOf(PiRefusal);
        expect(String(refusal)).toMatch(/Nothing to compact/);
        // The refused compaction ended: the agent is not left "compacting".
        expect(manager.transcript(summary.dir, "lead", 0)?.compacting).toBe(false);
        expect(await handle.prompt("hello")).toBe("started");
        await until(() => settled === 1);
        await manager.stop_all();
    });
});
