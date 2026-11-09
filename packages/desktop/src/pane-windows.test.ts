// Goal: one window per (pane, session), a second pop-out focuses it, dock back closes it
// without the close callback, the close button reports once, a session close takes its
// windows, the previews pane among them. Method: a fake host records opens.
import { describe, expect, it } from "vitest";
import { pane_url, PaneWindows, type PaneWindowHost } from "./pane-windows.js";

interface FakeWindow {
    url: string;
    calls: string[];
    /** The user's close button. */
    close_button: () => void;
}

function fake_host(): PaneWindowHost & { windows: FakeWindow[] } {
    const windows: FakeWindow[] = [];
    return {
        windows,
        open(_popped, url, on_closed) {
            const window: FakeWindow = {
                url,
                calls: ["open"],
                close_button: () => {
                    window.calls.push("closed by user");
                    on_closed();
                },
            };
            windows.push(window);
            return {
                focus: () => window.calls.push("focus"),
                close: () => window.calls.push("close"),
            };
        },
    };
}

describe("PaneWindows", () => {
    it("opens one window per pane and session, and focuses it on a second pop-out", () => {
        const host = fake_host();
        const panes = new PaneWindows(host, "http://127.0.0.1:7777");
        const closed: string[] = [];
        expect(panes.pop_out("agents", "s1-a", () => closed.push("a"))).toBe(true);
        expect(panes.pop_out("agents", "s1-a", () => closed.push("a"))).toBe(true);
        expect(panes.pop_out("agents", "s2-b", () => closed.push("b"))).toBe(true);
        expect(host.windows.map((w) => w.url)).toEqual([
            "http://127.0.0.1:7777/?pane=agents&session=s1-a",
            "http://127.0.0.1:7777/?pane=agents&session=s2-b",
        ]);
        expect(host.windows[0]?.calls).toEqual(["open", "focus"]);
        expect(panes.list()).toEqual([
            { pane: "agents", session: "s1-a" },
            { pane: "agents", session: "s2-b" },
        ]);
        expect(closed).toEqual([]);
    });

    it("dock back closes without the callback; the close button reports once", () => {
        const host = fake_host();
        const panes = new PaneWindows(host, "http://127.0.0.1:7777");
        const closed: string[] = [];
        panes.pop_out("agents", "s1-a", () => closed.push("a"));
        panes.pop_out("sessions", "s1-a", () => closed.push("s"));
        expect(panes.dock_back("agents", "s1-a")).toBe(true);
        expect(panes.dock_back("agents", "s1-a")).toBe(false);
        expect(host.windows[0]?.calls).toEqual(["open", "close"]);
        host.windows[1]?.close_button();
        host.windows[1]?.close_button();
        expect(closed).toEqual(["s"]);
        expect(panes.list()).toEqual([]);
    });

    it("a session close takes its windows and no others", () => {
        const host = fake_host();
        const panes = new PaneWindows(host, "http://127.0.0.1:7777");
        panes.pop_out("agents", "s1-a", () => undefined);
        panes.pop_out("agents", "s2-b", () => undefined);
        expect(panes.close_session("s1-a")).toEqual([{ pane: "agents", session: "s1-a" }]);
        expect(panes.list()).toEqual([{ pane: "agents", session: "s2-b" }]);
        expect(panes.close_session("s1-a")).toEqual([]);
    });

    it("the previews pane is a page of its own: one window carries every tab", () => {
        const host = fake_host();
        const panes = new PaneWindows(host, "http://127.0.0.1:7777");
        expect(panes.pop_out("previews", "s1-a", () => undefined)).toBe(true);
        expect(host.windows.map((w) => w.url)).toEqual([
            "http://127.0.0.1:7777/?pane=previews&session=s1-a",
        ]);
    });
});

describe("pane_url", () => {
    it("adds the pane and session to the daemon URL", () => {
        expect(pane_url("http://127.0.0.1:7777", "agents", "s006-refunds")).toBe(
            "http://127.0.0.1:7777/?pane=agents&session=s006-refunds",
        );
    });
});
