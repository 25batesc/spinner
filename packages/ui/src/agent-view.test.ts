import { describe, expect, it } from "vitest";

import { showsTerminal } from "./agent-view.ts";

describe("showsTerminal", () => {
    it("shows the terminal for a tty agent and the chat for an rpc agent", () => {
        expect(showsTerminal("tty", "")).toBe(true);
        expect(showsTerminal("rpc", "")).toBe(false);
    });

    it("reads the pre-s009 harness name `pi` as tty: resume spawns the default harness", () => {
        expect(showsTerminal("pi", "?session=s1")).toBe(true);
    });

    it("forces the chat with ?chat=1", () => {
        expect(showsTerminal("tty", "?chat=1")).toBe(false);
        expect(showsTerminal("tty", "?pane=agents&chat=1")).toBe(false);
        expect(showsTerminal("tty", "?chat=0")).toBe(true);
    });
});
