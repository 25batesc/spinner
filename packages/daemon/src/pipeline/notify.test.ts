// Goal: every notification is a `notify` event with its session, and the `osascript` banner
// runs only while no desktop app is connected; `SPINNER_NOTIFY=off` stays silent. Method: the
// real `macos_notifier_with` over a fake exec that records the program and its arguments, a
// list that records the published events, and a desktop count the test sets.
import { describe, expect, it } from "vitest";
import type { NotifyEvent } from "@spinner/protocol";
import {
    applescript_string,
    event_notifier,
    macos_notifier_with,
    silent_notifier,
} from "./notify.js";

const NOW = new Date("2026-11-05T14:30:00.000Z");

function harness(fallback?: "silent") {
    const execs: { file: string; args: string[] }[] = [];
    const events: NotifyEvent[] = [];
    const state = { desktop: 0 };
    const banner = macos_notifier_with(async (file, args) => {
        execs.push({ file, args });
    });
    const notify = event_notifier({
        publish: (event) => events.push(event),
        desktop_clients: () => state.desktop,
        fallback: fallback === "silent" ? silent_notifier : banner,
        now: () => NOW,
    });
    return { execs, events, state, notify };
}

describe("event_notifier", () => {
    it("publishes the event and runs osascript when no desktop app is connected", async () => {
        const { execs, events, notify } = harness();
        await notify("Spinner", 's7 "pay": verifying → merged', "s007-pay");
        expect(events).toEqual([
            {
                type: "notify",
                ts: NOW.toISOString(),
                session: "s007-pay",
                title: "Spinner",
                message: 's7 "pay": verifying → merged',
            },
        ]);
        expect(execs).toEqual([
            {
                file: "osascript",
                args: [
                    "-e",
                    'display notification "s7 \\"pay\\": verifying → merged" ' +
                        'with title "Spinner"',
                ],
            },
        ]);
    });

    it("publishes the event only while a desktop app is connected", async () => {
        const { execs, events, state, notify } = harness();
        state.desktop = 1;
        await notify("Spinner", "s7: merged", "s007-pay");
        expect(events.map((event) => event.session)).toEqual(["s007-pay"]);
        expect(execs).toEqual([]);
        state.desktop = 0;
        await notify("Spinner", "s7: merged again", null);
        expect(events.map((event) => event.session)).toEqual(["s007-pay", null]);
        expect(execs).toHaveLength(1);
    });

    it("cuts the message at 200 characters in the event and the banner", async () => {
        const { execs, events, notify } = harness();
        await notify("Spinner", "x".repeat(300), "s1");
        expect(events[0]?.message).toHaveLength(200);
        expect(execs[0]?.args[1]).toContain(`"${"x".repeat(200)}"`);
    });

    it("stays silent, event included, when the fallback is silent_notifier", async () => {
        const { execs, events, state, notify } = harness("silent");
        state.desktop = 1;
        await notify("Spinner", "s7: merged", "s007-pay");
        expect(events).toEqual([]);
        expect(execs).toEqual([]);
    });

    it("refuses an empty title and an empty session directory", async () => {
        const { events, notify } = harness();
        await expect(notify("", "text", "s1")).rejects.toThrow(/title/);
        await expect(notify("Spinner", "text", "")).rejects.toThrow(/session/);
        expect(events).toEqual([]);
    });
});

describe("applescript_string", () => {
    it("escapes quotes and backslashes", () => {
        expect(applescript_string('a "b" \\c')).toBe('"a \\"b\\" \\\\c"');
    });
});
