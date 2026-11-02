// The operator tab's two lines: what the agent waits on, and the context bar's notice.
import type { OperatorView } from "@spinner/protocol";
import { expect, it } from "vitest";

import { operatorHidden, operatorNotice, operatorRunning, waitingLine } from "./operator.ts";

const view: OperatorView = {
    enabled: true,
    ready: true,
    process: "idle",
    pid: 4242,
    model: "fixture/default",
    dir: "/home/fixture/.spinner/operator",
    waiting_on: "operator",
    last_notice: { ts: "2026-10-30T22:20:00.000Z", text: "s17-refund-flow: backend settled" },
    notices_pending: 0,
};

it("names the last notice's newest line and the count still queued", () => {
    expect(waitingLine(view)).toBe("waiting on: s17-refund-flow: backend settled");
    const batch = { ...view.last_notice!, text: "2 dropped\ns1-a: x\ns2-b: agent exited\n" };
    expect(waitingLine({ ...view, last_notice: batch, notices_pending: 3 })).toBe(
        "waiting on: s2-b: agent exited · 3 pending",
    );
    expect(waitingLine({ ...view, last_notice: null })).toBe("waiting on: no notice yet");
    expect(waitingLine(null)).toBe("waiting on: no notice yet");
});

it("notices a stopped operator agent only", () => {
    expect(operatorRunning(view)).toBe(true);
    expect(operatorRunning({ ...view, process: "running" })).toBe(true);
    expect(operatorNotice(view)).toBeNull();
    const stopped = { ...view, process: "exited" as const, pid: null };
    expect(operatorRunning(stopped)).toBe(false);
    expect(operatorNotice(stopped)).toBe("operator agent not running");
    expect(operatorNotice(null)).toBeNull();
});

it("hides the operator when off and not running; a running one shows whatever the setting", () => {
    expect(operatorHidden(view)).toBe(false);
    expect(operatorHidden(null)).toBe(true);
    const off = { ...view, enabled: false };
    expect(operatorHidden(off)).toBe(false);
    const offAndExited = { ...off, process: "exited" as const, pid: null };
    expect(operatorHidden(offAndExited)).toBe(true);
    expect(operatorNotice(offAndExited)).toBeNull();
    const onAndExited = { ...view, process: "exited" as const, pid: null };
    expect(operatorHidden(onAndExited)).toBe(false);
});
