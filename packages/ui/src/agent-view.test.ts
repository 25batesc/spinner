import type { AgentContext } from "@spinner/protocol";
import { describe, expect, it } from "vitest";

import { initialSessions } from "../fixture/data.ts";
import {
    contextLabel, contextTitle, contextTone, fullestContext, showsTerminal,
} from "./agent-view.ts";

function context(pct: number, window = 1_000_000): AgentContext {
    return { tokens: Math.floor((window * pct) / 100), window, pct };
}

describe("contextTone", () => {
    it("hides the figure while it is unknown or under 40 %", () => {
        expect(contextTone(undefined)).toBeNull();
        expect(contextTone(null)).toBeNull();
        expect(contextTone(context(0))).toBeNull();
        expect(contextTone(context(39))).toBeNull();
    });

    it("shows it plain from 40 %, amber from 50 %, red from 75 %", () => {
        expect(contextTone(context(40))).toBe("plain");
        expect(contextTone(context(49))).toBe("plain");
        expect(contextTone(context(50))).toBe("warn");
        expect(contextTone(context(74))).toBe("warn");
        expect(contextTone(context(75))).toBe("fail");
        // A switch to a smaller model can put the last prompt past the new window.
        expect(contextTone(context(130))).toBe("fail");
    });
});

describe("contextLabel and contextTitle", () => {
    it("print the percent, the window and the tokens", () => {
        const figure: AgentContext = { tokens: 523_000, window: 1_000_000, pct: 52 };
        expect(contextLabel(figure)).toBe("52 %");
        expect(contextTitle(figure)).toBe("52 % of 1M context (523k tokens)");
        const small: AgentContext = { tokens: 88_400, window: 200_000, pct: 44 };
        expect(contextTitle(small)).toBe("44 % of 200k context (88.4k tokens)");
    });
});

describe("fullestContext", () => {
    it("names the agent with the highest figure and skips the unknown ones", () => {
        const [, refund] = initialSessions();
        if (refund === undefined || refund.cost === undefined) {
            throw new Error("the fixture has the refund session with costs");
        }
        const agents = refund.cost.agents;
        const at = (pct: number | null) => {
            const figure = pct === null ? null : context(pct);
            return { ...agents["backend"]!, context: figure };
        };
        const view = (backend: number | null, frontend: number | null) => ({
            ...refund,
            cost: { ...refund.cost!, agents: { backend: at(backend), frontend: at(frontend) } },
        });
        expect(fullestContext(view(30, 61))).toEqual({ name: "frontend", context: context(61) });
        expect(fullestContext(view(61, null))).toEqual({ name: "backend", context: context(61) });
        expect(fullestContext(view(null, null))).toBeNull();
        const uncosted = { ...refund };
        delete uncosted.cost;
        expect(fullestContext(uncosted)).toBeNull();
    });
});

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
